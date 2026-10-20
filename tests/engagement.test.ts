// Engagement in the match report: when did the player stop playing?
// Bucketed per game minute, so a 46-minute match still fits the report.

import { describe, expect, it } from "vitest";
import { buildReport, engagement, IDLE_SECONDS } from "../src/game/telemetry";
import { createWorld, queueCommand, step, type World } from "../src/sim";
import { content, OPENING, SETUP } from "./fixtures";

/** A world at `seconds` whose log holds the given commands (only tick and team matter here). */
function at(seconds: number, log: { tick: number; team: number }[] = []): World {
  const world = createWorld(content, SETUP);
  world.tick = seconds * 20;
  world.log = log.map((c) => ({ type: "move", x: 0, y: 0, ...c }));
  return world;
}

describe("engagement", () => {
  it("counts presence per minute and finds the stretches without input", () => {
    // Busy for the first minute, away for two, back briefly, then gone for good.
    const inputs = [...Array.from({ length: 60 }, (_, i) => i), 180, 181];
    const e = engagement(at(300), 0, inputs);
    expect(e.activeSecondsPerMinute).toEqual([60, 0, 0, 2, 0, 0]);
    expect(e.lastInput).toBe(181);
    expect(e.idleAtEnd).toBe(119);
    expect(e.longestIdle).toBe(121); // 59 -> 180
    expect(e.idleSpells).toBe(2); // that gap and the tail
  });

  it("counts only this player's commands, per minute", () => {
    const log = [
      { tick: 20 * 10, team: 0 },
      { tick: 20 * 70, team: 0 },
      { tick: 20 * 71, team: 0 },
      { tick: 20 * 72, team: 1 },
    ];
    expect(engagement(at(150, log), 0, []).commandsPerMinute).toEqual([1, 2, 0]);
  });

  it("no input at all is one long idle", () => {
    const e = engagement(at(200), 0, []);
    expect(e).toMatchObject({ lastInput: -1, longestIdle: 200, idleAtEnd: 200, idleSpells: 1 });
  });

  it("without input seconds (an old report), commands stand in for presence", () => {
    const e = engagement(at(200, [{ tick: 20 * 30, team: 0 }, { tick: 20 * 30 + 5, team: 0 }]), 0);
    expect(e.activeSecondsPerMinute).toEqual([1, 0, 0, 0]);
    expect(e).toMatchObject({ lastInput: 30, idleAtEnd: 170 });
    expect(IDLE_SECONDS).toBe(60);
  });

  it("rides along in the report's summary and stays small for a long match", () => {
    const world = createWorld(content, SETUP);
    for (const command of OPENING) queueCommand(world, command);
    while (world.tick < 1200) step(world, content);
    const report = buildReport(content, world, 0, "4f6c1d2e-9a7b-4c3d-8e1f-0a2b3c4d5e6f", "1.2.3", false, [0, 1, 2]);
    expect(report.summary.engagement.activeSecondsPerMinute).toEqual([3, 0]);
    // An hour of play, active every second.
    const hour = engagement(at(3600), 0, Array.from({ length: 3600 }, (_, i) => i));
    expect(JSON.stringify(hour).length).toBeLessThan(800);
  });
});
