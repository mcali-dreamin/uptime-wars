import { describe, expect, it } from "vitest";
import {
  computeBalance,
  createWorld,
  queueCommand,
  incomeRate,
  trafficRadius,
  levelOf,
  multiplier,
  nextLevel,
  userCapacity,
  step,
} from "../src/sim";
import { makeContext } from "../src/sim/context";
import { dealDamage } from "../src/sim/combat";
import { content, SETUP, firstSpot, planBuildOrder } from "./fixtures";

describe("users", () => {
  const BUILDER_SETUP = { seed: 1234, races: ["open-source", "botnet"] as [string, string] };
  const econ = content.economy;
  const coreCap = content.buildings.core!.userCapacity!;

  it("there are no users before the core is online", () => {
    const world = createWorld(content, BUILDER_SETUP);
    for (let i = 0; i < 200; i++) step(world, content);
    expect(world.teams[0]!.users).toBe(0);
  });

  it("users grow toward capacity and never past it", () => {
    const world = createWorld(content, SETUP);
    // Nobody attacking: hits drive users away, which isn't what this is about.
    world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
    expect(world.teams[0]!.users).toBe(econ.startingUsers);
    let last = world.teams[0]!.users;
    for (let s = 0; s < 120; s++) {
      for (let i = 0; i < 20; i++) step(world, content);
      expect(world.teams[0]!.users).toBeGreaterThanOrEqual(last);
      expect(world.teams[0]!.users).toBeLessThanOrEqual(coreCap);
      last = world.teams[0]!.users;
    }
    expect(world.teams[0]!.users).toBe(coreCap);
  });

  it("users pay revenue on top of base income", () => {
    const withUsers = createWorld(content, SETUP);
    const without = createWorld(content, SETUP);
    without.teams[0]!.users = 0;
    const freeze: typeof content = structuredClone(content);
    freeze.economy = { ...econ, growthPerSecond: 0, minArrivalsPerSecond: 0 };
    for (let i = 0; i < 400; i++) {
      step(withUsers, freeze);
      step(without, freeze);
    }
    // 20 seconds of econ.startingUsers users.
    const expected = Math.floor(20 * econ.startingUsers * econ.revenuePerUserPerSecond);
    expect(withUsers.teams[0]!.money - without.teams[0]!.money).toBe(expected);
  });

  it("a Web App raises capacity", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.money = 1000;
    world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
    // Room for the users needs compute to serve them: a Web App and a generator.
    for (const command of planBuildOrder(content, SETUP, [[0, "web-app"], [0, "solar-array"]])) queueCommand(world, command);
    for (let i = 0; i < 20 * 150; i++) step(world, content);
    expect(world.teams[0]!.users).toBe(coreCap + content.buildings["web-app"]!.userCapacity!);
  });

  it("damage to your buildings drives users away", () => {
    // No growth, so any change is churn.
    const frozen: typeof content = structuredClone(content);
    frozen.economy = { ...econ, growthPerSecond: 0, minArrivalsPerSecond: 0 };
    const world = createWorld(frozen, SETUP);
    world.teams[0]!.users = 40;
    // Let the first wave out, then put one creep right next to the core.
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 1 && e.mode === "roam")) step(world, frozen);
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    const creep = world.entities.find((e) => e.kind === "unit" && e.team === 1 && e.mode === "roam")!;
    // Keep the hero out of it: creeps fight a defender in their face before buildings.
    const hero = world.entities.find((e) => e.kind === "unit" && e.team === 0 && e.mode === "hero");
    if (hero?.kind === "unit") {
      hero.x = hero.homeX = core.x + 3000;
      hero.y = hero.homeY = core.y;
    }
    creep.x = core.x + core.radius + creep.radius + 4;
    creep.y = core.y;
    const hpBefore = core.hp;
    for (let i = 0; i < 200; i++) step(world, frozen);
    const damage = hpBefore - core.hp;
    expect(damage).toBeGreaterThan(0);
    expect(40 - world.teams[0]!.users).toBe(Math.floor(damage / econ.damagePerUserLost));
  });
});

