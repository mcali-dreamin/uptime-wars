import { describe, expect, it } from "vitest";
import {
  createWorld,
  queueCommand,
  incomeRate,
  levelOf,
  multiplier,
  nextLevel,
  userCapacity,
  step,
} from "../src/sim";
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
    expect(withUsers.teams[0]!.compute - without.teams[0]!.compute).toBe(expected);
  });

  it("a Web App raises capacity", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.compute = 1000;
    queueCommand(world, planBuildOrder(content, SETUP, [[0, "web-app"]])[0]!);
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
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 1)) step(world, frozen);
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    const creep = world.entities.find((e) => e.kind === "unit" && e.team === 1)!;
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

describe("users are the economy", () => {
  /** Place each building as soon as it's affordable; return compute earned (banked + spent) after `seconds`. */
  function earned(list: string[], seconds: number): number {
    const world = createWorld(content, SETUP);
    const spots = planBuildOrder(content, SETUP, list.map((b) => [0, b] as [number, string]));
    const start = world.teams[0]!.compute;
    let next = 0;
    let spent = 0;
    while (world.tick < seconds * 20) {
      const cost = next < spots.length ? content.buildings[spots[next]!.building]!.cost : Infinity;
      if (world.teams[0]!.compute >= cost) {
        queueCommand(world, { ...spots[next]!, tick: world.tick });
        spent += cost;
        next += 1;
      }
      step(world, content);
    }
    return world.teams[0]!.compute + spent - start;
  }

  it("a base that grows users out-earns one that builds generators", () => {
    // Same defence, then the same number of economy buildings: Web Apps or Solar Arrays.
    const opening = ["server-rack", "server-rack", "firewall"];
    const users = earned([...opening, "web-app", "web-app", "web-app"], 300);
    const generators = earned([...opening, "solar-array", "solar-array", "solar-array"], 300);
    expect(users).toBeGreaterThan(generators * 1.4);
  });

  it("incomeRate matches what actually lands, and splits it by source", () => {
    const frozen: typeof content = structuredClone(content);
    frozen.economy = { ...content.economy, growthPerSecond: 0, minArrivalsPerSecond: 0 };
    const world = createWorld(frozen, SETUP);
    world.teams[0]!.users = 30;
    const rate = incomeRate(world, frozen, world.teams[0]!);
    expect(rate.users).toBeCloseTo(30 * frozen.economy.revenuePerUserPerSecond);
    expect(rate.buildings).toBe(0);
    const before = world.teams[0]!.compute;
    for (let i = 0; i < 20 * 20; i++) step(world, frozen);
    const total = rate.base + rate.buildings + rate.users;
    expect(world.teams[0]!.compute - before).toBeGreaterThanOrEqual(Math.floor(total * 20) - 1);
    expect(world.teams[0]!.compute - before).toBeLessThanOrEqual(Math.ceil(total * 20) + 1);
  });

  it("an offline team earns nothing from users", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.users = 30;
    world.teams[0]!.downTick = 1;
    expect(incomeRate(world, content, world.teams[0]!).users).toBe(0);
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
    world.teams[0]!.compute = 1000;
    const def = content.upgrades["exploit-kits"]!;
    expect(research(world, "exploit-kits")).toEqual([]);
    expect(world.teams[0]!.research).toMatchObject({ upgrade: "exploit-kits" });
    expect(levelOf(world.teams[0]!, "exploit-kits")).toBe(0);
    let done = false;
    for (let i = 0; i < def.researchTicks + 5 && !done; i++) {
      step(world, content);
      done = world.events.some((e) => e.type === "researched");
    }
    expect(done).toBe(true);
    expect(levelOf(world.teams[0]!, "exploit-kits")).toBe(1);
    expect(world.teams[0]!.research).toBeNull();
    expect(multiplier(content, world.teams[0]!, "unitDamage")).toBeCloseTo(1 + def.perLevel);
  });

  it("level n costs cost * n", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.upgrades["anycast"] = 1;
    expect(nextLevel(content, world.teams[0]!, "anycast")).toMatchObject({ level: 2, cost: content.upgrades.anycast!.cost * 2 });
  });

  it("one research at a time, no buying past max, and it must be affordable", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.compute = 5000;
    expect(research(world, "anycast")).toEqual([]);
    expect(research(world, "autoscaling")).toEqual(["already researching"]);
    world.teams[0]!.research = null;
    world.teams[0]!.upgrades["anycast"] = content.upgrades.anycast!.maxLevel;
    expect(research(world, "anycast")).toEqual(["fully researched"]);
    world.teams[0]!.compute = 0;
    expect(research(world, "premium-tier")).toEqual(["not enough compute"]);
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
