// Getting from here to there. One rule for everyone who walks to a place:
// straight when the way is clear for their body, otherwise downhill on a
// flow field toward the goal tile. Fields are cached per goal tile, so any
// number of units heading to the same spot share one search.

import { TILE } from "./map";
import { ORDER_SPREAD_MAX } from "./tuning";
import { bodyFits, flowField, hasClearPath, isWalkablePoint, moveToward, nextStep } from "./nav";
import type { Point, Unit, World } from "./types";
import type { Terrain } from "./terrain";
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

/**
 * How close to home a unit routes on its own tile's field instead of its
 * order's shared anchor. Beyond the widest order spread, so reaching the
 * anchor always means being this close.
 */
const ANCHOR_NEAR = ORDER_SPREAD_MAX * 2 + 2 * TILE;

/** Take one step of `speed` toward `goal`, routing around terrain. */
export function walkTo(world: World, unit: Unit, goal: Point, speed: number): void {
  const { terrain } = terrainFor(world, unit.team);
  if (hasClearPath(terrain, unit.x, unit.y, goal.x, goal.y, unit.radius)) {
    moveToward(terrain, unit, goal.x, goal.y, speed);
    return;
  }
  let tile = Math.floor(goal.y / TILE) * terrain.cols + Math.floor(goal.x / TILE);
  if (unit.homeAnchor !== undefined && goal.x === unit.homeX && goal.y === unit.homeY) {
    // Far from home: walk the order's shared field. Close: switch to its own
    // tile for good (no flip-flopping back if that route bends away).
    if (distance(unit, goal) > ANCHOR_NEAR) tile = unit.homeAnchor;
    else unit.homeAnchor = undefined;
  }
  const field = goalField(world, tile, unit.team);
  const waypoint = nextStep(terrain, field, unit.x, unit.y);
  const aim = waypoint && tile === unit.homeAnchor ? spreadWaypoint(terrain, field, unit, waypoint, tile) : waypoint;
  moveToward(terrain, unit, (aim ?? goal).x, (aim ?? goal).y, speed);
}

/** Most a marching unit strays sideways from the shared route, per axis. */
const MARCH_OFFSET_MAX = 2.5 * TILE;

/**
 * Keep a marching unit's offset from the shared route so an order travels as
 * a column, not a line. The unit follows the field as if standing at its
 * position minus its offset (its place on the route), then aims at that
 * step plus the offset: a translated copy of the route. Wherever the copy
 * doesn't fit or can't be walked straight to, it uses the plain waypoint, so
 * chokepoints still squeeze single file.
 */
function spreadWaypoint(terrain: Terrain, field: Int32Array, unit: Unit, waypoint: Point, anchor: number): Point {
  const cx = ((anchor % terrain.cols) + 0.5) * TILE;
  const cy = (Math.floor(anchor / terrain.cols) + 0.5) * TILE;
  const dx = Math.max(-MARCH_OFFSET_MAX, Math.min(MARCH_OFFSET_MAX, unit.homeX - cx));
  const dy = Math.max(-MARCH_OFFSET_MAX, Math.min(MARCH_OFFSET_MAX, unit.homeY - cy));
  if (!isWalkablePoint(terrain, unit.x - dx, unit.y - dy)) return waypoint;
  const route = nextStep(terrain, field, unit.x - dx, unit.y - dy);
  if (!route) return waypoint;
  const x = route.x + dx;
  const y = route.y + dy;
  if (!bodyFits(terrain, x, y, unit.radius) || !hasClearPath(terrain, unit.x, unit.y, x, y, unit.radius)) return waypoint;
  // Only ever aim downhill of where the unit stands, so mixing this with the
  // plain waypoint can't make it dither between two routes.
  const at = (px: number, py: number) => field[Math.floor(py / TILE) * terrain.cols + Math.floor(px / TILE)]!;
  if (at(x, y) >= at(unit.x, unit.y)) return waypoint;
  return { x, y };
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
