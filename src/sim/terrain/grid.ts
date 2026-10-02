// Grid helpers shared by the generation passes.

import { TILE_OPEN, walls, type TilePoint } from "./tiles";

export function neighbors4(col: number, row: number, cols: number, rows: number): number[] {
  const out: number[] = [];
  if (row > 0) out.push((row - 1) * cols + col);
  if (col < cols - 1) out.push(row * cols + col + 1);
  if (row < rows - 1) out.push((row + 1) * cols + col);
  if (col > 0) out.push(row * cols + col - 1);
  return out;
}

/** 4-connected walking distance in tiles from `from`; -1 where unreachable. */
export function bfs(tiles: Uint8Array, cols: number, rows: number, from: TilePoint): Int32Array {
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

export function clearDisc(tiles: Uint8Array, cols: number, rows: number, cx: number, cy: number, radius: number) {
  for (let row = cy - radius; row <= cy + radius; row += 1) {
    for (let col = cx - radius; col <= cx + radius; col += 1) {
      if (col <= 0 || row <= 0 || col >= cols - 1 || row >= rows - 1) continue;
      const dx = col - cx;
      const dy = row - cy;
      if (dx * dx + dy * dy <= radius * radius) tiles[row * cols + col] = TILE_OPEN;
    }
  }
}

export function flattenDisc(heights: Uint8Array, cols: number, rows: number, cx: number, cy: number, radius: number) {
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
