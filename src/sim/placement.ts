// "Can I build here?" rules. Shared by the sim and the placement preview so
// they never disagree.

import type { Content } from "./content";
import { TILE, footprintCenter } from "./map";
import { allied } from "./teams";
import { TILE_OPEN, tileAt, walls } from "./terrain";
import type { Building, Entity, Point, Team, TeamId, World } from "./types";
import { unitInTheWay } from "./walls";
import { pastLimit, raceModifiers, tierBlocker, tierDef } from "./tiers";
import { bonus } from "./upgrades";
import { EXPANSION_CLEARANCE, NOTCH_TILES } from "./tuning";

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

/**
 * What the next one costs: each one you already own adds costGrowthPermille,
 * and each one past a soft top-tier limit adds pastLimitGrowthPermille more.
 */
export function buildCost(world: World, content: Content, teamId: TeamId, buildingId: string): number {
  const team = world.teams[teamId]!;
  const def = content.buildings[buildingId]!;
  const growth = def.costGrowthPermille ?? content.economy.costGrowthPermille ?? 0;
  const base = baseCost(content, team.raceId, buildingId);
  const have = owned(world, teamId, buildingId);
  const past = pastLimit(content, team, buildingId, have, finishedCores(world, content, team)) * (def.pastLimitGrowthPermille ?? 0);
  return Math.round((base * (1000 + growth * have + past)) / 1000);
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
  const locked = tierBlocker(content, team, buildingId, have, finishedCores(world, content, team));
  if (locked) return locked;
  if (def.blocks && unitInTheWay(world, col, row, def.footprint)) return "a unit is in the way";
  if (team.money < cost) return "not enough $";
  // Last: the only check that searches the whole map.
  if (!def.blocks && sealsOff(world, content, col, row, def.footprint)) return "would wall in ground: leave a way through";
  return null;
}

const openCache = new WeakMap<World, { key: string; open: Uint8Array }>();

/**
 * Ground nothing stands on (walls and gates left out: they're how you close
 * a gap). Rebuilt only when the buildings standing change: placement checks
 * run for every spot a player hovers or a computer considers.
 */
function openGround(world: World, content: Content): Uint8Array {
  let key = "";
  for (const e of world.entities) {
    if (e.kind === "building" && e.hp > 0 && !content.buildings[e.defId]?.blocks) key += `${e.id},`;
  }
  const cached = openCache.get(world);
  if (cached && cached.key === key) return cached.open;
  const { terrain } = world;
  const { cols } = terrain;
  const open = new Uint8Array(terrain.tiles.length);
  for (let i = 0; i < open.length; i += 1) if (!walls(terrain.tiles[i])) open[i] = 1;
  for (const e of world.entities) {
    if (e.kind !== "building" || e.hp <= 0 || content.buildings[e.defId]?.blocks) continue;
    for (let r = e.row; r < e.row + e.footprint; r += 1) for (let c = e.col; c < e.col + e.footprint; c += 1) open[r * cols + c] = 0;
  }
  openCache.set(world, { key, open });
  return open;
}

/**
 * Would a building here cut ground off from the rest of the map? Buildings
 * are solid, so a ring of them would wall in whoever's inside, your own
 * spawns included. Closing a gap is what walls and gates are for: they're
 * left out of the search (and can't seal anything here themselves).
 */
export function sealsOff(world: World, content: Content, col: number, row: number, footprint: number): boolean {
  const { cols, rows } = world.terrain;
  const open = openGround(world, content).slice();
  for (let r = row; r < row + footprint; r += 1) for (let c = col; c < col + footprint; c += 1) open[r * cols + c] = 0;
  // The ground right round the footprint, which the new building could cut off.
  const edge: number[] = [];
  for (let r = row - 1; r <= row + footprint; r += 1) {
    for (let c = col - 1; c <= col + footprint; c += 1) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      if (open[r * cols + c]) edge.push(r * cols + c);
    }
  }
  // Ground on each side gets flooded. A notch of a few tiles against a cliff
  // is fine to close off (nobody's in it); anything bigger on two sides of
  // the building means it would cut real ground in two.
  const seen = new Uint8Array(cols * rows);
  const flood = (start: number, limit: number): number[] => {
    const tiles = [start];
    seen[start] = 1;
    for (let q = 0; q < tiles.length && tiles.length <= limit; q += 1) {
      const i = tiles[q]!;
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
          tiles.push(n);
        }
      }
    }
    return tiles;
  };
  const big: number[] = [];
  for (const start of edge) {
    if (seen[start]) continue;
    const pocket = flood(start, NOTCH_TILES);
    if (pocket.length > NOTCH_TILES) {
      big.push(start);
      continue;
    }
    // A notch: only fine to close if nobody is standing in it.
    const inside = new Set(pocket);
    if (world.entities.some((e) => e.kind === "unit" && e.hp > 0 && inside.has(Math.floor(e.y / TILE) * cols + Math.floor(e.x / TILE)))) return true;
  }
  if (big.length <= 1) return false;
  // Two or more big pieces of ground touch the footprint: are they still one?
  return !stillOne(open, cols, rows, big);
}

