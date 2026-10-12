// The nest's fortress: C2 Servers guarding every gateway up onto the nest's
// plateau, plus a ring around the nest itself. Where they stand is a pure
// function of the terrain (so of the seed): every peer agrees, and nothing
// about it needs to be stored. Every few waves the botnet rebuilds the ones
// you've knocked down, tougher than before.

import type { Content } from "./content";
import { placeBuilding } from "./entities";
import { clusters } from "./terrain/elevation";
import { FORTRESS_RADIUS } from "./terrain/params";
import { TILE_OPEN, TILE_RAMP, type HubSpot, type Terrain, type TilePoint } from "./terrain/tiles";
import type { TeamId, World } from "./types";

/** Diagonal posts around the nest, in tiles from its center. */
const RING = [[-4, -4], [4, -4], [-4, 4], [4, 4]] as const;
/** How far inside a gateway its guard stands, in tiles. */
const GATE_DEPTH = 3;

/** One tile per gateway onto the plateau: the middle of each ramp. */
export function fortressGates(terrain: Terrain): TilePoint[] {
  const { cols, nest } = terrain;
  const cx = nest.col + 1;
  const cy = nest.row + 1;
  const reach = (FORTRESS_RADIUS + 1) * (FORTRESS_RADIUS + 1);
  const ramps: number[] = [];
  for (let i = 0; i < terrain.tiles.length; i += 1) {
    if (terrain.tiles[i] !== TILE_RAMP || terrain.heights[i] !== 2) continue;
    const dx = (i % cols) - cx;
    const dy = Math.floor(i / cols) - cy;
    if (dx * dx + dy * dy <= reach) ramps.push(i);
  }
  return clusters(ramps, cols).map((group) => {
    const middle = group[Math.floor(group.length / 2)]!;
    return { col: middle % cols, row: Math.floor(middle / cols) };
  });
}

/** Where the C2 Servers stand: just inside each gateway, then the ring round the nest. */
export function fortressSpots(terrain: Terrain): TilePoint[] {
  const { cols, rows, nest } = terrain;
  const cx = nest.col + 1;
  const cy = nest.row + 1;
  const taken = new Set<number>();
  // Never on the nest's own footprint or right beside it.
  for (let r = nest.row - 1; r <= nest.row + 2; r += 1) for (let c = nest.col - 1; c <= nest.col + 2; c += 1) taken.add(r * cols + c);
  const free = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < cols && r < rows && terrain.tiles[r * cols + c] === TILE_OPEN && terrain.heights[r * cols + c] === 2 && !taken.has(r * cols + c);
  /** Nearest free plateau tile to (col, row), searched outward in a fixed order. */
  const near = (col: number, row: number): TilePoint | null => {
    for (let d = 0; d <= 4; d += 1) {
      for (let dr = -d; dr <= d; dr += 1) {
        for (let dc = -d; dc <= d; dc += 1) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue;
          if (free(col + dc, row + dr)) return { col: col + dc, row: row + dr };
        }
      }
    }
    return null;
  };
  const spots: TilePoint[] = [];
  const claim = (spot: TilePoint | null) => {
    if (!spot) return;
    spots.push(spot);
    // Leave a gap so towers don't wall each other in.
    for (let r = spot.row - 1; r <= spot.row + 1; r += 1) for (let c = spot.col - 1; c <= spot.col + 1; c += 1) taken.add(r * cols + c);
  };
  for (const gate of fortressGates(terrain)) {
    const dx = cx - gate.col;
    const dy = cy - gate.row;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    claim(near(Math.round(gate.col + (dx / length) * GATE_DEPTH), Math.round(gate.row + (dy / length) * GATE_DEPTH)));
  }
  for (const [dc, dr] of RING) claim(near(cx + dc, cy + dr));
  return spots;
}

/** Where a hub's squatting C2 Servers go, around a ring a few tiles out. Pure function of the terrain. */
const HUB_POSTS = [[3, -1], [-2, 2], [1, -2], [-2, -1], [3, 2], [0, 3]] as const;

export function hubGuardSpots(terrain: Terrain, hub: HubSpot, count: number): TilePoint[] {
  const { cols, rows } = terrain;
  const taken = new Set<number>();
  // Never on the hub or right beside it: you have to be able to stand there.
  for (let r = hub.row - 1; r <= hub.row + 2; r += 1) for (let c = hub.col - 1; c <= hub.col + 2; c += 1) taken.add(r * cols + c);
  const free = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && terrain.tiles[r * cols + c] === TILE_OPEN && !taken.has(r * cols + c);
  const spots: TilePoint[] = [];
  for (const [dc, dr] of HUB_POSTS) {
    if (spots.length >= count) break;
    const col = hub.col + dc;
    const row = hub.row + dr;
    let found: TilePoint | null = null;
    for (let d = 0; d <= 2 && !found; d += 1) {
      for (let er = -d; er <= d && !found; er += 1) {
        for (let ec = -d; ec <= d && !found; ec += 1) {
          if (Math.max(Math.abs(ec), Math.abs(er)) === d && free(col + ec, row + er)) found = { col: col + ec, row: row + er };
        }
      }
    }
    if (!found) continue;
    spots.push(found);
    for (let r = found.row - 1; r <= found.row + 1; r += 1) for (let c = found.col - 1; c <= found.col + 1; c += 1) taken.add(r * cols + c);
  }
  return spots;
}

/**
 * Put up every missing C2 Server, with hp scaled for this wave the way creeps
 * are: the nest's fortress, and the guards on every hub nobody holds (the
 * botnet squats on users nobody is serving). Returns how many went up.
 */
export function fortify(world: World, content: Content, team: TeamId, wave: number): number {
  const { building, hpGrowthPerWave } = content.waves.fortress;
  const scale = 1 + hpGrowthPerWave * (wave - 1);
  let built = 0;
  const spots = [...fortressSpots(world.terrain)];
  world.terrain.hubs.forEach((hub, i) => {
    if (world.hubs[i]?.owner === -1) spots.push(...hubGuardSpots(world.terrain, hub, content.economy.hubs.guards[hub.size]));
  });
  for (const spot of spots) {
    const standing = world.entities.some(
      (e) => e.kind === "building" && e.team === team && e.defId === building && e.col === spot.col && e.row === spot.row && e.hp > 0,
    );
    if (standing) continue;
    const tower = placeBuilding(world, content, team, building, spot.col, spot.row, true);
    tower.maxHp = Math.round(tower.maxHp * scale);
    tower.hp = tower.maxHp;
    built += 1;
  }
  return built;
}
