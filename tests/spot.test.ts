// Spot Capacity: rent compute for a while; it fades by attrition afterwards.
// Also: every finished core supplies its own compute.

import { describe, expect, it } from "vitest";
import { computeBalance, createWorld, hashWorld, queueCommand, simulate, spotCost, spotState, step, tierDef, validateContent, type Building, type Command, type World } from "../src/sim";
import { placeBuilding, spawnUnit } from "../src/sim/entities";
import { overloadOf } from "../src/sim/economy";
import { TILE } from "../src/sim";
import { content, SETUP } from "./fixtures";

const spot = content.economy.spot;
const team0 = (w: World) => w.teams[0]!;
const coreOf = (w: World) => w.entities.find((e): e is Building => e.id === team0(w).coreId)!;
const rejections = (w: World) => w.events.flatMap((e) => (e.type === "rejected" ? [e.reason] : []));
const rent = (w: World) => {
  queueCommand(w, { type: "rentCompute", tick: w.tick, team: 0 });
  step(w, content);
};

function fresh(): World {
  const world = createWorld(content, SETUP);
  world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
  team0(world).money = 100_000;
  return world;
}

describe("every core supplies compute", () => {
  it("two finished cores supply twice the core's compute, the tier once", () => {
    const world = fresh();
    const team = team0(world);
    const before = computeBalance(world, content, team).supply;
    const core = coreOf(world);
    const second = placeBuilding(world, content, 0, core.defId, Math.floor(core.x / TILE) + 14, Math.floor(core.y / TILE), false);
    second.buildRemaining = 0;
    expect(computeBalance(world, content, team).supply).toBe(before + content.buildings[core.defId]!.compute!);
    expect(tierDef(content, team).compute).toBeGreaterThanOrEqual(0);
  });

  it("an unfinished expansion adds nothing", () => {
    const world = fresh();
    const before = computeBalance(world, content, team0(world)).supply;
    const core = coreOf(world);
    const second = placeBuilding(world, content, 0, core.defId, Math.floor(core.x / TILE) + 14, Math.floor(core.y / TILE), false);
    second.buildRemaining = 100;
    expect(computeBalance(world, content, team0(world)).supply).toBe(before);
  });
});

