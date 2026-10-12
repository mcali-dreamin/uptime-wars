// How the map looks. Three height levels read as three floor shades (the
// higher, the lighter); cliffs are dark with a bright lip on the drop side;
// ramps are striped; dead links are light slabs with a bright outline.

import type { Graphics } from "pixi.js";
import { TILE_BLOCKED, TILE_CLIFF, TILE_RAMP, type Terrain } from "../../sim";
import { CLIFF_LIP, DEAD_LINK_EDGE, RAMP_STRIPE, tileColor } from "../palette";

/**
 * Fill every tile, run-length merged per row by color so a 320x180 map is a
 * few thousand rects, not fifty thousand.
 */
export function drawTerrainBase(g: Graphics, terrain: Terrain, cell: number): void {
  const { cols, rows, tiles, heights } = terrain;
  for (let row = 0; row < rows; row += 1) {
    let col = 0;
    while (col < cols) {
      const i = row * cols + col;
      const color = tileColor(tiles[i]!, heights[i]!);
      let end = col + 1;
      while (end < cols && tileColor(tiles[row * cols + end]!, heights[row * cols + end]!) === color) end += 1;
      g.rect(col * cell, row * cell, (end - col) * cell, cell).fill({ color });
      col = end;
    }
  }
}

/** Edges and stripes. Only worth drawing at full size. */
export function drawTerrainDetail(g: Graphics, terrain: Terrain, cell: number): void {
  const { cols, rows, tiles, heights } = terrain;
  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? TILE_BLOCKED : tiles[r * cols + c]!);
  const h = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? 0 : heights[r * cols + c]!);
  const sides = [
    [0, -1, 0, 0, 1, 0],
    [0, 1, 0, 1, 1, 1],
    [-1, 0, 0, 0, 0, 1],
    [1, 0, 1, 0, 1, 1],
  ] as const;

  // Dead links: a bright outline where they meet anything else.
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (at(col, row) !== TILE_BLOCKED) continue;
      for (const [dc, dr, x1, y1, x2, y2] of sides) {
        if (at(col + dc, row + dr) === TILE_BLOCKED) continue;
        g.moveTo((col + x1) * cell, (row + y1) * cell).lineTo((col + x2) * cell, (row + y2) * cell);
      }
    }
  }
  g.stroke({ width: 2, color: DEAD_LINK_EDGE, alpha: 0.9 });

  // Cliffs: a bright lip on each side that drops to lower ground.
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (at(col, row) !== TILE_CLIFF) continue;
      for (const [dc, dr, x1, y1, x2, y2] of sides) {
        const next = at(col + dc, row + dr);
        if (next === TILE_BLOCKED || next === TILE_CLIFF || h(col + dc, row + dr) >= h(col, row)) continue;
        g.moveTo((col + x1) * cell, (row + y1) * cell).lineTo((col + x2) * cell, (row + y2) * cell);
      }
    }
  }
  g.stroke({ width: 3, color: CLIFF_LIP, alpha: 0.85 });

  // Ramps: diagonal stripes.
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (at(col, row) !== TILE_RAMP) continue;
      const x = col * cell;
      const y = row * cell;
      for (let k = 0.25; k < 1; k += 0.25) g.moveTo(x + k * cell, y).lineTo(x, y + k * cell);
      for (let k = 0.25; k < 1; k += 0.25) g.moveTo(x + cell, y + k * cell).lineTo(x + k * cell, y + cell);
    }
  }
  g.stroke({ width: 2, color: RAMP_STRIPE, alpha: 0.9 });
}
