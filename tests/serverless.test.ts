import { describe, expect, it } from "vitest";
import { computeBalance, createWorld, hashWorld, queueCommand, step, type Building, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { content, planBuildOrder } from "./fixtures";

const SETUP = { seed: 1234, races: ["serverless", "botnet"], startWithCore: true };
const fnDef = content.buildings.function!.invoke!;
const squad = content.buildings.function!.spawn!;

/** A finished Function next to the core. */
function withFunction(): { world: World; fn: Building } {
  const world = createWorld(content, SETUP);
  world.waves.nextWaveTick = 1e9;
  world.teams[0]!.money = 1000;
  queueCommand(world, planBuildOrder(content, SETUP, [[0, "function"]])[0]!);
  let fn: Building | undefined;
  while (!fn || fn.buildRemaining > 0) {
    if (world.tick > 2000) throw new Error(`the Function never finished: ${JSON.stringify(world.events.filter((e) => e.type === "rejected"))}`);
    step(world, content);
    fn = world.entities.find((e): e is Building => e.kind === "building" && e.defId === "function");
  }
  return { world, fn };
}

const lambdas = (world: World, fn: Building) => world.entities.filter((e) => e.kind === "unit" && e.spawnerId === fn.id);
const burst = (world: World, fn: Building) => lambdas(world, fn).filter((e) => e.kind === "unit" && e.expiresAt !== undefined);
const standing = (world: World, fn: Building) => lambdas(world, fn).filter((e) => e.kind === "unit" && e.expiresAt === undefined);

describe("serverless", () => {
  it("a Function keeps a standing squad warm, for free, up to its size", () => {
    const { world, fn } = withFunction();
    const before = world.teams[0]!.money;
    for (let i = 0; i < squad.intervalTicks * (squad.maxAlive + 2); i++) step(world, content);
    expect(standing(world, fn)).toHaveLength(squad.maxAlive);
    expect(burst(world, fn)).toHaveLength(0);
    expect(world.teams[0]!.money).toBeGreaterThan(before);
  });

  it("scaling it up costs $ and bursts extra units on top of the squad, which scale back down after their ttl", () => {
    const { world, fn } = withFunction();
    for (let i = 0; i < squad.intervalTicks * (squad.maxAlive + 2); i++) step(world, content);
    queueCommand(world, { type: "invoke", tick: world.tick, team: 0, buildingId: fn.id });
    const before = world.teams[0]!.money;
    step(world, content);
    expect(burst(world, fn)).toHaveLength(fnDef.count);
    expect(standing(world, fn)).toHaveLength(squad.maxAlive);
    expect(world.teams[0]!.money).toBeLessThanOrEqual(before - fnDef.cost + 3);
    for (let i = 0; i < fnDef.ttlTicks + 2; i++) step(world, content);
    expect(burst(world, fn)).toHaveLength(0);
    expect(standing(world, fn)).toHaveLength(squad.maxAlive);
  });

  it("a burst only spins up what free compute has room for, and costs that share: compute caps bursts too", () => {
    const { world, fn } = withFunction();
    const team = world.teams[0]!;
    team.money = 1000;
    const upkeep = content.units[fnDef.unit]!.upkeep ?? content.economy.compute.perUnit;
    // Leave room for exactly two burst units: users soak up the rest.
    const { supply, demand } = computeBalance(world, content, team);
    team.users += (supply - demand - 2 * upkeep) / content.economy.compute.perUser;
    queueCommand(world, { type: "invoke", tick: world.tick, team: 0, buildingId: fn.id });
    const before = team.money;
    step(world, content);
    expect(burst(world, fn)).toHaveLength(2);
    expect(before - team.money).toBeLessThan(fnDef.cost);
    const after = computeBalance(world, content, team);
    expect(after.demand).toBeLessThanOrEqual(after.supply);
  });

  it("with no compute free, a Function won't burst at all: at army cap", () => {
    const { world, fn } = withFunction();
    const team = world.teams[0]!;
    const { supply, demand } = computeBalance(world, content, team);
    team.users += (supply - demand) / content.economy.compute.perUser;
    queueCommand(world, { type: "invoke", tick: world.tick, team: 0, buildingId: fn.id });
    step(world, content);
    expect(burst(world, fn)).toHaveLength(0);
    expect(world.events.some((e) => e.type === "rejected" && e.reason === "at army cap")).toBe(true);
  });

  it("it won't run again during its cooldown, or without $", () => {
    const { world, fn } = withFunction();
    queueCommand(world, { type: "invoke", tick: world.tick, team: 0, buildingId: fn.id });
    queueCommand(world, { type: "invoke", tick: world.tick + 1, team: 0, buildingId: fn.id });
    step(world, content);
    step(world, content);
    expect(world.events.some((e) => e.type === "rejected" && e.reason === "cooling down")).toBe(true);
    while ((fn.scaleTimer ?? 0) > 0) step(world, content);
    world.teams[0]!.money = fnDef.cost - 1;
    queueCommand(world, { type: "invoke", tick: world.tick, team: 0, buildingId: fn.id });
    step(world, content);
    expect(world.events.some((e) => e.type === "rejected" && e.reason === "not enough $")).toBe(true);
  });

  it("with its squad up, one creep doesn't trigger a burst; a pack that outnumbers it does", () => {
    const { world, fn } = withFunction();
    for (let i = 0; i < squad.intervalTicks * (squad.maxAlive + 2); i++) step(world, content);
    const ctx = makeContext(world, content);
    const near = (n: number) => {
      for (let i = 0; i < n; i++) {
        const bot = spawnUnit(ctx, 1, "bot", fn, fn.x + 150, fn.y + i * 10, "roam");
        bot.attackCooldown = 1e6;
      }
    };
    const bursts = () => world.events.filter((e) => e.type === "invoked" && e.auto).length;
    near(1);
    let seen = 0;
    for (let i = 0; i < 5; i++) {
      step(world, content);
      seen += bursts();
    }
    expect(seen).toBe(0);
    near(squad.maxAlive + 1);
    for (let i = 0; i < 5 && seen === 0; i++) {
      step(world, content);
      seen += bursts();
    }
    expect(seen).toBe(1);
  });

  it("a creep in range triggers it on its own", () => {
    const { world, fn } = withFunction();
    // A later incident (from the nest): the opening one would land on the Function first.
    world.waves.nextIndex = 1;
    world.waves.nextWaveTick = world.tick;
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 1 && e.mode === "roam")) step(world, content);
    const creep = world.entities.find((e) => e.kind === "unit" && e.team === 1 && e.mode === "roam")!;
    creep.x = fn.x + 150;
    creep.y = fn.y;
    let auto = false;
    for (let i = 0; i < 5 && !auto; i++) {
      step(world, content);
      auto = world.events.some((e) => e.type === "invoked" && e.auto);
    }
    expect(auto).toBe(true);
  });

  it("is deterministic", () => {
    const run = () => {
      const { world, fn } = withFunction();
      world.waves.nextWaveTick = world.tick + 10;
      queueCommand(world, { type: "invoke", tick: world.tick + 5, team: 0, buildingId: fn.id });
      for (let i = 0; i < 3000; i++) step(world, content);
      return hashWorld(world);
    };
    expect(run()).toBe(run());
  });
});
