// Race mechanics: what makes a race play differently beyond its numbers
// (see RaceDef.mechanics). Open Source forks and self-repairs; Hyperscaler
// gets tougher where its buildings cluster into regions.

import type { TickContext } from "./context";
import type { Content } from "./content";
import { placeBuilding } from "./entities";
import { TICK_RATE, TILE } from "./map";
import { buildCost, canPlace, isCore } from "./placement";
import type { Building, ForkCommand, TeamId, World } from "./types";
import { raceMechanics } from "./tiers";

/** What a fork of `source` costs this team, or null if the race can't fork it. */
export function forkCost(world: World, content: Content, teamId: TeamId, source: Building | undefined): number | null {
  const team = world.teams[teamId]!;
  const fork = raceMechanics(content, team).fork;
  if (!fork || !source || source.team !== teamId || source.hp <= 0 || source.buildRemaining > 0) return null;
  if (isCore(content, team, source)) return null;
  return Math.floor((buildCost(content, team.raceId, source.defId) * fork.costPermille) / 1000);
}

/** Why this fork can't happen, or null if it can. */
export function forkBlocker(world: World, content: Content, teamId: TeamId, source: Building | undefined, col: number, row: number): string | null {
  const cost = forkCost(world, content, teamId, source);
  if (cost === null) return "can't fork that";
  return canPlace(world, content, teamId, source!.defId, col, row, cost);
}

export function applyFork(ctx: TickContext, command: ForkCommand): string | null {
  const { world, content } = ctx;
  const source = ctx.byId.get(command.sourceId);
  const building = source?.kind === "building" ? source : undefined;
  const reason = forkBlocker(world, content, command.team, building, command.col, command.row);
  if (reason) return reason;
  const team = world.teams[command.team]!;
  team.money -= forkCost(world, content, command.team, building)!;
  const copy = placeBuilding(world, content, team.id, building!.defId, command.col, command.row, false);
  const fork = raceMechanics(content, team).fork!;
  copy.buildRemaining = Math.max(1, Math.floor((content.buildings[copy.defId]!.buildTicks * fork.buildPermille) / 1000));
  ctx.byId.set(copy.id, copy);
  return null;
}

/** Once a second: buildings of races that self-repair mend while nothing is hitting them. */
export function tickRepair(ctx: TickContext): void {
  const { world, content } = ctx;
  if (world.tick % TICK_RATE !== 0) return;
  for (const entity of world.entities) {
    if (entity.kind !== "building" || entity.hp <= 0 || entity.buildRemaining > 0 || entity.hp >= entity.maxHp) continue;
    const team = world.teams[entity.team]!;
    const repair = raceMechanics(content, team).repair;
    if (!repair || world.tick - entity.lastHitTick < repair.quietTicks) continue;
    entity.hp = Math.min(entity.maxHp, entity.hp + Math.max(1, Math.floor((entity.maxHp * repair.permillePerSecond) / 1000)));
  }
}

/** How much less damage this building takes from its region, in permille, and how many neighbours make it. */
export function regionShield(world: World, content: Content, building: Building): { permille: number; neighbors: number } {
  const team = world.teams[building.team]!;
  const region = raceMechanics(content, team).region;
  if (!region || building.buildRemaining > 0) return { permille: 0, neighbors: 0 };
  const reach = region.radiusTiles * TILE;
  let neighbors = 0;
  for (const other of world.entities) {
    if (other === building || other.kind !== "building" || other.team !== building.team || other.hp <= 0 || other.buildRemaining > 0) continue;
    const dx = other.x - building.x;
    const dy = other.y - building.y;
    if (dx * dx + dy * dy <= reach * reach) neighbors += 1;
  }
  return { permille: Math.min(region.maxPermille, neighbors * region.perNeighborPermille), neighbors };
}
