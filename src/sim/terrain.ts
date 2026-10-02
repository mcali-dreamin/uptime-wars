// Procedural terrain: a fresh patch of the open web for every match, derived
// entirely from the match seed. Peers never exchange map data; they generate
// the same map locally.
//
// - Dead links (blocked): impassable, unbuildable.
// - Data swamps (slow): walkable at half speed, unbuildable.
// - Data wells (resource): walkable, unbuildable. Economy hooks in later.
// - Cliffs: the high edge of a plateau. Impassable and unbuildable, but you
//   can see and shoot across them.
// - Ramps ("gateways"): the only way between height levels.
//
// Heights: 0 deep web, 1 surface web, 2 backbone. Invariant (tested): two
// walkable neighbors that aren't ramps always share a height, so the only way
// up or down is a ramp.

import { MAP_COLS, MAP_ROWS } from "./map";
import { fbm } from "./noise";
import { randomInt } from "./rng";

export const TILE_OPEN = 0;
export const TILE_BLOCKED = 1;
export const TILE_SLOW = 2;
export const TILE_RESOURCE = 3;
export const TILE_CLIFF = 4;
export const TILE_RAMP = 5;

const BLOCK_THRESHOLD = 0.64;
const SLOW_THRESHOLD = 0.34;
const START_CLEAR_RADIUS = 5;
const NEST_CLEAR_RADIUS = 3;
const RESOURCE_COUNT = 140;
const ROAM_POINT_COUNT = 64;
const ROAM_POINT_SPACING = 24;
/** The start is at least this fraction of the center-to-corner distance from the nest. */
const START_MIN_FROM_NEST = 0.6;
/** Height noise thresholds: above HIGH is backbone, above MID is surface web. */
const HEIGHT_MID = 0.47;
const HEIGHT_HIGH = 0.61;
/** Height features are this many times larger than wall features. */
const HEIGHT_SCALE = 0.45;
/** Beyond the ramps connectivity needs, add this many more, spread out. */
const EXTRA_RAMPS = 110;
const RAMP_SPACING = 10;

export interface TilePoint {
  col: number;
  row: number;
}

export interface Terrain {
  cols: number;
  rows: number;
  /** Row-major tile types. */
  tiles: Uint8Array;
  /** Row-major height level per tile: 0, 1, or 2. */
  heights: Uint8Array;
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

const walls = (tile: number | undefined) => tile === TILE_BLOCKED || tile === TILE_CLIFF;

export function isWalkableTile(terrain: Terrain, col: number, row: number): boolean {
  return !walls(tileAt(terrain, col, row));
}

export function heightAtTile(terrain: Terrain, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= terrain.cols || row >= terrain.rows) return 0;
  return terrain.heights[row * terrain.cols + col]!;
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

  // The nest sits in the middle of the web. You start somewhere out toward
  // the edge, far from it.
  const nest = { col: Math.floor(cols / 2) - 1, row: Math.floor(rows / 2) - 1 };
  const start = pickStart(cols, rows, nest, rng);
  clearDisc(tiles, cols, rows, nest.col + 1, nest.row + 1, NEST_CLEAR_RADIUS);
  clearDisc(tiles, cols, rows, start.col + 1, start.row + 1, START_CLEAR_RADIUS);

  // The nest must be reachable on foot; if the noise walled it off, carve a
  // winding-free corridor from the start to it.
  let dist = bfs(tiles, cols, rows, start);
  if (dist[nest.row * cols + nest.col]! < 0) {
    carveCorridor(tiles, cols, rows, start, nest);
    dist = bfs(tiles, cols, rows, start);
  }
  // Everything else must be reachable too: wall off isolated pockets.
  for (let i = 0; i < tiles.length; i += 1) {
    if (tiles[i] !== TILE_BLOCKED && dist[i]! < 0) tiles[i] = TILE_BLOCKED;
  }

  const heights = raiseTerrain(tiles, cols, rows, start, nest, noiseSeed, rng);

  dist = bfs(tiles, cols, rows, start);
  const resources = scatterResources(tiles, cols, rows, dist, start, nest, rng);
  for (const point of resources) tiles[point.row * cols + point.col] = TILE_RESOURCE;
  const roamPoints = scatterRoamPoints(tiles, cols, rows, dist, start, rng);

