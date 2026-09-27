// Procedural terrain: a fresh patch of the open web for every match, derived
// entirely from the match seed. Peers never exchange map data; they generate
// the same map locally.
//
// - Dead links (blocked): impassable, unbuildable.
// - Data swamps (slow): walkable at half speed, unbuildable.
// - Data wells (resource): walkable, unbuildable. Economy hooks in later.

import { MAP_COLS, MAP_ROWS } from "./map";
import { fbm } from "./noise";
import { randomInt } from "./rng";

export const TILE_OPEN = 0;
export const TILE_BLOCKED = 1;
export const TILE_SLOW = 2;
export const TILE_RESOURCE = 3;

const BLOCK_THRESHOLD = 0.64;
const SLOW_THRESHOLD = 0.34;
const START_CLEAR_RADIUS = 5;
const NEST_CLEAR_RADIUS = 3;
const RESOURCE_COUNT = 40;
const ROAM_POINT_COUNT = 24;
const ROAM_POINT_SPACING = 14;
/** The nest is at least this fraction of the map width away in a straight line. */
const NEST_MIN_STRAIGHT_FRACTION = 0.45;

export interface TilePoint {
  col: number;
  row: number;
}

export interface Terrain {
  cols: number;
  rows: number;
  /** Row-major tile types. */
  tiles: Uint8Array;
  /** Top-left tile of the player's 2x2 core. */
  start: TilePoint;
  /** Top-left tile of the creep nest's 2x2 footprint. */
  nest: TilePoint;
  resources: TilePoint[];
  /** Places wandering creeps drift between. Each gets its own flow field. */
  roamPoints: TilePoint[];
}

export function tileAt(terrain: Terrain, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= terrain.cols || row >= terrain.rows) return TILE_BLOCKED;
  return terrain.tiles[row * terrain.cols + col]!;
}

export function isWalkableTile(terrain: Terrain, col: number, row: number): boolean {
  return tileAt(terrain, col, row) !== TILE_BLOCKED;
}

export function generateTerrain(seed: number, cols = MAP_COLS, rows = MAP_ROWS): Terrain {
  // Separate stream from the match RNG so terrain never shifts gameplay rolls.
  const rng = { rngState: (seed ^ 0x5bd1e995) | 0 };
  const noiseSeed = randomInt(rng, 0, 0x7fffffff);
  const tiles = new Uint8Array(cols * rows);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const border = col === 0 || row === 0 || col === cols - 1 || row === rows - 1;
      const n = fbm(col, row, noiseSeed);
      tiles[row * cols + col] = border
        ? TILE_BLOCKED
        : n > BLOCK_THRESHOLD
          ? TILE_BLOCKED
          : n < SLOW_THRESHOLD
            ? TILE_SLOW
            : TILE_OPEN;
    }
  }

  const start = {
    col: randomInt(rng, 6, Math.floor(cols / 3)),
    row: randomInt(rng, 6, rows - 8),
  };
  clearDisc(tiles, cols, rows, start.col + 1, start.row + 1, START_CLEAR_RADIUS);

  // Everything must be reachable from the start: wall off isolated pockets.
  let dist = bfs(tiles, cols, rows, start);
  for (let i = 0; i < tiles.length; i += 1) {
    if (tiles[i] !== TILE_BLOCKED && dist[i]! < 0) tiles[i] = TILE_BLOCKED;
  }

  // The nest goes somewhere far away both on foot and as the crow flies, so
  // it is always off-screen and the creeps have a real journey.
  let maxDist = 0;
  for (const d of dist) if (d > maxDist) maxDist = d;
  const minStraight = cols * NEST_MIN_STRAIGHT_FRACTION;
  const inside = (col: number, row: number) => col >= 3 && row >= 3 && col <= cols - 5 && row <= rows - 5;
  const straight = (i: number) => {
    const dc = (i % cols) - start.col;
    const dr = Math.floor(i / cols) - start.row;
    return Math.sqrt(dc * dc + dr * dr);
  };
  let candidates: number[] = [];
  for (let walk = 0.75; walk >= 0.3 && candidates.length === 0; walk -= 0.15) {
    for (let i = 0; i < dist.length; i += 1) {
      if (dist[i]! >= maxDist * walk && inside(i % cols, Math.floor(i / cols)) && straight(i) >= minStraight) {
        candidates.push(i);
      }
    }
  }
  if (candidates.length === 0) {
    // Tiny or maze-like maps: take the reachable tile furthest in a straight line.
    let best = -1;
    for (let i = 0; i < dist.length; i += 1) {
      if (dist[i]! >= 0 && inside(i % cols, Math.floor(i / cols)) && (best < 0 || straight(i) > straight(best))) best = i;
    }
    candidates = [best];
  }
  const nestIndex = candidates[randomInt(rng, 0, candidates.length - 1)]!;
  const nest = { col: nestIndex % cols, row: Math.floor(nestIndex / cols) };
  clearDisc(tiles, cols, rows, nest.col + 1, nest.row + 1, NEST_CLEAR_RADIUS);

  dist = bfs(tiles, cols, rows, start);
  const resources = scatterResources(tiles, cols, rows, dist, start, nest, rng);
  for (const point of resources) tiles[point.row * cols + point.col] = TILE_RESOURCE;
  const roamPoints = scatterRoamPoints(tiles, cols, rows, dist, start, rng);

  return { cols, rows, tiles, start, nest, resources, roamPoints };
}

