// Give the map height: levels, cliffs, and ramps.

import { fbm } from "../noise";
import { randomInt } from "../rng";
import { bfs, flattenDisc, neighbors4 } from "./grid";
import {
  EXTRA_RAMPS,
  FORTRESS_GATES,
  FORTRESS_RADIUS,
  GATE_SPACING,
  MOAT_WIDTH,
  HEIGHT_HIGH,
  HEIGHT_MID,
  HEIGHT_SCALE,
  NEST_CLEAR_RADIUS,
  RAMP_SPACING,
  START_CLEAR_RADIUS,
} from "./params";
import { TILE_CLIFF, TILE_OPEN, TILE_RAMP, TILE_SLOW, walls, type TilePoint } from "./tiles";

/**
 * Give the map height: levels from a slow noise layer, cliffs on the high
 * side of every change in level, then ramps until everything is reachable
 * again, plus a few more so plateaus have more than one way in.
 * Mutates `tiles`; returns the heights.
 */
export function raiseTerrain(
  tiles: Uint8Array,
  cols: number,
  rows: number,
  starts: TilePoint[],
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
  // Every start and the nest each sit on one flat patch.
  for (const start of starts) flattenDisc(heights, cols, rows, start.col + 1, start.row + 1, START_CLEAR_RADIUS + 2);
  flattenDisc(heights, cols, rows, nest.col + 1, nest.row + 1, NEST_CLEAR_RADIUS + 2);
  raiseFortress(heights, cols, rows, nest);

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
  const reached = bfs(tiles, cols, rows, starts[0]!);
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
  addGates(tiles, heights, cols, rows, nest, rng);
  return heights;
}

/** The nest's fortress: a backbone plateau ringed by a lower moat, so its rim is a cliff all the way round. */
function raiseFortress(heights: Uint8Array, cols: number, rows: number, nest: TilePoint): void {
  const cx = nest.col + 1;
  const cy = nest.row + 1;
  const outer = FORTRESS_RADIUS + MOAT_WIDTH;
  for (let row = cy - outer; row <= cy + outer; row += 1) {
    for (let col = cx - outer; col <= cx + outer; col += 1) {
      if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
      const dx = col - cx;
      const dy = row - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= FORTRESS_RADIUS * FORTRESS_RADIUS) heights[row * cols + col] = 2;
      else if (d2 <= outer * outer) heights[row * cols + col] = 1;
    }
  }
}

/** Make sure the fortress has at least FORTRESS_GATES spaced-out ramps onto it. */
function addGates(tiles: Uint8Array, heights: Uint8Array, cols: number, rows: number, nest: TilePoint, rng: { rngState: number }): void {
  const cx = nest.col + 1;
  const cy = nest.row + 1;
  const onRim = (i: number) => {
    const dx = (i % cols) - cx;
    const dy = Math.floor(i / cols) - cy;
    const d2 = dx * dx + dy * dy;
    return d2 >= (FORTRESS_RADIUS - 1) * (FORTRESS_RADIUS - 1) && d2 <= (FORTRESS_RADIUS + 1) * (FORTRESS_RADIUS + 1);
  };
  const gates: number[] = [];
  for (let i = 0; i < tiles.length; i += 1) if (tiles[i] === TILE_RAMP && heights[i] === 2 && onRim(i)) gates.push(i);
  const spaced = (i: number) =>
    gates.every((g) => {
      const dc = (g % cols) - (i % cols);
      const dr = Math.floor(g / cols) - Math.floor(i / cols);
      return dc * dc + dr * dr >= GATE_SPACING * GATE_SPACING;
    });
  const candidates: number[] = [];
  for (let i = 0; i < tiles.length; i += 1) {
    if (tiles[i] === TILE_CLIFF && heights[i] === 2 && onRim(i) && isSlope(tiles, heights, i, cols, rows)) candidates.push(i);
  }
  const count = () => clusters(gates, cols).length;
  for (let attempt = 0; count() < FORTRESS_GATES && attempt < 400 && candidates.length > 0; attempt += 1) {
    const pick = candidates[randomInt(rng, 0, candidates.length - 1)]!;
    if (tiles[pick] !== TILE_CLIFF || !spaced(pick)) continue;
    gates.push(...makeRamp(tiles, heights, pick, cols, rows));
  }
}

/** Group tile indices into 4-connected clusters (a ramp is three tiles wide). */
export function clusters(indices: number[], cols: number): number[][] {
  const set = new Set(indices);
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const start of [...indices].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const group: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      group.push(i);
      for (const n of [i - 1, i + 1, i - cols, i + cols]) {
        if (set.has(n) && !seen.has(n) && (n === i - 1 || n === i + 1 ? Math.floor(n / cols) === Math.floor(i / cols) : true)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    out.push(group.sort((a, b) => a - b));
  }
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
