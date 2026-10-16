// Late-game compute: at the top core tier generators keep going at a steeper
// price, and arriving users never take the compute a refilling squad needs.

import { describe, expect, it } from "vitest";
import { buildCost, computeBalance, createWorld, step, tierBlocker, tierUpgrade, TILE_OPEN, tileAt, type World } from "../src/sim";
import { placeBuilding } from "../src/sim/entities";
import { owned } from "../src/sim/placement";
import { content, SETUP } from "./fixtures";

const TIER = tierUpgrade(content)!;
const TOP = content.economy.tiers.length - 1;
const GENERATORS = ["solar-array", "power-plant", "compute-pool", "private-cloud"];

/** Open 2x2 sites spread over the map, away from everything. */
function sites(world: World): { col: number; row: number }[] {
  const t = world.terrain;
  const out: { col: number; row: number }[] = [];
  for (let r = 4; r < t.rows - 4; r += 5) {
    for (let c = 4; c < t.cols - 4; c += 5) {
      if ([0, 1].every((dr) => [0, 1].every((dc) => tileAt(t, c + dc, r + dr) === TILE_OPEN))) out.push({ col: c, row: r });
    }
  }
  return out;
}

describe("late compute", () => {
  it("below the top tier a generator's limit is hard; at the top it turns soft, each one past it pricier", () => {
    for (const id of GENERATORS) {
      const def = content.buildings[id]!;
      expect(def.pastLimitGrowthPermille, id).toBeGreaterThan(0);
      const world = createWorld(content, SETUP);
      const team = world.teams[0]!;
      const free = sites(world);
      const limit = def.limitPerTier![TOP]!;
      team.upgrades[TIER] = TOP - 1;
      const lower = def.limitPerTier![TOP - 1]!;
      for (let i = 0; i < lower; i += 1) placeBuilding(world, content, 0, id, free[i]!.col, free[i]!.row, true);
      expect(tierBlocker(content, team, id, owned(world, 0, id)), id).not.toBeNull();
      team.upgrades[TIER] = TOP;
      for (let i = lower; i < limit; i += 1) placeBuilding(world, content, 0, id, free[i]!.col, free[i]!.row, true);
      const atLimit = buildCost(world, content, 0, id);
      expect(tierBlocker(content, team, id, owned(world, 0, id)), id).toBeNull();
      placeBuilding(world, content, 0, id, free[limit]!.col, free[limit]!.row, true);
      const onePast = buildCost(world, content, 0, id);
      // Plain growth would add one costGrowth step; past the limit it adds the steeper one too.
      const step = (onePast - atLimit) / def.cost;
      expect(step, id).toBeGreaterThan((def.pastLimitGrowthPermille! + content.economy.costGrowthPermille) / 1000 - 0.02);
    }
  });

  it("arriving users take only compute that's free after the squads refill: the army comes first", () => {
    const world = createWorld(content, SETUP);
    const team = world.teams[0]!;
    world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
    const free = sites(world);
    const rack = content.buildings["server-rack"]!.spawn!;
    // Room for far more users than there's compute for, and three racks' squads.
    for (let i = 0; i < 6; i += 1) placeBuilding(world, content, 0, "web-app", free[i]!.col, free[i]!.row, true);
    for (let i = 6; i < 9; i += 1) placeBuilding(world, content, 0, "server-rack", free[i]!.col, free[i]!.row, true);
    const guards = () => world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard");
    for (let t = 0; t < 20 * 120; t += 1) {
      step(world, content);
      const { supply, demand } = computeBalance(world, content, team);
      // Users never push you over: they only fill what's free.
      expect(demand, `tick ${world.tick}`).toBeLessThanOrEqual(supply);
    }
    expect(guards()).toHaveLength(3 * rack.maxAlive);
    expect(team.users).toBeGreaterThan(0);
    expect(team.waitingOnCompute).toBe(true);
    // Units die: the users that arrive meanwhile leave their slots alone, and they come back.
    for (const u of guards().slice(0, 4)) u.hp = 0;
    for (let t = 0; t < 20 * 60; t += 1) step(world, content);
    expect(guards()).toHaveLength(3 * rack.maxAlive);
  });
});
