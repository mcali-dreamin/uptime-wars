// Generate a map from a seed: walls and swamps from noise, nest in the
// middle, starts out toward the edge, everything reachable, then height,
// wells, and roam points.

import { MAP_COLS, MAP_ROWS } from "../map";
import { fbm } from "../noise";
import { randomInt } from "../rng";
import { raiseTerrain } from "./elevation";
import { bfs, clearDisc } from "./grid";
import {
  BLOCK_THRESHOLD,
  MAX_PLAYERS,
  NEST_CLEAR_RADIUS,
  SLOW_THRESHOLD,
  START_CLEAR_RADIUS,
  START_MIN_FROM_NEST,
  START_SPACING,
} from "./params";
import { scatterResources, scatterRoamPoints } from "./scatter";
import { TILE_BLOCKED, TILE_OPEN, TILE_RESOURCE, TILE_SLOW, type Terrain, type TilePoint } from "./tiles";

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

  // The nest sits in the middle of the web. Players start out toward the
  // edge, far from it and from each other.
  const nest = { col: Math.floor(cols / 2) - 1, row: Math.floor(rows / 2) - 1 };
  const starts = pickStarts(cols, rows, nest, rng);
  const start = starts[0]!;
  clearDisc(tiles, cols, rows, nest.col + 1, nest.row + 1, NEST_CLEAR_RADIUS);
  for (const s of starts) clearDisc(tiles, cols, rows, s.col + 1, s.row + 1, START_CLEAR_RADIUS);

  // The nest and every start must be reachable on foot from the first start;
  // if the noise walled one off, carve a winding-free corridor to the nest.
  let dist = bfs(tiles, cols, rows, start);
  if (dist[nest.row * cols + nest.col]! < 0) {
    carveCorridor(tiles, cols, rows, start, nest);
    dist = bfs(tiles, cols, rows, start);
  }
  for (const s of starts) {
    if (dist[s.row * cols + s.col]! >= 0) continue;
    carveCorridor(tiles, cols, rows, s, nest);
    dist = bfs(tiles, cols, rows, start);
  }
  // Everything else must be reachable too: wall off isolated pockets.
  for (let i = 0; i < tiles.length; i += 1) {
    if (tiles[i] !== TILE_BLOCKED && dist[i]! < 0) tiles[i] = TILE_BLOCKED;
  }

  const heights = raiseTerrain(tiles, cols, rows, starts, nest, noiseSeed, rng);

  dist = bfs(tiles, cols, rows, start);
  const resources = scatterResources(tiles, cols, rows, dist, starts, nest, rng);
  for (const point of resources) tiles[point.row * cols + point.col] = TILE_RESOURCE;
  const roamPoints = scatterRoamPoints(tiles, cols, rows, dist, starts, rng);

  return { cols, rows, tiles, heights, starts, nest, resources, roamPoints };
}

/**
 * MAX_PLAYERS start tiles near the edge: each at least START_MIN_FROM_NEST of
 * the half-diagonal from the nest, and START_SPACING of it from every other
 * start. If a map can't fit that, the spacing relaxes until it does.
 */
function pickStarts(cols: number, rows: number, nest: TilePoint, rng: { rngState: number }): TilePoint[] {
  const halfDiagonal = Math.sqrt((cols / 2) * (cols / 2) + (rows / 2) * (rows / 2));
  const fromNest = halfDiagonal * START_MIN_FROM_NEST;
  const starts: TilePoint[] = [];
  let spacing = halfDiagonal * START_SPACING;
  while (starts.length < MAX_PLAYERS) {
    let placed = false;
    for (let attempt = 0; attempt < 1000 && !placed; attempt += 1) {
      const point = { col: randomInt(rng, 8, cols - 10), row: randomInt(rng, 8, rows - 10) };
      if (!apart(point, nest, fromNest)) continue;
      if (!starts.every((other) => apart(point, other, spacing))) continue;
      starts.push(point);
      placed = true;
    }
    if (!placed) spacing = Math.floor(spacing * 0.8);
  }
  return starts;
}

function apart(a: TilePoint, b: TilePoint, min: number): boolean {
  const dc = a.col - b.col;
  const dr = a.row - b.row;
  return dc * dc + dr * dr >= min * min;
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
