// The one map. Two sides of a single wide lane, each with a core and a
// build zone. Team 0 holds the left, team 1 the right.

export const TICK_RATE = 20;
export const TILE = 40;
export const COLS = 40;
export const ROWS = 22;
export const WIDTH = COLS * TILE;
export const HEIGHT = ROWS * TILE;

export interface Zone {
  colMin: number;
  colMax: number;
  rowMin: number;
  rowMax: number;
}

export interface SideLayout {
  /** +1 attacks to the right, -1 to the left. */
  direction: 1 | -1;
  core: { col: number; row: number };
  buildZone: Zone;
}

export const SIDES: [SideLayout, SideLayout] = [
  {
    direction: 1,
    core: { col: 1, row: 10 },
    buildZone: { colMin: 3, colMax: 10, rowMin: 1, rowMax: 20 },
  },
  {
    direction: -1,
    core: { col: 37, row: 10 },
    buildZone: { colMin: 29, colMax: 36, rowMin: 1, rowMax: 20 },
  },
];

export function inZone(zone: Zone, col: number, row: number, footprint: number): boolean {
  return (
    col >= zone.colMin &&
    row >= zone.rowMin &&
    col + footprint - 1 <= zone.colMax &&
    row + footprint - 1 <= zone.rowMax
  );
}

export function footprintCenter(col: number, row: number, footprint: number) {
  return {
    x: (col + footprint / 2) * TILE,
    y: (row + footprint / 2) * TILE,
  };
}
