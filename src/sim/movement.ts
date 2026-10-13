// Getting from here to there. One rule for everyone who walks to a place:
// straight when the way is clear for their body, otherwise downhill on a
// flow field toward the goal tile. Fields are cached per goal tile, so any
// number of units heading to the same spot share one search.

import { TILE } from "./map";
import { flowField, hasClearPath, moveToward, nextStep } from "./nav";
import type { Point, Unit, World } from "./types";
import { terrainFor } from "./walls";

/**
 * Fields kept at once. Each is a full-map array, and player orders can point
 * anywhere, so the oldest are dropped. Safe for determinism: a field is a
 * pure function of the terrain and its goal, so recomputing it gives the
 * same answer.
 */
const MAX_FIELDS = 96;

/** Flow field toward a goal tile, for a team (its gates open) or for everyone. */
export function goalField(world: World, goalTile: number, team?: number): Int32Array {
  const goals = world.nav.goals;
  const view = team === undefined ? { key: 0, terrain: world.terrain } : terrainFor(world, team);
  const key = view.key * world.terrain.tiles.length + goalTile;
  let field = goals.get(key);
  if (field) {
    // Most recently used goes to the back.
    goals.delete(key);
    goals.set(key, field);
    return field;
  }
  field = flowField(view.terrain, [goalTile]);
  goals.set(key, field);
  if (goals.size > MAX_FIELDS) goals.delete(goals.keys().next().value!);
  return field;
}

/** Take one step of `speed` toward `goal`, routing around terrain. */
export function walkTo(world: World, unit: Unit, goal: Point, speed: number): void {
  const { terrain } = terrainFor(world, unit.team);
  if (hasClearPath(terrain, unit.x, unit.y, goal.x, goal.y, unit.radius)) {
    moveToward(terrain, unit, goal.x, goal.y, speed);
    return;
  }
  const tile = Math.floor(goal.y / TILE) * terrain.cols + Math.floor(goal.x / TILE);
  const waypoint = nextStep(terrain, goalField(world, tile, unit.team), unit.x, unit.y);
  moveToward(terrain, unit, (waypoint ?? goal).x, (waypoint ?? goal).y, speed);
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
