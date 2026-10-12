// Scatter roam points over reachable open ground.

import { randomInt } from "../rng";
import { ROAM_POINT_COUNT, ROAM_POINT_SPACING } from "./params";
import { TILE_OPEN, type TilePoint } from "./tiles";

/** Spread-out reachable points, anywhere but right on top of a start. */
export function scatterRoamPoints(
  tiles: Uint8Array,
  cols: number,
  rows: number,
  dist: Int32Array,
  starts: TilePoint[],
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
    if (!starts.every((start) => far(point, start, 8))) continue;
    if (!points.every((other) => far(point, other, ROAM_POINT_SPACING))) continue;
    points.push(point);
  }
  return points;
}