  return { cols, rows, tiles, heights, start, nest, resources, roamPoints };
}

/** A start tile near the edge: at least START_MIN_FROM_NEST of the half-diagonal away from the nest. */
function pickStart(cols: number, rows: number, nest: TilePoint, rng: { rngState: number }): TilePoint {
  const halfDiagonal = Math.sqrt((cols / 2) * (cols / 2) + (rows / 2) * (rows / 2));
  const min = halfDiagonal * START_MIN_FROM_NEST;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const point = { col: randomInt(rng, 8, cols - 10), row: randomInt(rng, 8, rows - 10) };
    const dc = point.col - nest.col;
    const dr = point.row - nest.row;
    if (dc * dc + dr * dr >= min * min) return point;
  }
  return { col: 8, row: 8 };
}

/** Straight three-tile-wide corridor between two points (Bresenham-style). */
function carveCorridor(tiles: Uint8Array, cols: number, rows: number, from: TilePoint, to: TilePoint): void {
  const steps = Math.max(Math.abs(to.col - from.col), Math.abs(to.row - from.row));
  for (let i = 0; i <= steps; i += 1) {
    const col = Math.round(from.col + ((to.col - from.col) * i) / steps);
    const row = Math.round(from.row + ((to.row - from.row) * i) / steps);
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const c = col + dc;
        const r = row + dr;
        if (c > 0 && r > 0 && c < cols - 1 && r < rows - 1 && tiles[r * cols + c] === TILE_BLOCKED) {
          tiles[r * cols + c] = TILE_OPEN;
        }
      }
    }
  }
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
      if (dist[n]! >= 0 || walls(tiles[n])) continue;
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

// --- elevation --------------------------------------------------------------

/**
 * Give the map height: levels from a slow noise layer, cliffs on the high
 * side of every change in level, then ramps until everything is reachable
 * again, plus a few more so plateaus have more than one way in.
 * Mutates `tiles`; returns the heights.
 */
function raiseTerrain(
  tiles: Uint8Array,
  cols: number,
  rows: number,
  start: TilePoint,
  nest: TilePoint,
  noiseSeed: number,
  rng: { rngState: number },
): Uint8Array {
  const heights = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const n = fbm(col * HEIGHT_SCALE, row * HEIGHT_SCALE, noiseSeed + 7);
      heights[row * cols + col] = n > HEIGHT_HIGH ? 2 : n > HEIGHT_MID ? 1 : 0;
    }
  }
  // The start and the nest each sit on one flat patch.
  flattenDisc(heights, cols, rows, start.col + 1, start.row + 1, START_CLEAR_RADIUS + 2);
  flattenDisc(heights, cols, rows, nest.col + 1, nest.row + 1, NEST_CLEAR_RADIUS + 2);

  // Cliffs: a walkable tile next to a lower walkable tile is the cliff edge.
  const ground = (t: number | undefined) => t === TILE_OPEN || t === TILE_SLOW;
  const cliffs: number[] = [];
  for (let i = 0; i < tiles.length; i += 1) {
    if (!ground(tiles[i])) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    for (const n of neighbors4(col, row, cols, rows)) {
      if (ground(tiles[n]) && heights[n]! < heights[i]!) {
        cliffs.push(i);
        break;
      }
    }
  }
  for (const i of cliffs) tiles[i] = TILE_CLIFF;

  // Ramps until every walkable tile is reachable from the start again. The
  // reached set grows by flooding out from each new ramp, not by re-searching
  // the whole map.
  const reached = bfs(tiles, cols, rows, start);
  const flood = (seeds: number[]) => {
    const stack = seeds.filter((i) => !walls(tiles[i]));
    for (const i of stack) reached[i] = 0;
    while (stack.length > 0) {
      const i = stack.pop()!;
      for (const n of neighbors4(i % cols, Math.floor(i / cols), cols, rows)) {
        if (reached[n]! >= 0 || walls(tiles[n])) continue;
        reached[n] = 0;
        stack.push(n);
      }
    }
  };
  const ramps: number[] = [];
  for (let guard = 0; guard < 2000; guard += 1) {
    const bridges: number[] = [];
    for (let i = 0; i < tiles.length; i += 1) {
      if (tiles[i] !== TILE_CLIFF) continue;
      const around = neighbors4(i % cols, Math.floor(i / cols), cols, rows);
      const inside = around.some((n) => !walls(tiles[n]) && reached[n]! >= 0);
      const outside = around.some((n) => !walls(tiles[n]) && reached[n]! < 0);
      if (inside && outside) bridges.push(i);
    }
    if (bridges.length === 0) break;
    const slopes = bridges.filter((i) => isSlope(tiles, heights, i, cols, rows));
    const pool = slopes.length > 0 ? slopes : bridges;
    const pick = pool[randomInt(rng, 0, pool.length - 1)]!;
    flood(makeRamp(tiles, heights, pick, cols, rows));
    ramps.push(pick);
  }

  // A few more, so plateaus have several gateways.
  const extras = [];
  for (let i = 0; i < tiles.length; i += 1) {
    if (tiles[i] === TILE_CLIFF && isSlope(tiles, heights, i, cols, rows)) extras.push(i);
  }
  const spaced = (i: number) =>
    ramps.every((r) => {
      const dc = (r % cols) - (i % cols);
      const dr = Math.floor(r / cols) - Math.floor(i / cols);
      return dc * dc + dr * dr >= RAMP_SPACING * RAMP_SPACING;
    });
  for (let added = 0, attempt = 0; added < EXTRA_RAMPS && attempt < 2000 && extras.length > 0; attempt += 1) {
    const pick = extras[randomInt(rng, 0, extras.length - 1)]!;
    if (tiles[pick] !== TILE_CLIFF || !spaced(pick)) continue;
    makeRamp(tiles, heights, pick, cols, rows);
    ramps.push(pick);
    added += 1;
  }
  return heights;
}

