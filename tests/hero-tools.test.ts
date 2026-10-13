// Race-tool hero effects (build, trigger, funds, shield, users, discount,
// stun): each does its job when cast for real. One hero per race now, so
// the shipped heroes cover build and trigger; the rest are effects the
// engine supports, tested by giving a shipped hero the ability in a copy of
// the content.

import { describe, expect, it } from "vitest";
import { createWorld, queueCommand, step, userCapacity, type AbilityDef, type Building, type Content, type World } from "../src/sim";
import { heroOf } from "../src/sim/heroes";
import { dealDamage } from "../src/sim/combat";
import { makeContext } from "../src/sim/context";
import { placeBuilding, spawnUnit } from "../src/sim/entities";
import { content as shipped } from "./fixtures";

/** Spare race-tool abilities, as they shipped before heroes went to one per race. */
const SPARE: Record<string, AbilityDef> = {
  "patch-tuesday": {
    "name": "Bug Bounty",
    "description": "Sponsors pay out for what you found: +$ now.",
    "effect": "funds",
    "target": "self",
    "unlockLevel": 1,
    "cooldownTicks": 900,
    "range": 0,
    "amount": 150,
    "maxRank": 3,
    "perRank": 90
  },
  "black-friday": {
    "name": "Black Friday",
    "description": "A sales spike: +$ now.",
    "effect": "funds",
    "target": "self",
    "unlockLevel": 1,
    "cooldownTicks": 900,
    "range": 0,
    "amount": 140,
    "maxRank": 3,
    "perRank": 80
  },
  "budget-alert": {
    "name": "Budget Alert",
    "description": "Someone found the overspend: a refund of +$ now.",
    "effect": "funds",
    "target": "self",
    "unlockLevel": 1,
    "cooldownTicks": 800,
    "range": 0,
    "amount": 140,
    "maxRank": 3,
    "perRank": 80
  },
  "sla": {
    "name": "SLA",
    "description": "Four nines or refunds: your buildings in an area take half damage for a while.",
    "effect": "shield",
    "target": "point",
    "unlockLevel": 1,
    "cooldownTicks": 900,
    "range": 420,
    "radius": 260,
    "amount": 500,
    "durationTicks": 320,
    "maxRank": 3,
    "perRank": 100
  },
  "free-tier": {
    "name": "Free Tier",
    "description": "Something for nothing: users sign up right away (up to your capacity).",
    "effect": "users",
    "target": "self",
    "unlockLevel": 1,
    "cooldownTicks": 800,
    "range": 0,
    "amount": 40,
    "maxRank": 3,
    "perRank": 30
  },
  "loyalty-program": {
    "name": "Loyalty Program",
    "description": "Bring the faithful back: users return right away (up to your capacity).",
    "effect": "users",
    "target": "self",
    "unlockLevel": 1,
    "cooldownTicks": 800,
    "range": 0,
    "amount": 50,
    "maxRank": 3,
    "perRank": 30
  },
  "savings-plan": {
    "name": "Savings Plan",
    "description": "Committed capacity: function runs cost nothing for a while.",
    "effect": "discount",
    "target": "self",
    "unlockLevel": 1,
    "cooldownTicks": 1100,
    "range": 0,
    "amount": 0,
    "durationTicks": 300,
    "maxRank": 3,
    "perRank": 0
  },
  "policy-update": {
    "name": "Policy Update",
    "description": "New rules, effective immediately: creeps in an area freeze while they read them, and take a little damage.",
    "effect": "stun",
    "target": "point",
    "unlockLevel": 1,
    "cooldownTicks": 420,
    "range": 380,
    "radius": 150,
    "amount": 30,
    "durationTicks": 70,
    "maxRank": 3,
    "perRank": 20
  }
} as Record<string, AbilityDef>;

let content: Content = shipped;

/** A world for `hero`; with `ability`, a content copy where the hero's third ability is that one. */
function world(race: string, hero: string, ability?: string): World {
  content = shipped;
  if (ability && SPARE[ability]) {
    content = structuredClone(shipped);
    content.heroes.abilities[ability] = SPARE[ability]!;
    content.heroes.heroes[hero]!.abilities[2] = ability;
  }
  const w = createWorld(content, { seed: 1234, races: [race, "botnet"], heroes: [hero], startWithCore: true });
  w.teams[0]!.money = 100_000;
  return w;
}
const team = (w: World) => w.teams[0]!;
const core = (w: World) => w.entities.find((e) => e.id === team(w).coreId) as Building;

/** Learn and cast an ability through the real commands; returns once it went off. */
function cast(w: World, ability: string, at?: { x: number; y: number }): void {
  const t = team(w);
  t.hero!.level = 10;
  if (!t.hero!.ranks[ability]) queueCommand(w, { type: "learn", tick: w.tick, team: 0, ability });
  step(w, content);
  const hero = heroOf(w, t)!;
  const p = at ?? { x: hero.x, y: hero.y };
  queueCommand(w, { type: "cast", tick: w.tick, team: 0, ability, x: p.x, y: p.y, targetId: null });
  for (let i = 0; i < 200 && !(t.hero!.cooldowns[ability]! > 0); i += 1) step(w, content);
  expect(t.hero!.cooldowns[ability], `${ability} went off`).toBeGreaterThan(0);
}

