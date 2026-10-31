// Aggressive mode for balance runs (difficulty.aggressive, off in every real
// difficulty): the computer player also expands with a deploy agent and rents
// Spot Capacity when it is compute-capped. Ordinary commands only. (Attacking
// Botnet Farms lives in army.ts, with the rest of the army's logic.)

import type { Content, DifficultyDef } from "../content";
import { computeBalance, spotCost, spotState, squadReserve } from "../economy";
import { canFound, expansionBlocker } from "../placement";
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
