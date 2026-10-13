// The "routes" layout: a map with structure instead of pure noise. The web
// starts solid and gets carved:
//
// - the fortress in the middle and a roomy base at every start;
// - a highway from the nest out to each start, winding a little, wide
//   enough for an army, narrowing to a chokepoint or two on the way;
// - a ring road linking neighbouring starts, so there's more than one way in;
// - side pockets off the highways: walled clearings behind a narrow gap,
//   where an expansion core is safer;
// - rubble in the open areas, so nothing is a flat empty field.
//
// Creeps can only go where the ground is, so the fights happen on the
// highways and at their chokepoints. Everything is drawn from the seed.

import { fbm } from "../noise";
import { randomInt } from "../rng";
import { clearDisc } from "./grid";
import { TILE_BLOCKED, TILE_OPEN, type TilePoint } from "./tiles";

/** Half-width (tiles) of a highway, a chokepoint, and a pocket's entrance. */
const HIGHWAY = 3;
const CHOKE = 1;
const SPUR = 1;
const BASE_RADIUS = 11;
const POCKET_RADIUS = 6;
const POCKETS_PER_ROUTE = 2;

export interface RoutesPlan {
  /** Each highway's waypoints, nest first. */
  highways: TilePoint[][];
  /** Where each highway narrows. */
  chokepoints: TilePoint[];
  pockets: TilePoint[];
}

export function carveRoutes(
  tiles: Uint8Array,
  cols: number,
  rows: number,
  nest: TilePoint,
  starts: TilePoint[],
  fortressClear: number,
  noiseSeed: number,
  rng: { rngState: number },
): RoutesPlan {
  // Solid web, with a solid border.
  tiles.fill(TILE_BLOCKED);
  const center = (p: TilePoint) => ({ col: p.col + 1, row: p.row + 1 });
  const nc = center(nest);

  clearDisc(tiles, cols, rows, nc.col, nc.row, fortressClear);
  for (const s of starts) clearDisc(tiles, cols, rows, s.col + 1, s.row + 1, BASE_RADIUS);

  const plan: RoutesPlan = { highways: [], chokepoints: [], pockets: [] };

  // Highways: nest -> each start, through two jittered waypoints.
  for (const s of starts) {
    const sc = center(s);
    const path = [nc, jitter(nc, sc, 1 / 3, rng), jitter(nc, sc, 2 / 3, rng), sc];
    plan.highways.push(path);
    // One or two chokepoints: a stretch of the route at choke width.
    const chokeSegments = new Set([randomInt(rng, 1, 2)]);
    if (randomInt(rng, 0, 1) === 1) chokeSegments.add(randomInt(rng, 0, 2));
    for (let i = 0; i < path.length - 1; i += 1) {
      const choke = chokeSegments.has(i);
      carveLine(tiles, cols, rows, path[i]!, path[i + 1]!, HIGHWAY, choke ? { from: 0.35, to: 0.65, half: CHOKE } : null);
      if (choke) plan.chokepoints.push(lerp(path[i]!, path[i + 1]!, 0.5));
    }
  }

  // Ring road: each start to the next one round the nest, a little narrower.
  const order = starts
    .map((s, i) => ({ i, a: angleKey(s.col + 1 - nc.col, s.row + 1 - nc.row) }))
    .sort((x, y) => x.a - y.a || x.i - y.i)
    .map((x) => center(starts[x.i]!));
  for (let i = 0; i < order.length; i += 1) {
    const a = order[i]!;
    const b = order[(i + 1) % order.length]!;
    const mid = jitter(a, b, 0.5, rng);
    // Bow the ring road outward, away from the nest, so it isn't a shortcut through the middle.
    const away = { col: mid.col + Math.sign(mid.col - nc.col) * 6, row: mid.row + Math.sign(mid.row - nc.row) * 6 };
    const bowed = clampPoint(away, cols, rows);
    carveLine(tiles, cols, rows, a, bowed, HIGHWAY - 1, null);
    carveLine(tiles, cols, rows, bowed, b, HIGHWAY - 1, null);
  }

  // Side pockets: off a highway's middle stretch, behind a narrow spur.
  for (const path of plan.highways) {
    for (let k = 0; k < POCKETS_PER_ROUTE; k += 1) {
      const seg = randomInt(rng, 1, path.length - 2);
      const at = lerp(path[seg]!, path[seg + 1]!, 0.25 + 0.5 * (randomInt(rng, 0, 100) / 100));
      const dx = path[seg + 1]!.col - path[seg]!.col;
      const dy = path[seg + 1]!.row - path[seg]!.row;
      const length = Math.sqrt(dx * dx + dy * dy) || 1;
      const side = randomInt(rng, 0, 1) === 0 ? 1 : -1;
      const reach = HIGHWAY + POCKET_RADIUS + 6;
      const pocket = clampPoint({ col: Math.round(at.col - (dy / length) * reach * side), row: Math.round(at.row + (dx / length) * reach * side) }, cols, rows);
      clearDisc(tiles, cols, rows, pocket.col, pocket.row, POCKET_RADIUS);
      carveLine(tiles, cols, rows, at, pocket, SPUR, null);
      plan.pockets.push(pocket);
    }
  }

  // Rubble: break up the open ground, away from the highways' centre lines.
  const lanes = new Uint8Array(tiles.length);
  for (const path of plan.highways) for (let i = 0; i < path.length - 1; i += 1) markLine(lanes, cols, rows, path[i]!, path[i + 1]!, HIGHWAY - 1);
  for (const s of starts) markDisc(lanes, cols, rows, s.col + 1, s.row + 1, 7);
  markDisc(lanes, cols, rows, nc.col, nc.row, fortressClear);
  for (let row = 1; row < rows - 1; row += 1) {
    for (let col = 1; col < cols - 1; col += 1) {
      const i = row * cols + col;
      if (tiles[i] !== TILE_OPEN || lanes[i]) continue;
      if (fbm(col * 2.1, row * 2.1, noiseSeed + 31) > 0.68) tiles[i] = TILE_BLOCKED;
    }
  }
  // The map's frame stays solid.
  for (let col = 0; col < cols; col += 1) {
    tiles[col] = TILE_BLOCKED;
    tiles[(rows - 1) * cols + col] = TILE_BLOCKED;
  }
  for (let row = 0; row < rows; row += 1) {
    tiles[row * cols] = TILE_BLOCKED;
    tiles[row * cols + cols - 1] = TILE_BLOCKED;
  }
  return plan;
}