describe("spot capacity", () => {
  it("charges the tier cost and raises supply by the tier amount", () => {
    const world = fresh();
    const base = computeBalance(world, content, team0(world)).supply;
    const money = team0(world).money;
    rent(world);
    expect(rejections(world)).toEqual([]);
    expect(team0(world).money).toBe(money - spot.cost[0]!);
    expect(computeBalance(world, content, team0(world)).supply).toBe(base + spot.compute[0]!);
    expect(spotState(world, team0(world))).toBe("active");
    expect(world.events.some((e) => e.type === "spotStarted")).toBe(true);
  });

  it("each rental costs more", () => {
    const world = fresh();
    const team = team0(world);
    expect(spotCost(content, team)).toBe(spot.cost[0]);
    team.spotRentals = 2;
    expect(spotCost(content, team)).toBe(Math.round((spot.cost[0]! * (1000 + 2 * spot.growthPermille)) / 1000));
  });

  it("rejects while active, while fading, and when broke", () => {
    const world = fresh();
    rent(world);
    rent(world);
    expect(rejections(world)).toEqual(["spot capacity already running"]);
    // Fading: past the timer, with an army that keeps some of it.
    const core = coreOf(world);
    for (let i = 0; i < 60; i += 1) spawnUnit(ctxOf(world), 0, armyUnit(), core, core.x, core.y + 60, "guard");
    world.tick = team0(world).spot!.untilTick;
    step(world, content);
    expect(spotState(world, team0(world))).toBe("fading");
    rent(world);
    expect(rejections(world)).toEqual(["spot capacity already running"]);

    const broke = fresh();
    team0(broke).money = spot.cost[0]! - 1;
    rent(broke);
    expect(rejections(broke)).toEqual(["not enough $"]);
  });

  it("ends at once at expiry when no army is above the base supply", () => {
    const world = fresh();
    rent(world);
    world.tick = team0(world).spot!.untilTick;
    step(world, content);
    expect(team0(world).spot).toBeNull();
    expect(world.events.some((e) => e.type === "spotEnded")).toBe(true);
  });

  it("fades by attrition: residual covers the army, nothing is removed, and it shrinks as units die", () => {
    const world = fresh();
    const team = team0(world);
    const core = coreOf(world);
    team.users = 0;
    const base = computeBalance(world, content, team).supply;
    rent(world);
    const unitId = armyUnit();
    const per = content.units[unitId]!.upkeep ?? content.economy.compute.perUnit;
    const count = Math.floor((base + 30) / per);
    for (let i = 0; i < count; i += 1) spawnUnit(ctxOf(world), 0, unitId, core, core.x, core.y + 60, "guard");
    const units = () => world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.defId === unitId);
    expect(units().length).toBe(count);
    expect(overloadOf(world, content, team)).toBe(0);
    world.tick = team.spot!.untilTick;
    step(world, content);
    expect(units().length).toBe(count);
    expect(spotState(world, team)).toBe("fading");
    expect(team.spot!.compute).toBeGreaterThan(0);
    expect(team.spot!.compute).toBeLessThan(spot.compute[0]!);
    expect(overloadOf(world, content, team)).toBe(0);
    let last = team.spot!.compute;
    while (team.spot) {
      units()[0]!.hp = 0;
      world.entities = world.entities.filter((e) => e.hp > 0);
      step(world, content);
      if (team.spot) expect(team.spot.compute).toBeLessThanOrEqual(last);
      last = team.spot?.compute ?? 0;
    }
    expect(spotState(world, team)).toBeNull();
    expect(world.events.some((e) => e.type === "spotEnded")).toBe(true);
  });

  it("users don't move onto rented compute, so a rental always fades out", () => {
    const world = fresh();
    const team = team0(world);
    team.users = 0;
    // An army eats all but a few of the team's own compute, so users would
    // run out of owned compute well before the user cap.
    const core = coreOf(world);
    const unitId = armyUnit();
    const per = content.units[unitId]!.upkeep ?? content.economy.compute.perUnit;
    const base = computeBalance(world, content, team).supply;
    const count = Math.floor((base - 5) / per);
    for (let i = 0; i < count; i += 1) spawnUnit(ctxOf(world), 0, unitId, core, core.x, core.y + 60, "guard");
    rent(world);
    for (let i = 0; i < 20 * 60 * 3; i += 1) {
      step(world, content);
      const { supply, demand } = computeBalance(world, content, team);
      expect(demand).toBeLessThanOrEqual(supply - (team.spot?.compute ?? 0));
    }
    expect(team.spot).toBeNull();
  });
});

describe("spot capacity content", () => {
  it("validates the spot block", () => {
    expect(() => validateContent(content)).not.toThrow();
    const broken = structuredClone(content);
    broken.economy.spot.cost = [1];
    expect(() => validateContent(broken)).toThrow(/economy.spot/);
    const zero = structuredClone(content);
    zero.economy.spot.ticks = 0;
    expect(() => validateContent(zero)).toThrow(/economy.spot.ticks/);
  });
});

describe("spot capacity determinism", () => {
  it("two runs issuing rentCompute hash the same", () => {
    const commands: Command[] = [
      { type: "rentCompute", tick: 10, team: 0 },
      { type: "rentCompute", tick: 50, team: 0 },
      { type: "rentCompute", tick: 2000, team: 0 },
    ];
    const run = () => {
      const w = simulate(content, SETUP, commands, 2200);
      return [hashWorld(w), w.teams[0]!.spotRentals] as const;
    };
    const a = run();
    expect(a).toEqual(run());
    expect(a[1]).toBeGreaterThanOrEqual(1);
  });
});

import { makeContext } from "../src/sim/context";
function ctxOf(world: World) {
  return makeContext(world, content);
}
function armyUnit(): string {
  const race = content.races[SETUP.races[0]!]!;
  const spawner = race.buildings.map((b) => content.buildings[b]!).find((b) => b.spawn)!;
  return spawner.spawn!.unit;
}
