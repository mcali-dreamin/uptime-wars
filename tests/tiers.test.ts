import { describe, expect, it } from "vitest";
import {
  canPlace,
  canResearch,
  computeBalance,
  coreReachBonus,
  reachOf,
  createWorld,
  hashWorld,
  inNetwork,
  queueCommand,
  step,
  tierOf,
  tierUpgrade,
  trafficRadius,
  TILE,
  type World,
} from "../src/sim";
import { placeBuilding } from "../src/sim/entities";
import { content, SETUP } from "./fixtures";

const TIER = tierUpgrade(content)!;
const tiers = content.economy.tiers;
const team0 = (w: World) => w.teams[0]!;
const core0 = (w: World) => w.entities.find((e) => e.id === team0(w).coreId)! as { x: number; y: number; col: number; row: number; hp: number; maxHp: number };

/** Research the next tier the real way: command, then wait it out. */
function advance(world: World) {
  team0(world).money += 100_000;
  queueCommand(world, { type: "research", tick: world.tick, team: 0, upgrade: TIER });
  const target = tierOf(content, team0(world)) + 1;
  while (tierOf(content, team0(world)) < target && world.tick < 100_000) step(world, content);
}

/** Open spots near the core where `building` could go (ignoring tier and money). */
function spots(world: World, building: string): { col: number; row: number }[] {
  const c = core0(world);
  const out: { col: number; row: number }[] = [];
  for (let r = c.row - 6; r <= c.row + 7; r += 2) {
    for (let k = c.col - 6; k <= c.col + 7; k += 2) {
      const reason = canPlace(world, content, 0, building, k, r);
      if (reason === null || reason.startsWith("only") || reason.startsWith("needs")) out.push({ col: k, row: r });
    }
  }
  return out;
}

describe("core tiers", () => {
  it("the content has a tier upgrade with one tier entry per level", () => {
    expect(TIER).toBeDefined();
    expect(tiers.length).toBe(content.upgrades[TIER]!.maxLevel + 1);
  });

  it("you start at tier 0 and research up through every tier, one research at a time", () => {
    const world = createWorld(content, SETUP);
    expect(tierOf(content, team0(world))).toBe(0);
    team0(world).money += 100_000;
    queueCommand(world, { type: "research", tick: world.tick, team: 0, upgrade: TIER });
    step(world, content);
    expect(canResearch(content, team0(world), "anycast")).toBe("already researching");
    advance(world);
    expect(tierOf(content, team0(world))).toBe(1);
    advance(world);
    expect(tierOf(content, team0(world))).toBe(2);
    expect(canResearch(content, team0(world), TIER)).toBe("fully researched");
  });

  it("Web Apps are limited by tier: 2, then 4, then 6", () => {
    const world = createWorld(content, SETUP);
    team0(world).money = 1e6;
    const limits = content.buildings["web-app"]!.limitPerTier!;
    const places = spots(world, "web-app");
    let built = 0;
    for (const [tier, limit] of limits.entries()) {
      while (tierOf(content, team0(world)) < tier) advance(world);
      team0(world).money = 1e6;
      for (const p of places) {
        if (canPlace(world, content, 0, "web-app", p.col, p.row) === null) {
          placeBuilding(world, content, 0, "web-app", p.col, p.row, true);
          built += 1;
        }
      }
      expect(built).toBe(limit);
      const free = places.find((p) => !world.entities.some((e) => e.kind === "building" && e.col === p.col && e.row === p.row));
      if (free) expect(canPlace(world, content, 0, "web-app", free.col, free.row)).toBe(`only ${limit} at ${tiers[tier]!.name}`);
    }
  });

  it("tier-gated buildings unlock at their tier", () => {
    const world = createWorld(content, SETUP);
    team0(world).money = 1e6;
    const p = spots(world, "gpu-cluster")[0]!;
    expect(canPlace(world, content, 0, "gpu-cluster", p.col, p.row)).toBe(`needs ${tiers[1]!.name}`);
    advance(world);
    team0(world).money = 1e6;
    expect(canPlace(world, content, 0, "gpu-cluster", p.col, p.row)).toBeNull();
  });

  it("each tier adds compute, core reach, core HP, and traffic", () => {
    const world = createWorld(content, SETUP);
    const before = {
      supply: computeBalance(world, content, team0(world)).supply,
      traffic: trafficRadius(world, content, team0(world)),
      maxHp: core0(world).maxHp,
    };
    const c = core0(world);
    const edge = (content.buildings.core!.buildRadius! + 1) * TILE;
    expect(inNetwork(world, content, 0, c.x + edge, c.y)).toBe(false);
    advance(world);
    expect(computeBalance(world, content, team0(world)).supply - before.supply).toBe(tiers[1]!.compute);
    expect(trafficRadius(world, content, team0(world))).toBeGreaterThanOrEqual(before.traffic + tiers[1]!.traffic);
    expect(core0(world).maxHp).toBe(Math.round(before.maxHp * tiers[1]!.coreHp));
    expect(inNetwork(world, content, 0, c.x + edge, c.y)).toBe(true);
  });

  it("a core built after upgrading comes at the tier's HP", () => {
    const world = createWorld(content, SETUP);
    advance(world);
    const extra = placeBuilding(world, content, 0, "core", core0(world).col + 6, core0(world).row, true);
    expect(extra.maxHp).toBe(Math.round(content.buildings.core!.hp * tiers[1]!.coreHp));
  });

  it("is deterministic", () => {
    const a = createWorld(content, SETUP);
    const b = createWorld(content, SETUP);
    advance(a);
    advance(b);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });
});

describe("core reach composes", () => {
  const wg = () => createWorld(content, { seed: 1234, races: ["walled-garden", "botnet"], startWithCore: true });
  const reachTiles = (w: World) => reachOf(w, content, core0(w) as never) / TILE;

  it("Walled Garden's cores reach 3 tiles further than everyone else's", () => {
    expect(reachTiles(createWorld(content, SETUP))).toBe(content.buildings.core!.buildRadius!);
    expect(reachTiles(wg())).toBe(content.buildings.core!.buildRadius! + 3);
  });

  it("tier, race, perks and research add up", () => {
    const w = wg();
    const team = w.teams[0]!;
    const base = content.buildings.core!.buildRadius!;
    team.upgrades[TIER] = 2;
    expect(coreReachBonus(content, team)).toBe(tiers[2]!.buildRadius + 3);
    expect(reachTiles(w)).toBe(base + tiers[2]!.buildRadius + 3);
    // A perk can set it, and research can add to it: same formula, no special cases.
    const perkContent = structuredClone(content);
    perkContent.races["walled-garden"]!.tierPerks![1] = { name: "x", modifiers: { buildRadiusBonus: 5 } };
    perkContent.upgrades["reach"] = { name: "Reach", description: "", stat: "buildRadius", perLevel: 1, maxLevel: 2, cost: 1, researchTicks: 1 };
    team.upgrades["reach"] = 2;
    expect(coreReachBonus(perkContent, team)).toBe(tiers[2]!.buildRadius + 5 + 2);
  });
});