describe("hero race tools", () => {
  it("every race has exactly one hero", () => {
    for (const [raceId, race] of Object.entries(shipped.races)) {
      if (race.controller === "human") expect(race.heroes, raceId).toHaveLength(1);
    }
  });

  it("Maintainer · Hotfix finishes construction around the hero", () => {
    const w = world("open-source", "maintainer");
    const hero = heroOf(w, team(w))!;
    const rack = placeBuilding(w, content, 0, "server-rack", Math.floor(hero.x / 48) + 2, Math.floor(hero.y / 48), false);
    expect(rack.buildRemaining).toBeGreaterThan(0);
    cast(w, "hotfix");
    expect(rack.buildRemaining).toBe(0);
    expect(rack.hp).toBe(rack.maxHp);
  });

  it("Bug Bounty, Black Friday, Budget Alert (funds) pay out", () => {
    for (const [race, hero, ability] of [["open-source", "maintainer", "patch-tuesday"], ["hyperscaler", "sre", "black-friday"], ["serverless", "function-author", "budget-alert"]] as const) {
      const w = world(race, hero, ability);
      team(w).money = 0;
      cast(w, ability);
      expect(team(w).money, ability).toBeGreaterThanOrEqual(content.heroes.abilities[ability]!.amount);
    }
  });

  it("SLA (shield) halves damage to buildings in the area", () => {
    const w = world("hyperscaler", "sre", "sla");
    const c = core(w);
    const ctx = makeContext(w, content);
    const bot = spawnUnit(ctx, 1, "bot", c, c.x + 300, c.y, "roam");
    let before = c.hp;
    dealDamage(ctx, bot, c, 200);
    const plain = before - c.hp;
    cast(w, "sla", { x: c.x, y: c.y });
    before = c.hp;
    dealDamage(makeContext(w, content), bot, c, 200);
    expect(before - c.hp).toBeLessThan(plain * 0.7);
  });

  it("Free Tier and Loyalty Program (users) bring users in at once, up to capacity", () => {
    for (const [race, hero, ability] of [["hyperscaler", "sre", "free-tier"], ["walled-garden", "platform-owner", "loyalty-program"]] as const) {
      const w = world(race, hero, ability);
      team(w).users = 0;
      cast(w, ability);
      const cap = userCapacity(w, content, team(w));
      expect(team(w).users, ability).toBeGreaterThanOrEqual(Math.min(cap, content.heroes.abilities[ability]!.amount));
      expect(team(w).users).toBeLessThanOrEqual(userCapacity(w, content, team(w)));
    }
  });

  it("Function Author · Fan-Out runs every function near the point, free, cooldown or not", () => {
    const w = world("serverless", "function-author");
    const c = core(w);
    const fns = [placeBuilding(w, content, 0, "function", c.col + 3, c.row, true), placeBuilding(w, content, 0, "function", c.col - 2, c.row, true)];
    for (const f of fns) f.spawnTimer = 500;
    const money = team(w).money;
    cast(w, "fan-out", { x: c.x, y: c.y });
    expect(w.entities.filter((e) => e.kind === "unit" && e.defId === "lambda").length).toBeGreaterThanOrEqual(8);
    expect(team(w).money).toBe(money);
  });

  it("Savings Plan (discount) makes runs free for a while", () => {
    const w = world("serverless", "function-author", "savings-plan");
    const c = core(w);
    const fn = placeBuilding(w, content, 0, "function", c.col + 3, c.row, true);
    cast(w, "savings-plan");
    team(w).money = 0;
    fn.spawnTimer = 0;
    spawnUnit(makeContext(w, content), 1, "bot", fn, fn.x + 60, fn.y, "roam");
    for (let i = 0; i < 5; i += 1) step(w, content);
    expect(w.entities.some((e) => e.kind === "unit" && e.defId === "lambda")).toBe(true);
    expect(team(w).money).toBeGreaterThanOrEqual(0);
  });

  it("Policy Update (stun) freezes creeps in the area", () => {
    const w = world("walled-garden", "platform-owner", "policy-update");
    const hero = heroOf(w, team(w))!;
    const at = { x: hero.x + 200, y: hero.y };
    const bot = spawnUnit(makeContext(w, content), 1, "bot", at, at.x, at.y, "roam");
    cast(w, "policy-update", at);
    const x = bot.x;
    const y = bot.y;
    for (let i = 0; i < 20; i += 1) step(w, content);
    expect(bot.stunnedUntil).toBeGreaterThan(w.tick);
    expect([bot.x, bot.y]).toEqual([x, y]);
  });
});