describe("users are the $", () => {


  it("incomeRate matches what actually lands, and splits it by source", () => {
    const frozen: typeof content = structuredClone(content);
    frozen.economy = { ...content.economy, growthPerSecond: 0, minArrivalsPerSecond: 0 };
    const world = createWorld(frozen, SETUP);
    world.teams[0]!.users = 30;
    const rate = incomeRate(world, frozen, world.teams[0]!);
    expect(rate.users).toBeCloseTo(30 * frozen.economy.revenuePerUserPerSecond);
    expect(rate.buildings).toBe(0);
    const before = world.teams[0]!.money;
    for (let i = 0; i < 20 * 20; i++) step(world, frozen);
    const total = rate.base + rate.buildings + rate.users;
    expect(world.teams[0]!.money - before).toBeGreaterThanOrEqual(Math.floor(total * 20) - 1);
    expect(world.teams[0]!.money - before).toBeLessThanOrEqual(Math.ceil(total * 20) + 1);
  });

  it("an offline team earns nothing from users", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.users = 30;
    world.teams[0]!.downTick = 1;
    expect(incomeRate(world, content, world.teams[0]!).users).toBe(0);
  });
});

describe("compute", () => {
  const per = content.economy.compute;

  it("buildings supply it; users and units use it", () => {
    const world = createWorld(content, SETUP);
    const team = world.teams[0]!;
    team.users = 30;
    const { supply, demand } = computeBalance(world, content, team);
    expect(supply).toBe(content.buildings.core!.compute);
    const units = world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.mode !== "builder").length;
    expect(demand).toBe(30 * per.perUser + units * per.perUnit);
  });

  it("within capacity, nothing is wrong", () => {
    const world = createWorld(content, SETUP);
    for (let i = 0; i < 20 * 30; i++) step(world, content);
    expect(world.teams[0]!.overload).toBe(0);
  });

  it("over capacity, users stop arriving and leave, the further over the faster", () => {
    const supply = content.buildings.core!.compute!;
    // Raise user capacity so only compute is the limit.
    const slight = structuredClone(content);
    slight.buildings.core!.userCapacity = 1000;
    const run = (users: number) => {
      const w = createWorld(slight, SETUP);
      w.waves.nextWaveTick = 1e9;
      w.teams[0]!.users = users;
      for (let i = 0; i < 20 * 10 + 1; i++) step(w, slight);
      return { lost: users - w.teams[0]!.users, overload: w.teams[0]!.overload };
    };
    const little = run(supply + 20);
    const lots = run(supply * 3);
    expect(little.overload).toBeGreaterThan(0);
    expect(lots.overload).toBeGreaterThan(little.overload);
    expect(little.lost).toBeGreaterThan(0);
    expect(lots.lost).toBeGreaterThan(little.lost);
  });

  it("overload slows timers by the same share", () => {
    const spawned = (overload: number) => {
      const world = createWorld(content, SETUP);
      world.waves.nextWaveTick = 1e9;
      queueCommand(world, planBuildOrder(content, SETUP, [[0, "server-rack"]])[0]!);
      let count = 0;
      const seen = new Set<number>();
      for (let i = 0; i < 20 * 60; i++) {
        world.teams[0]!.overload = overload;
        step(world, content);
        // Only the player's rack (the botnet's farms spawn too).
        for (const e of world.entities) if (e.kind === "unit" && e.team === 0 && e.spawnerId >= 0 && !seen.has(e.id)) (seen.add(e.id), (count += 1));
        // Keep the rack's units from capping it.
        for (const e of world.entities) if (e.kind === "unit" && e.team === 0 && e.spawnerId >= 0) e.hp = 0;
      }
      return count;
    };
    const full = spawned(0);
    const half = spawned(500);
    expect(half).toBeLessThan(full * 0.65);
    expect(half).toBeGreaterThan(full * 0.35);
  });
});

