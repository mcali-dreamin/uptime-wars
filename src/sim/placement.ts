// "Can I build here?" rules. Shared by the sim and the placement preview so
// they never disagree.

import type { Content } from "./content";
import { TILE, footprintCenter } from "./map";
import { TILE_OPEN, tileAt } from "./terrain";
import type { Building, Entity, Team, TeamId, World } from "./types";

export function buildCost(content: Content, raceId: string, buildingId: string): number {
  return Math.round(content.buildings[buildingId]!.cost * content.races[raceId]!.modifiers.costMultiplier);
}

export function isOccupied(world: World, col: number, row: number, footprint: number): boolean {
  return world.entities.some(
    (entity) =>
      entity.kind === "building" &&
      entity.hp > 0 &&
      col < entity.col + entity.footprint &&
      col + footprint > entity.col &&
      row < entity.row + entity.footprint &&
      row + footprint > entity.row,
  );
}

function footprintIsOpen(world: World, col: number, row: number, footprint: number): boolean {
  for (let r = row; r < row + footprint; r += 1) {
    for (let c = col; c < col + footprint; c += 1) {
      if (tileAt(world.terrain, c, r) !== TILE_OPEN) return false;
    }
  }
  return true;
}

/** Why a building can't go here, or null when it can. */
export function canPlace(
  world: World,
  content: Content,
  teamId: TeamId,
  buildingId: string,
  col: number,
  row: number,
): string | null {
  const team = world.teams[teamId];
  const race = content.races[team.raceId]!;
  const def = content.buildings[buildingId];
  if (!def || !race.buildings.includes(buildingId)) return "not in this race's roster";
  if (!footprintIsOpen(world, col, row, def.footprint)) return "terrain is not buildable";

  if (team.coreId === -1) return "no core";
  const center = footprintCenter(col, row, def.footprint);
  if (!inNetwork(world, content, teamId, center.x, center.y)) return "outside your network";

  if (isOccupied(world, col, row, def.footprint)) return "tile occupied";
  if (team.compute < buildCost(content, team.raceId, buildingId)) return "not enough compute";
  return null;
}

/** Why a core can't be founded on this footprint, or null when it can. */
export function canFound(world: World, content: Content, teamId: TeamId, col: number, row: number): string | null {
  const team = world.teams[teamId];
  if (team.coreId !== -1) return "core already online";
  const def = content.buildings[content.races[team.raceId]!.core]!;
  if (!footprintIsOpen(world, col, row, def.footprint)) return "terrain is not buildable";
  if (isOccupied(world, col, row, def.footprint)) return "tile occupied";
  return null;
}

/** Is this one of the team's cores (the building its race depends on)? */
export function isCore(content: Content, team: Team, entity: Entity | undefined): boolean {
  return entity?.kind === "building" && entity.team === team.id && entity.defId === content.races[team.raceId]!.core;
}

/** Your finished buildings that extend where you may build. */
export function networkProviders(world: World, content: Content, teamId: TeamId): Building[] {
  return world.entities.filter(
    (entity): entity is Building =>
      entity.kind === "building" &&
      entity.team === teamId &&
      entity.hp > 0 &&
      entity.buildRemaining === 0 &&
      (content.buildings[entity.defId]!.buildRadius ?? 0) > 0,
  );
}

/** Whether a point is inside any of the team's build radii. */
export function inNetwork(world: World, content: Content, teamId: TeamId, x: number, y: number): boolean {
  return networkProviders(world, content, teamId).some((provider) => {
    const reach = content.buildings[provider.defId]!.buildRadius! * TILE;
    const dx = x - provider.x;
    const dy = y - provider.y;
    return dx * dx + dy * dy <= reach * reach;
  });
}
