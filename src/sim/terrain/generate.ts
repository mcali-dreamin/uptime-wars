// Generate a map from a seed: walls and swamps from noise, nest in the
// middle, start out toward the edge, everything reachable, then height,
// wells, and roam points.

import { MAP_COLS, MAP_ROWS } from "../map";
import { fbm } from "../noise";
import { randomInt } from "../rng";
import { raiseTerrain } from "./elevation";
import { bfs, clearDisc } from "./grid";
import { BLOCK_THRESHOLD, NEST_CLEAR_RADIUS, SLOW_THRESHOLD, START_CLEAR_RADIUS, START_MIN_FROM_NEST } from "./params";
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