/** Spread-out reachable points, anywhere but right on top of the start. */
function scatterRoamPoints(
  tiles: Uint8Array,
  cols: number,
  rows: number,
  dist: Int32Array,
  start: TilePoint,
  rng: { rngState: number },
): TilePoint[] {
  const points: TilePoint[] = [];
  const far = (a: TilePoint, b: TilePoint, min: number) => {
    const dx = a.col - b.col;
    const dy = a.row - b.row;
    return dx * dx + dy * dy >= min * min;
  };
  for (let attempt = 0; attempt < 4000 && points.length < ROAM_POINT_COUNT; attempt += 1) {
    const point = { col: randomInt(rng, 2, cols - 3), row: randomInt(rng, 2, rows - 3) };
    const i = point.row * cols + point.col;
    if (tiles[i] !== TILE_OPEN || dist[i]! < 0) continue;
    if (!far(point, start, 8)) continue;
    if (!points.every((other) => far(point, other, ROAM_POINT_SPACING))) continue;
    points.push(point);
  }
  return points;
}

function clearDisc(tiles: Uint8Array, cols: number, rows: number, cx: number, cy: number, radius: number) {
  for (let row = cy - radius; row <= cy + radius; row += 1) {
    for (let col = cx - radius; col <= cx + radius; col += 1) {
      if (col <= 0 || row <= 0 || col >= cols - 1 || row >= rows - 1) continue;
      const dx = col - cx;
      const dy = row - cy;
      if (dx * dx + dy * dy <= radius * radius) tiles[row * cols + col] = TILE_OPEN;
    }
  }
}

/** 4-connected walking distance in tiles from `from`; -1 where unreachable. */
function bfs(tiles: Uint8Array, cols: number, rows: number, from: TilePoint): Int32Array {
  const dist = new Int32Array(tiles.length).fill(-1);
  const queue = new Int32Array(tiles.length);
  let head = 0;
  let tail = 0;
  const origin = from.row * cols + from.col;
  dist[origin] = 0;
  queue[tail++] = origin;
  while (head < tail) {
    const i = queue[head++]!;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const neighbors = [
      [col, row - 1],
      [col + 1, row],
      [col, row + 1],
      [col - 1, row],
    ] as const;
    for (const [nc, nr] of neighbors) {
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const n = nr * cols + nc;
      if (dist[n]! >= 0 || tiles[n] === TILE_BLOCKED) continue;
      dist[n] = dist[i]! + 1;
      queue[tail++] = n;
    }
  }
  return dist;
}

function scatterResources(
  tiles: Uint8Array,
  cols: number,
  rows: number,
  dist: Int32Array,
  start: TilePoint,
  nest: TilePoint,
  rng: { rngState: number },
): TilePoint[] {
  const placed: TilePoint[] = [];
  const far = (a: TilePoint, b: TilePoint, min: number) => {
    const dx = a.col - b.col;
    const dy = a.row - b.row;
    return dx * dx + dy * dy >= min * min;
  };
  const tryPlace = (minFromStart: number, maxFromStart: number) => {
    // Sample near the start when the band is tight, anywhere otherwise.
    const local = maxFromStart < 100;
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const point = local
        ? {
            col: randomInt(rng, Math.max(1, start.col - maxFromStart), Math.min(cols - 2, start.col + maxFromStart)),
            row: randomInt(rng, Math.max(1, start.row - maxFromStart), Math.min(rows - 2, start.row + maxFromStart)),
          }
        : { col: randomInt(rng, 1, cols - 2), row: randomInt(rng, 1, rows - 2) };
      const i = point.row * cols + point.col;
      if (tiles[i] !== TILE_OPEN || dist[i]! < 0) continue;
      if (!far(point, start, minFromStart) || far(point, start, maxFromStart)) continue;
      if (!far(point, nest, 6)) continue;
      if (!placed.every((other) => far(point, other, 6))) continue;
      placed.push(point);
      return;
    }
  };
  // Two wells within reach of every start, the rest anywhere.
  tryPlace(7, 14);
  tryPlace(7, 14);
  while (placed.length < RESOURCE_COUNT) {
    const before = placed.length;
    tryPlace(7, 10_000);
    if (placed.length === before) break;
  }
  return placed;
}
