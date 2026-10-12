import { describe, expect, it } from "vitest";
import {
  createWorld,
  forkCost,
  raceMechanics,
  raceModifiers,
  regionShield,
  step,
  tierUpgrade,
  type Building,
  type Unit,
  type World,
} from "../src/sim";
import { dealDamage } from "../src/sim/combat";
import { makeContext } from "../src/sim/context";
import { placeBuilding, spawnUnit } from "../src/sim/entities";
import { invoke } from "../src/sim/functions";
import { loseUsers } from "../src/sim/economy";
import { content } from "./fixtures";

const TIER = tierUpgrade(content)!;
const PLAYABLE = Object.entries(content.races).filter(([, r]) => r.controller === "human");
const world = (race: string): World => createWorld(content, { seed: 1234, races: [race, "botnet"], startWithCore: true });
const setTier = (w: World, tier: number) => (w.teams[0]!.upgrades[TIER] = tier);
const core = (w: World) => w.entities.find((e) => e.id === w.teams[0]!.coreId) as Building;
const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i += 1) step(w, content);
};

/** Units a building makes: spawned or invoked. */
const unitOf = (id: string) => content.buildings[id]!.spawn?.unit ?? content.buildings[id]!.invoke?.unit;

describe("race rosters", () => {
  it("every playable race fields three units of its own, one per core tier", () => {
    const owners = new Map<string, string[]>();
    for (const [raceId, race] of PLAYABLE) {
      const byTier = [0, 1, 2].map((t) =>
        race.buildings.filter((b) => (content.buildings[b]!.tier ?? 0) === t && unitOf(b)).map((b) => unitOf(b)!),
      );
      for (const [tier, units] of byTier.entries()) expect(units.length, `${raceId} tier ${tier}`).toBeGreaterThanOrEqual(1);
      for (const u of new Set(byTier.flat())) owners.set(u, [...(owners.get(u) ?? []), raceId]);
    }
    // No race borrows another's unit.
    for (const [unit, races] of owners) expect(races, unit).toHaveLength(1);
  });

  it("every race has a perk at each tier above the first", () => {
    for (const [raceId, race] of PLAYABLE) {
      expect(race.tierPerks?.length, raceId).toBe(content.economy.tiers.length);
      for (let t = 1; t < content.economy.tiers.length; t += 1) expect(race.tierPerks![t]?.name, `${raceId} tier ${t}`).toBeTruthy();
    }
  });
});

describe("unit traits", () => {
  it("a Kernel mends allied units and buildings near it", () => {
    const w = world("open-source");
    const ctx = makeContext(w, content);
    const c = core(w);
    const kernel = spawnUnit(ctx, 0, "kernel", c, c.x + 40, c.y, "guard");
    const hurt = spawnUnit(ctx, 0, "process", c, c.x + 60, c.y, "guard");
    hurt.hp = 10;
    c.hp -= 500;
    const before = { unit: hurt.hp, core: c.hp };
    run(w, 40);
    expect(hurt.hp).toBeGreaterThan(before.unit);
    expect(c.hp).toBeGreaterThan(before.core);
    expect(kernel.hp).toBeGreaterThan(0);
  });

  it("a Mainframe hits buildings for triple damage", () => {
    const w = world("hyperscaler");
    const ctx = makeContext(w, content);
    const c = core(w);
    const nest = w.entities.find((e) => e.id === w.teams[1]!.coreId) as Building;
    const mf = spawnUnit(ctx, 0, "mainframe", c, c.x, c.y, "guard");
    const lb = spawnUnit(ctx, 0, "load-balancer", c, c.x, c.y, "guard");
    const before = nest.hp;
    dealDamage(ctx, mf, nest, 30);
    const siege = before - nest.hp;
    const mid = nest.hp;
    dealDamage(ctx, lb, nest, 30);
    expect(siege).toBeGreaterThan(2.5 * (mid - nest.hp));
  });

  it("a Legal Team hit makes an enemy act every other tick for a while", () => {
    const w = world("walled-garden");
    const ctx = makeContext(w, content);
    const c = core(w);
    const legal = spawnUnit(ctx, 0, "legal-team", c, c.x, c.y, "guard");
    const bot = spawnUnit(ctx, 1, "bot", c, c.x + 400, c.y, "roam");
    dealDamage(ctx, legal, bot, 1);
    expect(bot.slowedUntil).toBe(w.tick + content.units["legal-team"]!.slowTicks!);
  });
});

