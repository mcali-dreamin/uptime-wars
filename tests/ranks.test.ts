// Spawner ranks: upgrade a spawner in place for fewer, stronger units. And
// extra cores are reach and redundancy, not a compute source.

import { describe, expect, it } from "vitest";
import {
  computeBalance,
  createWorld,
  hashWorld,
  queueCommand,
  rankBlocker,
  rankCost,
  step,
  tierUpgrade,
  type Building,
  type Unit,
  type World,
} from "../src/sim";
import { unitUpkeep } from "../src/sim/economy";
import { makeContext } from "../src/sim/context";
import { placeBuilding } from "../src/sim/entities";
import { invoke } from "../src/sim/functions";
import { content } from "./fixtures";

const TIER = tierUpgrade(content)!;
const PLAYABLE = Object.entries(content.races).filter(([, r]) => r.controller === "human");
const setup = (race: string) => ({ seed: 1234, races: [race, "botnet"], startWithCore: true });
const world = (race: string): World => createWorld(content, setup(race));
const core = (w: World) => w.entities.find((e) => e.id === w.teams[0]!.coreId) as Building;
const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i += 1) step(w, content);
};
const squad = (w: World, b: Building) => w.entities.filter((e): e is Unit => e.kind === "unit" && e.spawnerId === b.id && e.hp > 0 && e.expiresAt === undefined);

/** A finished spawner next to the core, at tier `tier`, with money to spare. */
function spawner(race: string, building: string, tier = 1): { w: World; b: Building } {
  const w = world(race);
  const c = core(w);
  const b = placeBuilding(w, content, 0, building, c.col + 4, c.row, true);
  w.teams[0]!.upgrades[TIER] = tier;
  w.teams[0]!.money = 5000;
  return { w, b };
}

/** Rank it up through the command queue and wait out the refit. */
function rankUp(w: World, b: Building): void {
  queueCommand(w, { type: "rank", tick: w.tick, team: 0, buildingId: b.id });
  run(w, 1);
  expect(b.refitRemaining, "refit started").toBeGreaterThan(0);
  run(w, b.refitRemaining! + 1);
}

