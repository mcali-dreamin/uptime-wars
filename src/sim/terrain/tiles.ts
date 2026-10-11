// Procedural terrain: a fresh patch of the open web for every match, derived
// entirely from the match seed. Peers never exchange map data; they generate
// the same map locally.
//
// - Dead links (blocked): impassable, unbuildable.
// - Data swamps (slow): walkable at half speed, unbuildable.
// - Data wells (resource): walkable, unbuildable. Economy hooks in later.
// - Cliffs: the high edge of a plateau. Impassable and unbuildable, but you
//   can see and shoot across them.
// - Ramps ("gateways"): the only way between height levels.
//
// Heights: 0 deep web, 1 surface web, 2 backbone. Invariant (tested): two
// walkable neighbors that aren't ramps always share a height, so the only way
// up or down is a ramp.

export const TILE_OPEN = 0;
export const TILE_BLOCKED = 1;
export const TILE_SLOW = 2;
export const TILE_RESOURCE = 3;
export const TILE_CLIFF = 4;
export const TILE_RAMP = 5;

export interface TilePoint {
  col: number;
  row: number;
}

export interface Terrain {
  cols: number;
  rows: number;
  /** Row-major tile types. */
  tiles: Uint8Array;
  /** Row-major height level per tile: 0, 1, or 2. */
  heights: Uint8Array;
  /**
   * Top-left tile of each player's 2x2 core, MAX_PLAYERS of them, spread
   * around the nest. Player n starts at starts[n]. Every map has all of them,
   * whoever plays it, so the map stays a function of the seed alone.
   */
  starts: TilePoint[];
  /** Top-left tile of the creep nest's 2x2 footprint. */
  nest: TilePoint;
  resources: TilePoint[];
  /** Places wandering creeps drift between. Each gets its own flow field. */
  roamPoints: TilePoint[];
}

export function tileAt(terrain: Terrain, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= terrain.cols || row >= terrain.rows) return TILE_BLOCKED;
  return terrain.tiles[row * terrain.cols + col]!;
}

export const walls = (tile: number | undefined) => tile === TILE_BLOCKED || tile === TILE_CLIFF;

export function isWalkableTile(terrain: Terrain, col: number, row: number): boolean {
  return !walls(tileAt(terrain, col, row));
}

export function heightAtTile(terrain: Terrain, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= terrain.cols || row >= terrain.rows) return 0;
  return terrain.heights[row * terrain.cols + col]!;
}
