// Scatter data wells and roam points over reachable open ground.

import { randomInt } from "../rng";
import { RESOURCE_COUNT, ROAM_POINT_COUNT, ROAM_POINT_SPACING } from "./params";
import { TILE_OPEN, type TilePoint } from "./tiles";

/** Spread-out reachable points, anywhere but right on top of the start. */
export function scatterRoamPoints(
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

export function scatterResources(
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
