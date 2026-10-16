// Composable match rules: starting sides, open or locked diplomacy, and
// whether the nest must fall. The old modes are just presets of these.

import { describe, expect, it } from "vitest";
import { createWorld, hashWorld, hostile, isWalkableTile, queueCommand, rulesLabel, simulate, step, type Building, type Command, type MatchSetup, type World } from "../src/sim";
import { placeBuilding, spawnUnit } from "../src/sim/entities";
import { makeContext } from "../src/sim/context";
import { terrainFor } from "../src/sim/walls";
import { content } from "./fixtures";

const FOUR = ["open-source", "hyperscaler", "serverless", "walled-garden"];
const make = (setup: Partial<MatchSetup>): World => {
  const world = createWorld(content, { seed: 1234, races: FOUR, startWithCore: true, ...setup });
  world.waves.nextWaveTick = 1e9;
  return world;
};
const run = (world: World, ticks: number) => {
  for (let i = 0; i < ticks && !world.outcome; i += 1) step(world, content);
};
const order = (world: World, command: { type: "ally" | "unally"; team: number; with: number }) => queueCommand(world, { ...command, tick: world.tick } as Command);
const down = (world: World, team: number) => {
  world.entities.find((e) => e.id === world.teams[team]!.coreId)!.hp = 0;
};
const OPEN = { sides: [0, 1, 2, 3], diplomacy: "open" as const, nestMustFall: false };

/** Team 1's hero stood at team 0's door for three seconds: how often team 0 shoots it. */
function shotsAtVisitor(world: World): number {
  const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
  const hero = world.entities.find((e) => e.id === world.teams[1]!.hero?.unitId)!;
  hero.x = core.x + 70;
  hero.y = core.y;
  let shots = 0;
  for (let i = 0; i < 60; i += 1) {
    step(world, content);
    hero.x = core.x + 70;
    hero.y = core.y;
    shots += world.events.filter((e) => e.type === "shot" && e.team === 0 && e.to === hero.id).length;
  }
  return shots;
}

