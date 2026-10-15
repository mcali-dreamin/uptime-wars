// Navigation on the tile grid.
//
// A flow field is one Dijkstra pass outward from a goal: every tile learns its
// cost-to-goal, and any number of units just step downhill. One field per
// goal serves the whole horde, which is what makes hundreds of units cheap.
//
// Integer costs and a fixed neighbor order keep it deterministic.

import { TILE } from "./map";
import { TILE_BLOCKED, isWalkableTile, tileAt, type Terrain } from "./terrain";

export const ORTHOGONAL = 10;
const DIAGONAL = 14;

// N, E, S, W, then diagonals. Order is part of determinism.
const NEIGHBORS = [
  [0, -1, ORTHOGONAL],
  [1, 0, ORTHOGONAL],
  [0, 1, ORTHOGONAL],
  [-1, 0, ORTHOGONAL],
  [1, -1, DIAGONAL],
  [1, 1, DIAGONAL],
  [-1, 1, DIAGONAL],
  [-1, -1, DIAGONAL],
] as const;

export const UNREACHABLE = -1;

/** A diagonal step may not cut the corner of a blocked tile. */
function canStep(terrain: Terrain, col: number, row: number, dc: number, dr: number): boolean {
  if (!isWalkableTile(terrain, col + dc, row + dr)) return false;
  if (dc !== 0 && dr !== 0) {
    return isWalkableTile(terrain, col + dc, row) && isWalkableTile(terrain, col, row + dr);
  }
  return true;
}

/**
 * Cost-to-goal for every tile. `goals` are tile indices. A goal under a
 * building (its own tiles are blocked) means the ground around that building,
 * so you can walk to a building, not only past it.
 */
export function flowField(terrain: Terrain, goals: number[]): Int32Array {
  const { cols, rows } = terrain;
  const walk = walkMask(terrain);
  const dist = new Int32Array(walk.length).fill(UNREACHABLE);
  // Dijkstra on a bucket queue: steps cost 10 or 14, so DIAGONAL + 1 buckets
  // in a ring hold everything still to visit (Dial's algorithm). Distances
  // come out exactly as a heap would give them.
  const buckets: number[][] = Array.from({ length: DIAGONAL + 1 }, () => []);
  let pending = 0;
  for (const goal of [...new Set(goals.flatMap((g) => aroundBuilt(terrain, g)))].sort((a, b) => a - b)) {
    if (dist[goal] === 0) continue;
    dist[goal] = 0;
    buckets[0]!.push(goal);
    pending += 1;
  }
  for (let d = 0; pending > 0; d += 1) {
    const bucket = buckets[d % buckets.length]!;
    for (let k = 0; k < bucket.length; k += 1) {
      const i = bucket[k]!;
      pending -= 1;
      if (dist[i] !== d) continue;
      const col = i % cols;
      const row = (i - col) / cols;
      for (const [dc, dr, step] of NEIGHBORS) {
        // Reverse search: we move from goal outward, so check the step from the
        // neighbor back into this tile.
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const n = r * cols + c;
        if (!walk[n]) continue;
        if (dc !== 0 && dr !== 0 && (!walk[row * cols + c] || !walk[r * cols + col])) continue;
        const cost = d + step;
        if (dist[n] === UNREACHABLE || cost < dist[n]!) {
          dist[n] = cost;
          buckets[cost % buckets.length]!.push(n);
          pending += 1;
        }
      }
    }
    bucket.length = 0;
  }
  return dist;
}

/** Walkable (1) or not, per tile. Cached per overlay: a new overlay is a new array. */
const masks = new WeakMap<object, Uint8Array>();
function walkMask(terrain: Terrain): Uint8Array {
  const key = terrain.built ?? terrain.tiles;
  let mask = masks.get(key);
  if (mask && mask.length === terrain.tiles.length) return mask;
  mask = new Uint8Array(terrain.tiles.length);
  for (let row = 0; row < terrain.rows; row += 1) {
    for (let col = 0; col < terrain.cols; col += 1) {
      if (isWalkableTile(terrain, col, row)) mask[row * terrain.cols + col] = 1;
    }
  }
  masks.set(key, mask);
  return mask;
}

/**
 * The tile itself, or for a tile under buildings, the walkable tiles touching
 * that block of buildings (buildings side by side count as one).
 */
function aroundBuilt(terrain: Terrain, tile: number): number[] {
  const { cols, rows, built } = terrain;
  if (built?.[tile] !== 1) return [tile];
  const seen = new Set([tile]);
  const queue = [tile];
  const edge: number[] = [];
  for (let q = 0; q < queue.length; q += 1) {
    const i = queue[q]!;
    const col = i % cols;
    const row = Math.floor(i / cols);
    for (const [dc, dr] of NEIGHBORS) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const n = r * cols + c;
      if (seen.has(n)) continue;
      seen.add(n);
      if (built[n] === 1) queue.push(n);
      else if (isWalkableTile(terrain, c, r)) edge.push(n);
    }
  }
  return edge.length > 0 ? edge : [tile];
}

