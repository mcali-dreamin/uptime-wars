import { describe, expect, it } from "vitest";
import { createWorld, hashWorld, queueCommand, step, type Building, type World } from "../src/sim";
import { content, planBuildOrder } from "./fixtures";

const SETUP = { seed: 1234, races: ["serverless", "botnet"], startWithCore: true };
const fnDef = content.buildings.function!.invoke!;

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

describe("serverless", () => {
  it("a Function keeps no standing army: idle, it spins up nothing and costs nothing", () => {
    const { world, fn } = withFunction();
    const before = world.teams[0]!.money;
    for (let i = 0; i < 600; i++) step(world, content);
    expect(lambdas(world, fn)).toHaveLength(0);
    expect(world.teams[0]!.money).toBeGreaterThan(before);
  });

  it("invoking it costs compute and spins up its squad, which goes cold after its ttl", () => {
    const { world, fn } = withFunction();
    queueCommand(world, { type: "invoke", tick: world.tick, team: 0, buildingId: fn.id });
    const before = world.teams[0]!.money;
    step(world, content);
    expect(lambdas(world, fn)).toHaveLength(fnDef.count);
    expect(world.teams[0]!.money).toBeLessThanOrEqual(before - fnDef.cost + 3);
    for (let i = 0; i < fnDef.ttlTicks + 2; i++) step(world, content);
    expect(lambdas(world, fn)).toHaveLength(0);
  });

  it("it won't run again during its cooldown, or without $", () => {
    const { world, fn } = withFunction();
    queueCommand(world, { type: "invoke", tick: world.tick, team: 0, buildingId: fn.id });
    queueCommand(world, { type: "invoke", tick: world.tick + 1, team: 0, buildingId: fn.id });
    step(world, content);
    step(world, content);
    expect(world.events.some((e) => e.type === "rejected" && e.reason === "cooling down")).toBe(true);
    while (fn.spawnTimer > 0) step(world, content);
    world.teams[0]!.money = fnDef.cost - 1;
    queueCommand(world, { type: "invoke", tick: world.tick, team: 0, buildingId: fn.id });
    step(world, content);
    expect(world.events.some((e) => e.type === "rejected" && e.reason === "not enough $")).toBe(true);
  });

  it("a creep in range triggers it on its own", () => {
    const { world, fn } = withFunction();
    world.waves.nextWaveTick = world.tick;
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 1)) step(world, content);
    const creep = world.entities.find((e) => e.kind === "unit" && e.team === 1)!;
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
