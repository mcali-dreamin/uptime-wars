import type { Content } from "./content";
import type { Entity, World } from "./types";

/** Everything a system needs during one tick. */
export interface TickContext {
  world: World;
  content: Content;
  byId: Map<number, Entity>;
  /**
   * Living entities bucketed by GRID_CELL-sized cells, built once per tick
   * from start-of-tick positions in id order. Target searches only look at
   * nearby cells instead of every entity on the map.
   */
  grid: Map<number, Entity[]>;
}

export const GRID_CELL = 256;
export const GRID_STRIDE = 1 << 16;

export function makeContext(world: World, content: Content): TickContext {
  return { world, content, byId: new Map(world.entities.map((entity) => [entity.id, entity])), grid: new Map() };
}

export function buildGrid(entities: Entity[]): Map<number, Entity[]> {
  const grid = new Map<number, Entity[]>();
  for (const entity of entities) {
    if (entity.hp <= 0) continue;
    const key = Math.floor(entity.y / GRID_CELL) * GRID_STRIDE + Math.floor(entity.x / GRID_CELL);
    const cell = grid.get(key);
    if (cell) cell.push(entity);
    else grid.set(key, [entity]);
  }
  return grid;
}
