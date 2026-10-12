import { describe, expect, it } from "vitest";
import { createWorld, hashWorld, hostile, step, type World } from "../src/sim";
import { content } from "./fixtures";

const RACES = ["open-source", "hyperscaler", "botnet"];
const setup = (mode: "coop" | "ffa", races = RACES) => ({ seed: 1234, races, startWithCore: true, mode });
const run = (world: World, ticks: number) => {
  for (let i = 0; i < ticks && !world.outcome; i += 1) step(world, content);
};
const coreOf = (world: World, team: number) => world.entities.find((e) => e.id === world.teams[team]!.coreId)!;
const heroOf = (world: World, team: number) => world.entities.find((e) => e.id === world.teams[team]!.hero?.unitId)!;

/** Walk team 1's hero up to team 0's core and let a few seconds pass. Returns team 0's shots at it. */
function heroAtTheGate(mode: "coop" | "ffa"): number {
  const world = createWorld(content, setup(mode));
  const core = coreOf(world, 0);
  const hero = heroOf(world, 1);
  hero.x = core.x + 70;
  hero.y = core.y;
  let shots = 0;
  for (let i = 0; i < 60; i += 1) {
    step(world, content);
    shots += world.events.filter((e) => e.type === "shot" && e.team === 0 && e.to === hero.id).length;
  }
  return shots;
}

describe("free-for-all", () => {
  it("every team is an enemy; in co-op only the horde is", () => {
    const ffa = createWorld(content, setup("ffa"));
    const coop = createWorld(content, setup("coop"));
    expect(hostile(ffa, 0, 1)).toBe(true);
    expect(hostile(ffa, 0, 2)).toBe(true);
    expect(hostile(ffa, 0, 0)).toBe(false);
    expect(hostile(coop, 0, 1)).toBe(false);
    expect(hostile(coop, 0, 2)).toBe(true);
  });

  it("your defences shoot another player in FFA, and leave an ally alone in co-op", () => {
    expect(heroAtTheGate("ffa")).toBeGreaterThan(0);
    expect(heroAtTheGate("coop")).toBe(0);
  });

  it("last core standing wins", () => {
    const world = createWorld(content, setup("ffa"));
    run(world, 5);
    expect(world.outcome).toBeNull();
    coreOf(world, 1).hp = 0;
    run(world, 2);
    expect(world.outcome).toMatchObject({ winners: [0], reason: "last-standing" });
  });

  it("in co-op, one player going down doesn't end the match", () => {
    const world = createWorld(content, setup("coop"));
    coreOf(world, 1).hp = 0;
    run(world, 2);
    expect(world.teams[1]!.downTick).not.toBeNull();
    expect(world.outcome).toBeNull();
  });

  it("taking the nest down in FFA removes an enemy; it doesn't end the match", () => {
    const world = createWorld(content, setup("ffa"));
    coreOf(world, 2).hp = 0;
    run(world, 2);
    expect(world.teams[2]!.downTick).not.toBeNull();
    expect(world.outcome).toBeNull();
  });

  it("FFA can be played without the horde: no waves ever come", () => {
    const world = createWorld(content, setup("ffa", ["open-source", "hyperscaler"]));
    run(world, content.waves.graceTicks + 200);
    expect(world.entities.some((e) => e.kind === "unit" && e.mode === "roam")).toBe(false);
    expect(world.waves.nextIndex).toBe(0);
  });

  it("FFA needs two players; co-op needs the horde", () => {
    expect(() => createWorld(content, setup("ffa", ["open-source", "botnet"]))).toThrow(/at least 2/);
    expect(() => createWorld(content, setup("coop", ["open-source", "hyperscaler"]))).toThrow(/horde/);
  });

  it("is deterministic, and the mode is part of the state", () => {
    const a = createWorld(content, setup("ffa"));
    const b = createWorld(content, setup("ffa"));
    const c = createWorld(content, setup("coop"));
    run(a, 400);
    run(b, 400);
    run(c, 400);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(hashWorld(a)).not.toBe(hashWorld(c));
  });
});