function neighbors4(col: number, row: number, cols: number, rows: number): number[] {
  const out: number[] = [];
  if (row > 0) out.push((row - 1) * cols + col);
  if (col < cols - 1) out.push(row * cols + col + 1);
  if (row < rows - 1) out.push((row + 1) * cols + col);
  if (col > 0) out.push(row * cols + col - 1);
  return out;
}

/** A cliff tile with lower ground on one side and its own level on the opposite side. */
function isSlope(tiles: Uint8Array, heights: Uint8Array, i: number, cols: number, rows: number): boolean {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const open = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < cols && r < rows && (tiles[r * cols + c] === TILE_OPEN || tiles[r * cols + c] === TILE_SLOW);
  const h = heights[i]!;
  const pairs = [
    [col, row - 1, col, row + 1],
    [col - 1, row, col + 1, row],
  ] as const;
  for (const [ac, ar, bc, br] of pairs) {
    if (!open(ac, ar) || !open(bc, br)) continue;
    const ha = heights[ar * cols + ac]!;
    const hb = heights[br * cols + bc]!;
    if ((ha < h && hb === h) || (hb < h && ha === h)) return true;
  }
  return false;
}

/** Turn a cliff tile and the cliff tiles beside it along the edge into a 3-wide ramp. Returns the ramp tiles. */
function makeRamp(tiles: Uint8Array, heights: Uint8Array, i: number, cols: number, rows: number): number[] {
  tiles[i] = TILE_RAMP;
  const made = [i];
  const col = i % cols;
  const row = Math.floor(i / cols);
  for (const n of neighbors4(col, row, cols, rows)) {
    if (tiles[n] === TILE_CLIFF && heights[n] === heights[i]) {
      tiles[n] = TILE_RAMP;
      made.push(n);
    }
  }
  return made;
}

function flattenDisc(heights: Uint8Array, cols: number, rows: number, cx: number, cy: number, radius: number) {
  const level = heights[cy * cols + cx]!;
  for (let row = cy - radius; row <= cy + radius; row += 1) {
    for (let col = cx - radius; col <= cx + radius; col += 1) {
      if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
      const dx = col - cx;
      const dy = row - cy;
      if (dx * dx + dy * dy <= radius * radius) heights[row * cols + col] = level;
    }
  }
}