describe("churn", () => {
  it("only damage to buildings that serve users drives them away", () => {
    const frozen: typeof content = structuredClone(content);
    frozen.economy = { ...content.economy, growthPerSecond: 0, minArrivalsPerSecond: 0 };
    const world = createWorld(frozen, SETUP);
    world.teams[0]!.users = 40;
    queueCommand(world, firstSpot("firewall"));
    while (!world.entities.some((e) => e.defId === "firewall" && e.kind === "building" && e.buildRemaining === 0)) step(world, frozen);
    const ctx = makeContext(world, frozen);
    const wall = world.entities.find((e) => e.defId === "firewall")!;
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    const creep = { ...core, id: -9, team: 1 } as typeof core;
    dealDamage(ctx, creep, wall, 120);
    expect(world.teams[0]!.users).toBe(40);
    dealDamage(ctx, creep, core, 240);
    expect(world.teams[0]!.users).toBeLessThan(40);
  });

  it("a bigger base is sensed from further away", () => {
    const world = createWorld(content, SETUP);
    const team = world.teams[0]!;
    const small = trafficRadius(world, content, team);
    team.users += 200;
    expect(trafficRadius(world, content, team)).toBeGreaterThan(small);
  });
});

describe("upgrades", () => {
  const research = (world: ReturnType<typeof createWorld>, upgrade: string) => {
    queueCommand(world, { type: "research", tick: world.tick, team: 0, upgrade });
    step(world, content);
    return world.events.flatMap((e) => (e.type === "rejected" ? [e.reason] : []));
  };

  it("research costs compute, takes time, then raises the level", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.money = 1000;
    const def = content.upgrades["tower-damage"]!;
    expect(research(world, "tower-damage")).toEqual([]);
    expect(world.teams[0]!.research).toMatchObject({ upgrade: "tower-damage" });
    expect(levelOf(world.teams[0]!, "tower-damage")).toBe(0);
    let done = false;
    for (let i = 0; i < def.researchTicks + 5 && !done; i++) {
      step(world, content);
      done = world.events.some((e) => e.type === "researched");
    }
    expect(done).toBe(true);
    expect(levelOf(world.teams[0]!, "tower-damage")).toBe(1);
    expect(world.teams[0]!.research).toBeNull();
    expect(multiplier(content, world.teams[0]!, "towerDamage")).toBeCloseTo(1 + def.perLevel);
  });

  it("level n costs cost * n", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.upgrades["anycast"] = 1;
    expect(nextLevel(content, world.teams[0]!, "anycast")).toMatchObject({ level: 2, cost: content.upgrades.anycast!.cost * 2 });
  });

  it("a queue of five at the core, no buying past max, and it must be affordable", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.money = 100_000;
    const core = ["anycast", "edge-caching", "premium-tier", "tower-damage", "building-hp"];
    for (const upgrade of core) expect(research(world, upgrade)).toEqual([]);
    expect(world.teams[0]!.researchQueue).toHaveLength(4);
    expect(research(world, "building-armor")).toEqual(["queue full"]);
    world.teams[0]!.upgrades["anycast"] = content.upgrades.anycast!.maxLevel;
    world.teams[0]!.research = null;
    world.teams[0]!.researchQueue = [];
    expect(research(world, "anycast")).toEqual(["fully researched"]);
    world.teams[0]!.money = 0;
    expect(research(world, "building-armor")).toEqual(["not enough $"]);
  });

  it("upgrades change unit HP, spawn speed, and user capacity", () => {
    const world = createWorld(content, SETUP);
    const team = world.teams[0]!;
    const capBefore = userCapacity(world, content, team);
    team.upgrades = { "hardened-containers": 2, "autoscaling": 1, "edge-caching": 1 };
    queueCommand(world, firstSpot("server-rack"));
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard")) step(world, content);
    const unit = world.entities.find((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard")!;
    const base = content.units.process!.hp * content.races["open-source"]!.modifiers.unitHpMultiplier;
    expect(unit.maxHp).toBe(Math.round(base * (1 + 2 * content.upgrades["hardened-containers"]!.perLevel)));
    expect(userCapacity(world, content, team)).toBe(Math.floor(capBefore * (1 + content.upgrades["edge-caching"]!.perLevel)));
    // The rack just spawned, so its timer was reset to the upgraded interval.
    const rack = world.entities.find((e) => e.kind === "building" && e.defId === "server-rack")!;
    const raceMul = content.races["open-source"]!.modifiers.spawnIntervalMultiplier;
    const speed = 1 + content.upgrades.autoscaling!.perLevel;
    const expected = Math.round((content.buildings["server-rack"]!.spawn!.intervalTicks * raceMul) / speed);
    expect(rack.kind === "building" && rack.spawnTimer).toBe(expected);
  });
});
