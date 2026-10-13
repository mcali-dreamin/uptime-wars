// The opening: a visible minute, then the first incident comes in at your
// door and marches on your core.

import { describe, expect, it } from "vitest";
import { TICK_RATE, canFound, createWorld, queueCommand, step, type World } from "../src/sim";
import { content, OPENING, SETUP } from "./fixtures";

const SEEDS = [1, 7, 42, 99, 1234, 2026, 31337, 8];
const core = (w: World, team = 0) => w.entities.find((e) => e.id === w.teams[team]!.coreId)!;
const creeps = (w: World) => w.entities.filter((e) => e.kind === "unit" && e.team === w.teams.length - 1 && e.mode === "roam");

describe("the opening incident", () => {
  it("nothing hostile is out before the minute is up", () => {
    const world = createWorld(content, SETUP);
    while (world.tick < content.waves.firstIncidentTicks - 1) step(world, content);
    expect(creeps(world)).toEqual([]);
  });

  it("on every map it enters near your core, toward the nest, and reaches you within half a minute", () => {
    for (const seed of SEEDS) {
      const world = createWorld(content, { ...SETUP, seed });
      // Only the incident: background traffic leaves from the nest.
      world.waves.nextTrickleTick = 1e9;
      const c = core(world);
      while (world.waves.nextIndex < 1) step(world, content);
      const entries = world.events.find((e) => e.type === "wave")!;
      expect(entries.type === "wave" && entries.entries?.length, `seed ${seed}`).toBe(1);
      for (let i = 0; i < 20; i += 1) step(world, content);
      const near = creeps(world).map((u) => Math.hypot(u.x - c.x, u.y - c.y));
      expect(near.length, `seed ${seed}`).toBeGreaterThan(0);
      for (const d of near) expect(d, `seed ${seed}`).toBeLessThan(content.waves.opening!.entryDistance + 200);
      const start = world.tick;
      let reached = false;
      while (!reached && world.tick - start < 30 * TICK_RATE) {
        step(world, content);
        reached = creeps(world).some((u) => Math.hypot(u.x - c.x, u.y - c.y) < 300);
      }
      expect(reached, `seed ${seed}`).toBe(true);
    }
  });

  it("in co-op every player gets their own", () => {
    const world = createWorld(content, { seed: 4242, races: ["open-source", "hyperscaler", "botnet"], startWithCore: true });
    while (world.waves.nextIndex < 1) step(world, content);
    const wave = world.events.find((e) => e.type === "wave");
    expect(wave?.type === "wave" && wave.entries?.map((e) => e.team)).toEqual([0, 1]);
  });

  it("the clock starts when you deploy, not before", () => {
    const world = createWorld(content, { seed: 1234, races: ["open-source", "botnet"] });
    for (let i = 0; i < 400; i += 1) step(world, content);
    const start = world.terrain.starts[0]!;
    expect(canFound(world, content, 0, start.col, start.row)).toBeNull();
    queueCommand(world, { type: "found", tick: world.tick, team: 0, col: start.col, row: start.row });
    while (world.teams[0]!.coreId === -1) step(world, content);
    expect(world.waves.nextWaveTick - world.tick).toBeLessThanOrEqual(content.waves.firstIncidentTicks);
    expect(world.waves.nextWaveTick - world.tick).toBeGreaterThan(content.waves.firstIncidentTicks - 20);
  });

  it("a basic opening survives it", () => {
    const world = createWorld(content, SETUP);
    for (const command of OPENING) queueCommand(world, command);
    while (world.tick < content.waves.firstIncidentTicks + 90 * TICK_RATE && !world.outcome) step(world, content);
    expect(world.outcome).toBeNull();
    expect(core(world).hp).toBeGreaterThan(core(world).maxHp * 0.5);
  });
});