describe("spawner ranks", () => {
  it("every playable race has two ranks, gated on Data Center and Region", () => {
    for (const [id, race] of PLAYABLE) {
      expect(race.spawnerRanks?.map((r) => r.tier), id).toEqual([1, 2]);
      for (const rank of race.spawnerRanks!) {
        // Worth more per compute than the plain unit: that's the whole point.
        const power = (rank.hpPermille / 1000) * (rank.damagePermille / 1000);
        expect(power / (rank.upkeepPermille / 1000), `${id} ${rank.name}`).toBeGreaterThan(1.2);
      }
    }
  });

  it("needs the core tier, and money", () => {
    const { w, b } = spawner("hyperscaler", "hyperscale-rack", 0);
    expect(rankBlocker(content, w, 0, b)).toBe("needs Data Center");
    w.teams[0]!.upgrades[TIER] = 1;
    w.teams[0]!.money = 0;
    expect(rankBlocker(content, w, 0, b)).toBe("not enough $");
    w.teams[0]!.money = 5000;
    expect(rankBlocker(content, w, 0, b)).toBeNull();
    expect(rankBlocker(content, w, 1, b)).toBe("not your building");
  });

  it("only spawners rank up", () => {
    const w = world("hyperscaler");
    w.teams[0]!.upgrades[TIER] = 2;
    w.teams[0]!.money = 5000;
    const c = core(w);
    const plant = placeBuilding(w, content, 0, "power-plant", c.col + 4, c.row, true);
    expect(rankBlocker(content, w, 0, plant)).toBe("can't upgrade");
  });

  it("charges, pauses spawning while it refits, then fields tougher units for more compute", () => {
    const { w, b } = spawner("hyperscaler", "hyperscale-rack", 1);
    const rank = content.races.hyperscaler!.spawnerRanks![0]!;
    const price = rankCost(content, w, b)!;
    const money = w.teams[0]!.money;
    queueCommand(w, { type: "rank", tick: w.tick, team: 0, buildingId: b.id });
    run(w, 1);
    // Paid (give or take a tick of income).
    expect(w.teams[0]!.money).toBeLessThan(money - price + 50);
    expect(rankBlocker(content, w, 0, b)).toBe("already upgrading");
    // Nothing comes out mid-refit.
    const before = squad(w, b).length;
    run(w, b.refitRemaining! - 5);
    expect(squad(w, b).length).toBe(before);
    run(w, 10);
    expect(b.rank).toBe(1);
    expect(b.refitRemaining).toBeUndefined();

    run(w, 400);
    const units = squad(w, b).filter((u) => u.rank === 1);
    expect(units.length).toBeGreaterThan(0);
    const def = content.units["load-balancer"]!;
    const plainHp = Math.round(def.hp * content.races.hyperscaler!.modifiers.unitHpMultiplier);
    expect(units[0]!.maxHp).toBe(Math.round((plainHp * rank.hpPermille) / 1000));
    expect(units[0]!.armor).toBe(def.armor + rank.armor);

    // Each ranked unit uses its rank's share more compute.
    const { demand } = computeBalance(w, content, w.teams[0]!);
    const ranked = Math.round((unitUpkeep(content, "load-balancer") * rank.upkeepPermille) / 1000);
    for (const u of units) u.hp = 0;
    w.entities = w.entities.filter((e) => e.hp > 0);
    expect(demand - computeBalance(w, content, w.teams[0]!).demand).toBe(ranked * units.length);
  });

  it("goes to the top rank at Region, and no further", () => {
    const { w, b } = spawner("open-source", "server-rack", 1);
    rankUp(w, b);
    expect(rankBlocker(content, w, 0, b)).toBe("needs Region");
    w.teams[0]!.upgrades[TIER] = 2;
    w.teams[0]!.money = 5000;
    rankUp(w, b);
    expect(b.rank).toBe(2);
    expect(rankBlocker(content, w, 0, b)).toBe("top rank");
  });

  it("Walled Garden: a ranked store keeps a smaller squad", () => {
    const { w, b } = spawner("walled-garden", "flagship-store", 1);
    const plain = content.buildings["flagship-store"]!.spawn!.maxAlive;
    rankUp(w, b);
    run(w, 3000);
    const standing = squad(w, b).filter((u) => u.rank === 1);
    expect(standing.length).toBeLessThanOrEqual(plain - 1);
  });

  it("Serverless: a ranked function bursts bigger", () => {
    const { w, b } = spawner("serverless", "function", 1);
    const ctx = makeContext(w, content);
    const plain = invoke(ctx, b, false).length;
    for (const u of w.entities) if (u.kind === "unit" && u.expiresAt !== undefined) u.hp = 0;
    b.scaleTimer = 0;
    b.rank = 1;
    const ranked = invoke(ctx, b, false);
    expect(ranked.length).toBe(plain + 1);
    expect(ranked.every((u) => u.rank === 1)).toBe(true);
  });

  it("a match with rank-ups replays exactly from its log", () => {
    const { w, b } = spawner("hyperscaler", "hyperscale-rack", 1);
    queueCommand(w, { type: "rank", tick: 5, team: 0, buildingId: b.id });
    run(w, 1200);
    expect(w.log.some((c) => c.type === "rank")).toBe(true);
    // Rebuild the same start (placed rack, tier, money) and replay the log.
    const r = spawner("hyperscaler", "hyperscale-rack", 1).w;
    for (const c of w.log) queueCommand(r, c);
    run(r, 1200);
    expect(hashWorld(r)).toBe(hashWorld(w));
  });
});

describe("extra cores", () => {
  it("add reach and redundancy, not compute", () => {
    const w = world("hyperscaler");
    const c = core(w);
    const before = computeBalance(w, content, w.teams[0]!).supply;
    placeBuilding(w, content, 0, "core", c.col + 6, c.row, true);
    placeBuilding(w, content, 0, "core", c.col - 6, c.row, true);
    expect(computeBalance(w, content, w.teams[0]!).supply).toBe(before);
  });

  it("a backup core still supplies when the main one falls", () => {
    const w = world("hyperscaler");
    const c = core(w);
    const before = computeBalance(w, content, w.teams[0]!).supply;
    placeBuilding(w, content, 0, "core", c.col + 6, c.row, true);
    c.hp = 0;
    w.entities = w.entities.filter((e) => e.hp > 0);
    expect(computeBalance(w, content, w.teams[0]!).supply).toBe(before);
  });
});