describe("match rules", () => {
  it("the presets are rules: co-op is one side, FFA a side each", () => {
    const coop = createWorld(content, { seed: 1, races: [...FOUR, "botnet"], startWithCore: true });
    expect(coop.rules).toEqual({ sides: [0, 0, 0, 0], diplomacy: "locked", nestMustFall: true });
    expect(rulesLabel(coop)).toBe("coop");
    const ffa = make({ mode: "ffa" });
    expect(ffa.rules).toEqual({ sides: [0, 1, 2, 3], diplomacy: "locked", nestMustFall: false });
    expect(rulesLabel(ffa)).toBe("ffa");
    expect(rulesLabel(make({ rules: { sides: [0, 0, 1, 1] } }))).toBe("custom");
  });

  it("sides compose: 2v2 is allied in pairs and hostile across", () => {
    const world = make({ rules: { sides: [0, 0, 1, 1], nestMustFall: false } });
    expect(hostile(world, 0, 1)).toBe(false);
    expect(hostile(world, 2, 3)).toBe(false);
    expect(hostile(world, 0, 2)).toBe(true);
    expect(hostile(world, 1, 3)).toBe(true);
  });

  it("2v2: a side wins when the other is down, a fallen ally included", () => {
    const world = make({ rules: { sides: [0, 0, 1, 1], nestMustFall: false } });
    down(world, 1);
    down(world, 2);
    run(world, 2);
    expect(world.outcome).toBeNull();
    down(world, 3);
    run(world, 2);
    expect(world.outcome).toMatchObject({ winners: [0, 1], reason: "last-standing" });
  });

  it("an alliance forms only when both ask", () => {
    const world = make({ rules: OPEN });
    order(world, { type: "ally", team: 0, with: 1 });
    run(world, 1);
    expect(hostile(world, 0, 1)).toBe(true);
    expect(world.events.some((e) => e.type === "ally-offer")).toBe(true);
    order(world, { type: "ally", team: 1, with: 0 });
    run(world, 1);
    expect(hostile(world, 0, 1)).toBe(false);
    expect(hostile(world, 1, 0)).toBe(false);
    expect(hostile(world, 0, 2)).toBe(true);
  });

  it("allies hold fire; a broken alliance means war again, at once", () => {
    const world = make({ races: FOUR.slice(0, 2), rules: { ...OPEN, sides: [0, 1] } });
    expect(shotsAtVisitor(world)).toBeGreaterThan(0);
    order(world, { type: "ally", team: 0, with: 1 });
    order(world, { type: "ally", team: 1, with: 0 });
    run(world, 1);
    expect(shotsAtVisitor(world)).toBe(0);
    order(world, { type: "unally", team: 1, with: 0 });
    run(world, 1);
    expect(hostile(world, 0, 1)).toBe(true);
    expect(shotsAtVisitor(world)).toBeGreaterThan(0);
  });

  it("a unit mid-fight drops a new ally as its target", () => {
    const world = make({ races: FOUR.slice(0, 2), rules: { ...OPEN, sides: [0, 1] } });
    const hero = world.entities.find((e) => e.id === world.teams[1]!.hero?.unitId)!;
    const ctx = makeContext(world, content);
    const core = world.entities.find((e) => e.id === world.teams[1]!.coreId)!;
    const unit = spawnUnit(ctx, 0, "process", core, hero.x + 20, hero.y, "guard");
    unit.homeX = unit.x;
    unit.homeY = unit.y;
    // Both last the whole test, so only the alliance can stop the fight.
    unit.hp = unit.maxHp = hero.hp = hero.maxHp = 1e7;
    let fighting = 0;
    for (let i = 0; i < 40; i += 1) {
      run(world, 1);
      fighting += world.events.filter((e) => e.type === "shot" && e.from === unit.id).length;
    }
    expect(fighting).toBeGreaterThan(0);
    order(world, { type: "ally", team: 0, with: 1 });
    order(world, { type: "ally", team: 1, with: 0 });
    run(world, 1);
    let after = 0;
    for (let i = 0; i < 40; i += 1) {
      run(world, 1);
      after += world.events.filter((e) => e.type === "shot" && e.from === unit.id).length;
    }
    expect(unit.hp).toBeGreaterThan(0);
    expect(after).toBe(0);
  });

  it("locked diplomacy refuses alliances", () => {
    const world = make({ mode: "ffa" });
    order(world, { type: "ally", team: 0, with: 1 });
    order(world, { type: "ally", team: 1, with: 0 });
    run(world, 1);
    expect(hostile(world, 0, 1)).toBe(true);
    expect(world.log.some((c) => c.type === "ally")).toBe(false);
  });

  it("allies left standing win together; allying alone wins nothing", () => {
    const world = make({ rules: OPEN });
    order(world, { type: "ally", team: 0, with: 1 });
    order(world, { type: "ally", team: 1, with: 0 });
    run(world, 2);
    expect(world.outcome).toBeNull();
    down(world, 2);
    run(world, 2);
    expect(world.outcome).toBeNull();
    down(world, 3);
    run(world, 2);
    expect(world.outcome).toMatchObject({ winners: [0, 1], reason: "last-standing" });
  });

  it("with no horde and everyone allied, nothing is decided until someone turns", () => {
    const world = make({ races: FOUR.slice(0, 2), rules: { sides: [0, 0], diplomacy: "open", nestMustFall: false } });
    run(world, 5);
    expect(world.outcome).toBeNull();
  });

  it("when the nest must fall, beating the players isn't enough", () => {
    const world = make({ races: [...FOUR.slice(0, 2), "botnet"], rules: { sides: [0, 1], diplomacy: "locked", nestMustFall: true } });
    down(world, 1);
    run(world, 2);
    expect(world.outcome).toBeNull();
    down(world, 2);
    run(world, 2);
    expect(world.outcome).toMatchObject({ winners: [0], reason: "nest-offline" });
  });

  it("a gate opens for a new ally and shuts on a former one", () => {
    const world = make({ races: ["walled-garden", "open-source"], rules: { sides: [0, 1], diplomacy: "open", nestMustFall: false } });
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId) as Building;
    let at: { col: number; row: number } | null = null;
    for (let dc = 3; dc < 8 && !at; dc += 1) {
      if ([-1, 0, 1].every((o) => isWalkableTile(world.terrain, core.col + dc + o, core.row))) at = { col: core.col + dc, row: core.row };
    }
    const gate = placeBuilding(world, content, 0, "garden-gate", at!.col, at!.row, true);
    run(world, 1);
    const open = () => isWalkableTile(terrainFor(world, 1).terrain, gate.col, gate.row);
    expect(open()).toBe(false);
    order(world, { type: "ally", team: 0, with: 1 });
    order(world, { type: "ally", team: 1, with: 0 });
    run(world, 1);
    expect(open()).toBe(true);
    order(world, { type: "unally", team: 0, with: 1 });
    run(world, 1);
    expect(open()).toBe(false);
  });

  it("diplomacy replays exactly from the command log", () => {
    const setup: MatchSetup = { seed: 99, races: FOUR, startWithCore: true, rules: OPEN };
    const world = createWorld(content, setup);
    for (const [tick, team, other, type] of [
      [10, 0, 1, "ally"],
      [30, 1, 0, "ally"],
      [200, 0, 1, "unally"],
      [210, 2, 3, "ally"],
    ] as const) {
      queueCommand(world, { type, tick, team, with: other });
    }
    run(world, 400);
    const replay = simulate(content, setup, world.log, 400);
    expect(world.log.filter((c) => c.type === "ally" || c.type === "unally")).toHaveLength(4);
    expect(hashWorld(replay)).toBe(hashWorld(world));
  });
});