/** Center of the next tile downhill from (x, y), or null at the goal / off the field. */
export function nextStep(terrain: Terrain, field: Int32Array, x: number, y: number) {
  const col = Math.floor(x / TILE);
  const row = Math.floor(y / TILE);
  const here = field[row * terrain.cols + col];
  if (here === undefined || here <= 0) return null;
  let best = here;
  let bestCol = -1;
  let bestRow = -1;
  for (const [dc, dr] of NEIGHBORS) {
    if (!canStep(terrain, col, row, dc, dr)) continue;
    const value = field[(row + dr) * terrain.cols + (col + dc)]!;
    if (value !== UNREACHABLE && value < best) {
      best = value;
      bestCol = col + dc;
      bestRow = row + dr;
    }
  }
  if (bestCol < 0) return null;
  return { x: (bestCol + 0.5) * TILE, y: (bestRow + 0.5) * TILE };
}

export function isWalkablePoint(terrain: Terrain, x: number, y: number): boolean {
  return isWalkableTile(terrain, Math.floor(x / TILE), Math.floor(y / TILE));
}

/**
 * True when a body of radius `r` fits at (x, y): its center and four edge
 * points are all on walkable tiles. The edges use 80% of the radius so the
 * largest units still fit through one-tile corridors.
 */
export function bodyFits(terrain: Terrain, x: number, y: number, r: number): boolean {
  const e = r * 0.8;
  return (
    isWalkablePoint(terrain, x, y) &&
    isWalkablePoint(terrain, x + e, y) &&
    isWalkablePoint(terrain, x - e, y) &&
    isWalkablePoint(terrain, x, y + e) &&
    isWalkablePoint(terrain, x, y - e)
  );
}

/**
 * The nearest spot to (x, y) where a body of radius `r` fits, searching
 * outward in half-tile rings up to `maxTiles` away; null if there's none.
 * Order is fixed, so peers agree.
 */
export function nearestFit(terrain: Terrain, x: number, y: number, r: number, maxTiles = 8): { x: number; y: number } | null {
  if (bodyFits(terrain, x, y, r)) return { x, y };
  const half = TILE / 2;
  for (let ring = 1; ring <= maxTiles * 2; ring += 1) {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let i = -ring; i <= ring; i += 1) {
      for (const [ox, oy] of [[i, -ring], [ring, i], [-i, ring], [-ring, -i]] as const) {
        const px = x + ox * half;
        const py = y + oy * half;
        const d = ox * ox + oy * oy;
        if (d < bestD && bodyFits(terrain, px, py, r)) {
          best = { x: px, y: py };
          bestD = d;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** True when no blocked tile lies on the segment. Samples every quarter tile. */
export function hasLineOfSight(terrain: Terrain, x1: number, y1: number, x2: number, y2: number): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  const samples = Math.ceil(length / (TILE / 4));
  for (let i = 1; i < samples; i += 1) {
    const t = i / samples;
    if (tileAt(terrain, Math.floor((x1 + dx * t) / TILE), Math.floor((y1 + dy * t) / TILE)) === TILE_BLOCKED) {
      return false;
    }
  }
  return true;
}

/**
 * True when a body of radius `r` can walk the straight segment without
 * touching a wall or cliff: the center line and both edge lines are clear.
 * Seeing a target is not the same as being able to walk straight at it.
 */
export function hasClearPath(terrain: Terrain, x1: number, y1: number, x2: number, y2: number, r: number): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return true;
  const ox = (-dy / length) * r * 0.8;
  const oy = (dx / length) * r * 0.8;
  return (
    walkableLine(terrain, x1, y1, x2, y2) &&
    walkableLine(terrain, x1 + ox, y1 + oy, x2 + ox, y2 + oy) &&
    walkableLine(terrain, x1 - ox, y1 - oy, x2 - ox, y2 - oy)
  );
}

/**
 * True when every quarter-tile sample on the segment is walkable. Unlike
 * hasLineOfSight, cliffs count: you can see across a cliff, not walk it.
 */
function walkableLine(terrain: Terrain, x1: number, y1: number, x2: number, y2: number): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  const samples = Math.ceil(length / (TILE / 4));
  for (let i = 1; i < samples; i += 1) {
    const t = i / samples;
    if (!isWalkableTile(terrain, Math.floor((x1 + dx * t) / TILE), Math.floor((y1 + dy * t) / TILE))) return false;
  }
  return true;
}

/**
 * Move a body toward (tx, ty) by up to `stride`, sliding along walls rather
 * than stopping dead. Slow terrain halves the stride. Mutates `mover`.
 */
export function moveToward(
  terrain: Terrain,
  mover: { x: number; y: number; radius: number },
  tx: number,
  ty: number,
  stride: number,
): void {
  const dx = tx - mover.x;
  const dy = ty - mover.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length <= 0) return;
  const step = Math.min(length, stride);
  const nx = mover.x + (dx / length) * step;
  const ny = mover.y + (dy / length) * step;
  const r = mover.radius;
  if (bodyFits(terrain, nx, ny, r)) {
    mover.x = nx;
    mover.y = ny;
  } else if (bodyFits(terrain, nx, mover.y, r)) {
    mover.x = nx;
  } else if (bodyFits(terrain, mover.x, ny, r)) {
    mover.y = ny;
  } else if (!bodyFits(terrain, mover.x, mover.y, r) && isWalkablePoint(terrain, nx, ny)) {
    // Already wedged against a wall (spawned tight): let the center through
    // so the body can work itself free instead of freezing.
    mover.x = nx;
    mover.y = ny;
  }
}
