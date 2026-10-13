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

/** Cost-to-goal for every tile. `goals` are tile indices. */
export function flowField(terrain: Terrain, goals: number[]): Int32Array {
  const { cols } = terrain;
  const dist = new Int32Array(terrain.tiles.length).fill(UNREACHABLE);
  const heap = new MinHeap();
  for (const goal of [...goals].sort((a, b) => a - b)) {
    dist[goal] = 0;
    heap.push(0, goal);
  }
  while (heap.size > 0) {
    const [d, i] = heap.pop();
    if (d > dist[i]!) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    for (const [dc, dr, step] of NEIGHBORS) {
      // Reverse search: we move from goal outward, so check the step from the
      // neighbor back into this tile.
      if (!canStep(terrain, col, row, dc, dr)) continue;
      const n = (row + dr) * cols + (col + dc);
      const cost = d + step;
      if (dist[n] === UNREACHABLE || cost < dist[n]!) {
        dist[n] = cost;
        heap.push(cost, n);
      }
    }
  }
  return dist;
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

/** Binary min-heap of (priority, value), ties broken by value for determinism. */
class MinHeap {
  private readonly priorities: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.values.length;
  }

  push(priority: number, value: number): void {
    this.priorities.push(priority);
    this.values.push(value);
    let i = this.values.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.priorities[0]!, this.values[0]!];
    const lastPriority = this.priorities.pop()!;
    const lastValue = this.values.pop()!;
    if (this.values.length > 0) {
      this.priorities[0] = lastPriority;
      this.values[0] = lastValue;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.values.length && this.less(left, smallest)) smallest = left;
        if (right < this.values.length && this.less(right, smallest)) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    const pa = this.priorities[a]!;
    const pb = this.priorities[b]!;
    return pa < pb || (pa === pb && this.values[a]! < this.values[b]!);
  }

  private swap(a: number, b: number): void {
    [this.priorities[a], this.priorities[b]] = [this.priorities[b]!, this.priorities[a]!];
    [this.values[a], this.values[b]] = [this.values[b]!, this.values[a]!];
  }
}
