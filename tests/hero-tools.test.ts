// Race-tool hero abilities: each does its job when cast for real.

import { describe, expect, it } from "vitest";
import { createWorld, queueCommand, step, userCapacity, type Building, type World } from "../src/sim";
import { heroOf } from "../src/sim/heroes";
import { dealDamage } from "../src/sim/combat";
import { makeContext } from "../src/sim/context";
import { placeBuilding, spawnUnit } from "../src/sim/entities";
import { content } from "./fixtures";

function world(race: string, hero: string): World {
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
  it("every race keeps a fighter, and every hero has at least one race tool or is that fighter", () => {
    const tools = new Set(["shield", "build", "trigger", "discount", "funds", "stun", "users"]);
    for (const [raceId, race] of Object.entries(content.races)) {
      if (!race.heroes) continue;
      const kinds = race.heroes.map((h) => content.heroes.heroes[h]!.abilities.some((a) => tools.has(content.heroes.abilities[a]!.effect)));
      expect(kinds.filter((k) => !k).length, `${raceId} fighters`).toBeGreaterThanOrEqual(1);
      expect(kinds.filter((k) => k).length, `${raceId} tool heroes`).toBeGreaterThanOrEqual(2);
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

  it("Bug Bounty, Black Friday, Budget Alert pay out", () => {
    for (const [race, hero, ability] of [["open-source", "bug-hunter", "patch-tuesday"], ["hyperscaler", "evangelist", "black-friday"], ["serverless", "finops", "budget-alert"]] as const) {
      const w = world(race, hero);
      team(w).money = 0;
      cast(w, ability);
      expect(team(w).money, ability).toBeGreaterThanOrEqual(content.heroes.abilities[ability]!.amount);
    }
  });

  it("Architect · SLA halves damage to buildings in the area", () => {
    const w = world("hyperscaler", "architect");
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

  it("Free Tier and Loyalty Program bring users in at once, up to capacity", () => {
    for (const [race, hero, ability] of [["hyperscaler", "evangelist", "free-tier"], ["walled-garden", "brand-ambassador", "loyalty-program"]] as const) {
      const w = world(race, hero);
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

  it("FinOps · Savings Plan makes runs free for a while", () => {
    const w = world("serverless", "finops");
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

  it("Compliance Officer · Policy Update freezes creeps in the area", () => {
    const w = world("walled-garden", "compliance-officer");
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