function lerp(a: TilePoint, b: TilePoint, t: number): TilePoint {
  return { col: Math.round(a.col + (b.col - a.col) * t), row: Math.round(a.row + (b.row - a.row) * t) };
}

/** A point `t` of the way from a to b, pushed sideways by up to a fifth of the distance. */
function jitter(a: TilePoint, b: TilePoint, t: number, rng: { rngState: number }): TilePoint {
  const dx = b.col - a.col;
  const dy = b.row - a.row;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  const push = (randomInt(rng, -100, 100) / 100) * (length / 5);
  const p = lerp(a, b, t);
  return { col: Math.round(p.col - (dy / length) * push), row: Math.round(p.row + (dx / length) * push) };
}

function clampPoint(p: TilePoint, cols: number, rows: number): TilePoint {
  return { col: Math.min(cols - 8, Math.max(7, p.col)), row: Math.min(rows - 8, Math.max(7, p.row)) };
}

/** A sortable stand-in for the angle of (dx, dy): no trig in the sim. */
function angleKey(dx: number, dy: number): number {
  const s = Math.abs(dx) + Math.abs(dy) || 1;
  const t = dx / s;
  return dy >= 0 ? 1 - t : 3 + t;
}

/** Carve a line `half` tiles either side; between `narrow.from` and `.to` of the way, only `narrow.half`. */
function carveLine(
  tiles: Uint8Array,
  cols: number,
  rows: number,
  a: TilePoint,
  b: TilePoint,
  half: number,
  narrow: { from: number; to: number; half: number } | null,
): void {
  const steps = Math.max(Math.abs(b.col - a.col), Math.abs(b.row - a.row), 1);
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const h = narrow && t >= narrow.from && t <= narrow.to ? narrow.half : half;
    const col = Math.round(a.col + (b.col - a.col) * t);
    const row = Math.round(a.row + (b.row - a.row) * t);
    clearDisc(tiles, cols, rows, col, row, h);
  }
}

function markLine(mask: Uint8Array, cols: number, rows: number, a: TilePoint, b: TilePoint, half: number): void {
  const steps = Math.max(Math.abs(b.col - a.col), Math.abs(b.row - a.row), 1);
  for (let i = 0; i <= steps; i += 1) {
    const col = Math.round(a.col + ((b.col - a.col) * i) / steps);
    const row = Math.round(a.row + ((b.row - a.row) * i) / steps);
    markDisc(mask, cols, rows, col, row, half);
  }
}

function markDisc(mask: Uint8Array, cols: number, rows: number, cx: number, cy: number, r: number): void {
  for (let row = cy - r; row <= cy + r; row += 1) {
    for (let col = cx - r; col <= cx + r; col += 1) {
      if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
      if ((col - cx) * (col - cx) + (row - cy) * (row - cy) <= r * r) mask[row * cols + col] = 1;
    }
  }
}
