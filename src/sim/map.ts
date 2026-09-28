// Map-wide constants. The map itself is generated per match from the seed
// (see terrain.ts); nothing here describes a fixed layout.

export const TICK_RATE = 20;
export const TILE = 48;
// 15360 x 8640 px: four 1920x1080 screens from the center to each edge.
export const MAP_COLS = 320;
export const MAP_ROWS = 180;

export function footprintCenter(col: number, row: number, footprint: number) {
  return {
    x: (col + footprint / 2) * TILE,
    y: (row + footprint / 2) * TILE,
  };
}
