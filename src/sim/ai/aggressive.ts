// Aggressive mode for balance runs (difficulty.aggressive, off in every real
// difficulty): the computer player also expands with a deploy agent and rents
// Spot Capacity when it is compute-capped. Ordinary commands only. (Attacking
// Botnet Farms lives in army.ts, with the rest of the army's logic.)

import type { Content, DifficultyDef } from "../content";
import { computeBalance, spotCost, spotState, squadReserve } from "../economy";
import { TICK_RATE } from "../map";
import { buildCost, canFound, canPlace, expansionBlocker } from "../placement";
import { nextLevel } from "../upgrades";
import { isWall, rankBlocker, rankCost } from "../ranks";
import type { Command, Team, World } from "../types";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type Order = DistributiveOmit<Command, "tick" | "team">;

/** Rent Spot when compute-capped and still holding a reserve afterwards. */
export function rentSpot(
  world: World,
  content: Content,
  team: Team,
  level: DifficultyDef,
  issue: (c: Order) => unknown,
): void {
  if (spotState(world, team) === "active") return;
  const { supply, demand } = computeBalance(world, content, team);
  // Capped: spare compute doesn't cover what its squads still need.
  if (supply - demand >= squadReserve(world, content, team)) return;
  if (team.money < spotCost(content, team) + level.tierReserve) return;
  issue({ type: "rentCompute" });
}

/** Spend only surplus, budgeting for earlier orders in this decision tick too. */
function surplus(world: World, content: Content, team: Team, level: DifficultyDef): number {
  let budget = team.money - level.tierReserve;
  for (const c of world.commands) {
    if (c.team !== team.id || c.tick !== world.tick) continue;
    if (c.type === "rentCompute") budget -= spotCost(content, team);
    if (c.type === "research") budget -= nextLevel(content, team, c.upgrade).cost;
    if (c.type === "trainAgent") {
      const core = world.entities.find(e => e.id === c.coreId);
      if (core) budget -= content.buildings[core.defId]!.cost;
    }
    if (c.type === "build") budget -= buildCost(world, content, team.id, c.building);
    if (c.type === "rank") {
      const b = world.entities.find(e => e.id === c.buildingId);
      if (b?.kind === "building") budget -= rankCost(content, world, b) ?? 0;
    }
  }
  return budget;
}

/** A stable square, two empty tiles beyond the main base's existing footprint.
 * Ignore remote expansions and fortifications when choosing it; remember it so
 * subsequent base growth (or losses) cannot turn it into concentric rings.
 */
export function buildRing(world: World, content: Content, team: Team, level: DifficultyDef, issue: (c: Order) => unknown): void {
  const { supply, demand } = computeBalance(world, content, team);
  if (supply - demand >= squadReserve(world, content, team)) return;
  const core = world.entities.find(e => e.id === team.coreId);
  if (!core || core.kind !== "building" || core.hp <= 0 || core.buildRemaining > 0 || !team.ai) return;
  let budget = surplus(world, content, team, level);
  if (budget < Math.min(buildCost(world, content, team.id, "wall"), buildCost(world, content, team.id, "gate"))) return;
  if (team.ai.wallRing?.coreId !== core.id) {
    let extent = core.footprint - 1;
    for (const e of world.entities) {
      if (e.kind !== "building" || e.team !== team.id || e.hp <= 0 || isWall(e)) continue;
      // The normal base rotation searches at most ten tiles from the core.
      if (Math.max(Math.abs(e.col - core.col), Math.abs(e.row - core.row)) > 10) continue;
      extent = Math.max(extent, Math.abs(e.col - core.col), Math.abs(e.row - core.row),
        Math.abs(e.col + e.footprint - 1 - core.col), Math.abs(e.row + e.footprint - 1 - core.row));
    }
    team.ai.wallRing = { coreId: core.id, radius: extent + 3 };
  }
  const radius = team.ai.wallRing.radius;
  let placed = 0;
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
      const col = core.col + dc;
      const row = core.row + dr;
      const building = dc === 0 || dr === 0 ? "gate" : "wall";
      const cost = buildCost(world, content, team.id, building);
      if (cost > budget || world.commands.some(c => c.tick === world.tick && c.type === "build" && c.col === col && c.row === row)) continue;
      if (canPlace(world, content, team.id, building, col, row, cost) !== null) continue;
      budget -= cost;
      issue({ type: "build", building, col, row });
      if (++placed === 4) return;
    }
  }
}

export function rankWalls(world: World, content: Content, team: Team, level: DifficultyDef, issue: (c: Order) => unknown): void {
  const { supply, demand } = computeBalance(world, content, team);
  if (supply - demand >= squadReserve(world, content, team)) return;
  let budget = surplus(world, content, team, level);
  for (const e of world.entities) {
    if (e.kind !== "building" || !isWall(e) || rankBlocker(content, world, team.id, e) !== null) continue;
    const price = rankCost(content, world, e)!;
    if (price > budget || world.commands.some(c => c.team === team.id && c.type === "rank" && c.buildingId === e.id)) continue;
    budget -= price;
    issue({ type: "rank", buildingId: e.id });
  }
}

/** Train a deploy agent when affordable and none is out; send an idle one to the nearest free site and found there. */
export function expand(
  world: World,
  content: Content,
  team: Team,
  level: DifficultyDef,
  issue: (c: Order) => unknown,
): void {
  const core = world.entities.find((e) => e.id === team.coreId);
  if (!core || core.kind !== "building") return;
  const agent = world.entities.find((e) => e.id === team.builderId);
  if (agent && agent.kind === "unit" && agent.hp > 0) {
    // Already walking to a site (or about to): leave it be.
    if (agent.moveTo || agent.foundAt) return;
    // Let a threatened agent recover at home before trying another expansion.
    if (agent.agentHitTick !== undefined && world.tick - agent.agentHitTick < 10 * TICK_RATE) return;
    let best: { col: number; row: number } | null = null;
    let bestD = Infinity;
    for (const s of world.terrain.starts) {
      const col = s.col;
      const row = s.row;
      const d = (col - core.col) * (col - core.col) + (row - core.row) * (row - core.row);
      if (d >= bestD) continue;
      if (canFound(world, content, team.id, col, row) !== null) continue;
      best = { col, row };
      bestD = d;
    }
    if (best) issue({ type: "found", col: best.col, row: best.row });
    return;
  }
  if (expansionBlocker(world, content, team) || core.buildRemaining > 0) return;
  const cost = content.buildings[core.defId]!.cost;
  if (team.money < cost + level.tierReserve) return;
  issue({ type: "trainAgent", coreId: core.id });
}
