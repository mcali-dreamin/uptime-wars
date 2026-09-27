// Map-wide constants. The map itself is generated per match from the seed
// (see terrain.ts); nothing here describes a fixed layout.

export const TICK_RATE = 20;
export const TILE = 32;
export const MAP_COLS = 176;
export const MAP_ROWS = 100;
/** How far from your core (in tiles, center to center) you may build. */
export const BUILD_RADIUS_TILES = 9;

export function footprintCenter(col: number, row: number, footprint: number) {
  return {
    x: (col + footprint / 2) * TILE,
    y: (row + footprint / 2) * TILE,
  };
}
