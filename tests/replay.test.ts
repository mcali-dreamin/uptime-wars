// The command log is the whole match: seed + setup + log replays it exactly.
// That's what makes recorded matches worth keeping (and leaderboards checkable).

import { describe, expect, it } from "vitest";
import { createWorld, hashWorld, queueCommand, simulate, step } from "../src/sim";
import { content, OPENING, SETUP } from "./fixtures";

describe("replay from the command log", () => {
  it("logs only the commands that took effect", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, { type: "build", tick: 0, team: 0, building: "server-rack", col: 0, row: 0 });
    for (const command of OPENING) queueCommand(world, command);
    while (world.tick < 400) step(world, content);
    expect(world.log.length).toBeGreaterThan(0);
    expect(world.log.some((c) => c.type === "build" && c.col === 0 && c.row === 0)).toBe(false);
  });

  it("seed + setup + log reproduces the match, tick for tick", () => {
    const world = createWorld(content, SETUP);
    for (const command of OPENING) queueCommand(world, command);
    world.teams[0]!.money += 2000;
    // Rejected commands along the way must not matter.
    queueCommand(world, { type: "research", tick: 5, team: 0, upgrade: "nonsense" });
    const ticks = 3000;
    while (world.tick < ticks && !world.outcome) step(world, content);

    const replay = createWorld(content, SETUP);
    replay.teams[0]!.money += 2000;
    for (const command of world.log) queueCommand(replay, command);
    while (replay.tick < world.tick) step(replay, content);
    expect(hashWorld(replay)).toBe(hashWorld(world));
  });

  it("simulate() replays a plain match from its log", () => {
    const world = createWorld(content, SETUP);
    for (const command of OPENING) queueCommand(world, command);
    while (world.tick < 2000) step(world, content);
    expect(hashWorld(simulate(content, SETUP, world.log, 2000))).toBe(hashWorld(world));
  });
});