/**
 * Do these starting tiles all lie in one connected piece of open ground?
 * Floods from every start at once, a tile each in turn, merging floods that
 * meet. It stops when they're all one (yes) or when one runs out of ground
 * before meeting the rest (no: that piece is cut off). So it costs about the
 * smallest piece, not the whole map: a building closing off a pocket is
 * judged by the pocket.
 */
function stillOne(open: Uint8Array, cols: number, rows: number, starts: number[]): boolean {
  const label = new Int32Array(cols * rows).fill(-1);
  const parent = starts.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  let pieces = starts.length;
  const queues = starts.map((start, i) => {
    if (label[start] !== -1 && root(label[start]!) !== root(i)) {
      parent[root(i)] = root(label[start]!);
      pieces -= 1;
    }
    label[start] = i;
    return { tiles: [start], at: 0 };
  });
  if (pieces === 1) return true;
  for (;;) {
    // A merged flood is out of ground only when every queue in it is.
    const live = new Set<number>();
    for (let i = 0; i < queues.length; i += 1) if (queues[i]!.at < queues[i]!.tiles.length) live.add(root(i));
    for (let i = 0; i < queues.length; i += 1) if (!live.has(root(i))) return false;
    for (let q = 0; q < queues.length; q += 1) {
      const queue = queues[q]!;
      if (queue.at >= queue.tiles.length) continue;
      const i = queue.tiles[queue.at]!;
      queue.at += 1;
      const c = i % cols;
      const r = (i - c) / cols;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const nc = c + dc;
          const nr = r + dr;
          if ((dc === 0 && dr === 0) || nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const n = nr * cols + nc;
          // Diagonals can't cut a corner, the same as walking.
          if (!open[n] || (dc !== 0 && dr !== 0 && (!open[r * cols + nc] || !open[nr * cols + c]))) continue;
          const other = label[n]!;
          if (other === -1) {
            label[n] = q;
            queue.tiles.push(n);
          } else if (root(other) !== root(q)) {
            parent[root(other)] = root(q);
            pieces -= 1;
            if (pieces === 1) return true;
          }
        }
      }
    }
  }
}

/**
 * Why a core can't be founded on this footprint, or null when it can. Before
 * the first core, any open ground goes. After, an expansion: it needs an
 * alive deploy agent, and no hostile building (nest, farm, node, enemy core)
 * within EXPANSION_CLEARANCE tiles, but it may sit anywhere open on the map.
 */
export function canFound(world: World, content: Content, teamId: TeamId, col: number, row: number): string | null {
  const team = world.teams[teamId]!;
  const def = content.buildings[content.races[team.raceId]!.core]!;
  if (!footprintIsOpen(world, col, row, def.footprint)) return "terrain is not buildable";
  if (isOccupied(world, col, row, def.footprint)) return "tile occupied";
  if (team.coreId === -1) return null;
  const agent = world.entities.find((e) => e.id === team.builderId);
  if (!agent || agent.kind !== "unit" || agent.hp <= 0) return "no deploy agent";
  const center = footprintCenter(col, row, def.footprint);
  const clear = EXPANSION_CLEARANCE * TILE;
  const tooClose = world.entities.some((e) => {
    if (e.kind !== "building" || e.hp <= 0 || allied(world, e.team, teamId)) return false;
    const dx = e.x - center.x;
    const dy = e.y - center.y;
    return dx * dx + dy * dy <= clear * clear;
  });
  if (tooClose) return "too close to hostiles";
  return null;
}

/** Is this one of the team's cores (the building its race depends on)? */
export function isCore(content: Content, team: Team, entity: Entity | undefined): boolean {
  return entity?.kind === "building" && entity.team === team.id && entity.defId === content.races[team.raceId]!.core;
}

/** The team's living, finished cores, in id order (an expansion under construction doesn't count). */
export function finishedCores(world: World, content: Content, team: Team): number {
  return teamCores(world, content, team).filter((core) => core.buildRemaining === 0).length;
}

/** The live core nearest this building (euclidean, ties to the lower id), or undefined. */
export function homeCore(world: World, content: Content, building: Building): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const core of teamCores(world, content, world.teams[building.team]!)) {
    if (core.buildRemaining > 0) continue;
    const dx = core.x - building.x;
    const dy = core.y - building.y;
    const d = dx * dx + dy * dy;
    if (d < bestD || (d === bestD && core.id < best!.id)) {
      best = core;
      bestD = d;
    }
  }
  return best;
}

/** Where this spawner's units gather: its own rally, else its nearest core's. */
export function rallyFor(world: World, content: Content, building: Building): Point | null {
  return building.rally ?? homeCore(world, content, building)?.rally ?? null;
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
