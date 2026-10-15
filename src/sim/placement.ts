// "Can I build here?" rules. Shared by the sim and the placement preview so
// they never disagree.

import type { Content } from "./content";
import { TILE, footprintCenter } from "./map";
import { TILE_OPEN, tileAt, walls } from "./terrain";
import type { Building, Entity, Team, TeamId, World } from "./types";
import { unitInTheWay } from "./walls";
import { raceModifiers, tierBlocker, tierDef } from "./tiers";
import { bonus } from "./upgrades";

/** A building's price before any you already own (race modifier applied). */
export function baseCost(content: Content, raceId: string, buildingId: string): number {
  return Math.round(content.buildings[buildingId]!.cost * content.races[raceId]!.modifiers.costMultiplier);
}

/** How many of a building a team has standing (or under construction). */
export function owned(world: World, teamId: TeamId, buildingId: string): number {
  let n = 0;
  for (const e of world.entities) if (e.kind === "building" && e.team === teamId && e.defId === buildingId && e.hp > 0) n += 1;
  return n;
}

/** What the next one costs: each one you already own adds costGrowthPermille. */
export function buildCost(world: World, content: Content, teamId: TeamId, buildingId: string): number {
  const team = world.teams[teamId]!;
  const def = content.buildings[buildingId]!;
  const growth = def.costGrowthPermille ?? content.economy.costGrowthPermille ?? 0;
  const base = baseCost(content, team.raceId, buildingId);
  return Math.round((base * (1000 + growth * owned(world, teamId, buildingId))) / 1000);
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
  cost = buildCost(world, content, teamId, buildingId),
): string | null {
  const team = world.teams[teamId]!;
  const race = content.races[team.raceId]!;
  const def = content.buildings[buildingId];
  if (!def || !race.buildings.includes(buildingId)) return "not in this race's roster";
  if (!footprintIsOpen(world, col, row, def.footprint)) return "terrain is not buildable";

  if (team.coreId === -1) return "no core";
  const center = footprintCenter(col, row, def.footprint);
  if (!inNetwork(world, content, teamId, center.x, center.y)) return "outside your network";

  if (isOccupied(world, col, row, def.footprint)) return "tile occupied";
  const have = world.entities.filter((e) => e.kind === "building" && e.team === teamId && e.defId === buildingId && e.hp > 0).length;
  const locked = tierBlocker(content, team, buildingId, have);
  if (locked) return locked;
  if (def.blocks && unitInTheWay(world, col, row, def.footprint)) return "a unit is in the way";
  if (team.money < cost) return "not enough $";
  // Last: the only check that searches the whole map.
  if (!def.blocks && sealsOff(world, content, col, row, def.footprint)) return "would wall in ground: leave a way through";
  return null;
}

/**
 * Would a building here cut ground off from the rest of the map? Buildings
 * are solid, so a ring of them would wall in whoever's inside, your own
 * spawns included. Closing a gap is what walls and gates are for: they're
 * left out of the search (and can't seal anything here themselves).
 */
export function sealsOff(world: World, content: Content, col: number, row: number, footprint: number): boolean {
  const { terrain } = world;
  const { cols, rows } = terrain;
  const open = new Uint8Array(cols * rows);
  for (let i = 0; i < open.length; i += 1) if (!walls(terrain.tiles[i])) open[i] = 1;
  const fill = (c0: number, r0: number, size: number) => {
    for (let r = r0; r < r0 + size; r += 1) for (let c = c0; c < c0 + size; c += 1) open[r * cols + c] = 0;
  };
  for (const e of world.entities) {
    if (e.kind === "building" && e.hp > 0 && !content.buildings[e.defId]?.blocks) fill(e.col, e.row, e.footprint);
  }
  fill(col, row, footprint);
  // The ground right round the footprint, which the new building could cut off.
  const edge: number[] = [];
  for (let r = row - 1; r <= row + footprint; r += 1) {
    for (let c = col - 1; c <= col + footprint; c += 1) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      if (open[r * cols + c]) edge.push(r * cols + c);
    }
  }
  if (edge.length === 0) return false;
  // Is all of it still one piece of ground with the big open map? Flood from
  // one edge tile; the map's open ground is far bigger than any base.
  const seen = new Uint8Array(cols * rows);
  const queue = [edge[0]!];
  seen[edge[0]!] = 1;
  const need = new Set(edge);
  need.delete(edge[0]!);
  for (let q = 0; q < queue.length && need.size > 0; q += 1) {
    const i = queue[q]!;
    const c = i % cols;
    const r = (i - c) / cols;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const nc = c + dc;
        const nr = r + dr;
        if ((dc === 0 && dr === 0) || nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const n = nr * cols + nc;
        // Diagonals can't cut a corner, the same as walking.
        if (seen[n] || !open[n] || (dc !== 0 && dr !== 0 && (!open[r * cols + nc] || !open[nr * cols + c]))) continue;
        seen[n] = 1;
        need.delete(n);
        queue.push(n);
      }
    }
  }
  return need.size > 0;
}

/** Why a core can't be founded on this footprint, or null when it can. */
export function canFound(world: World, content: Content, teamId: TeamId, col: number, row: number): string | null {
  const team = world.teams[teamId]!;
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

/** Extra tiles a team's cores reach: tier + race (and its earned perks) + research. */
export function coreReachBonus(content: Content, team: Team): number {
  return tierDef(content, team).buildRadius + (raceModifiers(content, team).buildRadiusBonus ?? 0) + bonus(content, team, "buildRadius");
}

/** How far (px) a network building lets its team build. Cores: base + coreReachBonus. */
export function reachOf(world: World, content: Content, provider: Building): number {
  const team = world.teams[provider.team];
  const extra = team && isCore(content, team, provider) ? coreReachBonus(content, team) : 0;
  return (content.buildings[provider.defId]!.buildRadius! + extra) * TILE;
}

/** Whether a point is inside any of the team's build radii. */
export function inNetwork(world: World, content: Content, teamId: TeamId, x: number, y: number): boolean {
  return networkProviders(world, content, teamId).some((provider) => {
    const reach = reachOf(world, content, provider);
    const dx = x - provider.x;
    const dy = y - provider.y;
    return dx * dx + dy * dy <= reach * reach;
  });
}

/** The team's living cores, in id order. */
export function teamCores(world: World, content: Content, team: Team): Building[] {
  return world.entities.filter((e): e is Building => e.kind === "building" && e.hp > 0 && isCore(content, team, e));
}