describe("tier perks", () => {
  it("Open Source: forks get cheaper at Data Center, repair doubles at Region", () => {
    const w = world("open-source");
    const ctx = makeContext(w, content);
    const rack = placeBuilding(w, content, 0, "server-rack", core(w).col + 3, core(w).row, true);
    const base = forkCost(w, content, 0, rack)!;
    setTier(w, 1);
    expect(forkCost(w, content, 0, rack)!).toBeLessThan(base);
    expect(raceMechanics(content, w.teams[0]!).repair!.permillePerSecond).toBe(15);
    setTier(w, 2);
    // Perks stack: Region keeps the cheaper forks and doubles repair.
    expect(forkCost(w, content, 0, rack)!).toBeLessThan(base);
    expect(raceMechanics(content, w.teams[0]!).repair!.permillePerSecond).toBe(30);
    void ctx;
  });

  it("Hyperscaler: a stronger region shield, then tougher units", () => {
    const w = world("hyperscaler");
    const c = core(w);
    const packed: Building[] = [];
    for (let i = 0; i < 8; i += 1) packed.push(placeBuilding(w, content, 0, "web-app", c.col - 3 + (i % 4), c.row + 3 + Math.floor(i / 4), true));
    const before = regionShield(w, content, packed[0]!).permille;
    setTier(w, 1);
    expect(regionShield(w, content, packed[0]!).permille).toBeGreaterThan(before);
    setTier(w, 2);
    expect(raceModifiers(content, w.teams[0]!).unitHpMultiplier).toBe(1.5);
    const ctx = makeContext(w, content);
    const lb = spawnUnit(ctx, 0, "load-balancer", c, c.x, c.y, "guard");
    expect(lb.maxHp).toBe(Math.round(content.units["load-balancer"]!.hp * 1.5));
  });

  it("Serverless: functions cool down faster, then runs cost less", () => {
    const w = world("serverless");
    const ctx = makeContext(w, content);
    const c = core(w);
    const fn = placeBuilding(w, content, 0, "function", c.col + 3, c.row, true);
    const def = content.buildings.function!.invoke!;
    w.teams[0]!.money = 1000;
    invoke(ctx, fn, false);
    expect(fn.spawnTimer).toBe(def.cooldownTicks);
    expect(w.teams[0]!.money).toBe(1000 - def.cost);
    setTier(w, 2);
    fn.spawnTimer = 0;
    w.teams[0]!.money = 1000;
    invoke(ctx, fn, false);
    expect(fn.spawnTimer).toBe(Math.round(def.cooldownTicks * 0.7));
    expect(w.teams[0]!.money).toBe(1000 - Math.round(def.cost * 0.6));
  });

  it("Walled Garden: walls hit melee attackers back, then users barely leave", () => {
    const w = world("walled-garden");
    const ctx = makeContext(w, content);
    const c = core(w);
    const wall = placeBuilding(w, content, 0, "garden-wall", c.col + 3, c.row, true);
    const bot = spawnUnit(ctx, 1, "bot", wall, wall.x + 30, wall.y, "roam") as Unit;
    let hp = bot.hp;
    dealDamage(ctx, bot, wall, 5);
    expect(bot.hp).toBe(hp);
    setTier(w, 1);
    dealDamage(ctx, bot, wall, 5);
    expect(bot.hp).toBeLessThan(hp);
    hp = bot.hp;

    const team = w.teams[0]!;
    team.users = 1000;
    loseUsers(ctx, team, 1200, "core");
    const lostAtDataCenter = 1000 - team.users;
    team.users = 1000;
    team.churnCarry = 0;
    setTier(w, 2);
    loseUsers(ctx, team, 1200, "core");
    expect(1000 - team.users).toBeLessThan(lostAtDataCenter);
  });
});
