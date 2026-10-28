// Creeps: wander with the pack, sense traffic, fight what they see.
//
// A pack's destination is either a roam point (aimless, ambling) or a point
// it sensed traffic from (marching). Each pack decides from where it stands;
// there is no shared knowledge of where anyone lives.

import type { TickContext } from "../context";
import { trafficRadius } from "../economy";
import { TILE } from "../map";
import { distance, goalField } from "../movement";
import { hasClearPath, moveToward, nextStep } from "../nav";
import { teamCores } from "../placement";
import { nextRandom, randomInt } from "../rng";
import { hostile } from "../teams";
import { PACK_SPREAD, REROUTE_TICKS, ROAM_SPEED, SENSED_ARRIVAL } from "../tuning";
import type { Point, Unit, World } from "../types";
import type { Behavior } from "./index";
import { engage } from "./engage";
import { tickScanner } from "../roles";
import { terrainFor } from "../walls";
import { isWalkableTile } from "../terrain";

/** Flanking: packs further than this from their target swing out by up to FLANK_PUSH px. */
const FLANK_MIN_DISTANCE = 1400;
const FLANK_PUSH = 900;

type Destination = number | Point;

export const roam: Behavior = (ctx, unit, def, state) => {
  if (def.role?.kind === "scanner") tickScanner(ctx, unit, def.role);
  if (engage(ctx, unit, def)) return;
  // Aimless packs amble; packs that sensed traffic march.
  const marching = typeof ctx.world.waves.packs[unit.packId] === "object";
  wander(ctx, unit, state.leaders.get(unit.packId), def.speed * (marching ? 1 : ROAM_SPEED));
};

/** Follow the pack: straggle back to the leader, else walk the pack's route. */
function wander(ctx: TickContext, unit: Unit, leader: Unit | undefined, speed: number): void {
  const { world } = ctx;
  const { terrain } = terrainFor(world, unit.team);
  if (terrain.roamPoints.length === 0) return;

  if (leader && leader !== unit && distance(unit, leader) > PACK_SPREAD) {
    if (hasClearPath(terrain, unit.x, unit.y, leader.x, leader.y, unit.radius)) {
      moveToward(terrain, unit, leader.x, leader.y, speed * 1.3);
      return;
    }
  }

  let destination = world.waves.packs[unit.packId];
  // Every so often a pack wandering a roam route reconsiders; that's when it
  // can pick up traffic it couldn't before. Only the leader decides, and the
  // offset spreads packs out so they don't all reroute on the same tick.
  const rethink =
    typeof destination === "number" && leader === unit && (world.tick + unit.packId * 37) % REROUTE_TICKS === 0;
  // A pack closing on a base takes its flanking waypoint first.
  const flank = world.waves.approach?.[unit.packId];
  if (flank && typeof destination === "object") {
    const step = stepToward(world, unit, flank);
    if (step) {
      moveToward(terrain, unit, step.x, step.y, speed);
      return;
    }
    // Reached it (the leader decides for the pack): straight in from here.
    if (leader === unit || !leader) delete world.waves.approach![unit.packId];
  }
  let waypoint = destination === undefined || rethink ? null : stepToward(world, unit, destination);
  if (!waypoint) {
    // Arrived, or new pack: decide where to go next.
    const retaliating = world.waves.retaliation?.[unit.packId];
    const nest = { x: (world.terrain.nest.col + 0.5) * TILE, y: (world.terrain.nest.row + 0.5) * TILE };
    const goingHome = typeof destination === "object" && destination.x === nest.x && destination.y === nest.y;
    if (retaliating && !goingHome) {
      // Hit the attackers at the farm, then head back to the nest.
      destination = nest;
      world.waves.packs[unit.packId] = nest;
      if (world.waves.approach) delete world.waves.approach[unit.packId];
      const home = stepToward(world, unit, nest);
      if (home) moveToward(terrain, unit, home.x, home.y, speed);
      return;
    }
    if (retaliating) delete world.waves.retaliation![unit.packId];
    destination = pickDestination(ctx, unit);
    world.waves.packs[unit.packId] = destination;
    if (world.waves.approach) delete world.waves.approach[unit.packId];
    if (typeof destination === "object") {
      const side = flankFor(world, unit, destination);
      if (side) (world.waves.approach ??= {})[unit.packId] = side;
    }
    waypoint = stepToward(world, unit, destination);
  }
  if (waypoint) moveToward(terrain, unit, waypoint.x, waypoint.y, speed);
}

/**
 * Where a pack goes next: usually toward the nearest core whose traffic it
 * can sense, otherwise drifting outward from the nest.
 */
function pickDestination(ctx: TickContext, unit: Unit): Destination {
  const { world, content } = ctx;
  if (nextRandom(world) < content.economy.traffic.pullChance) {
    let best: Point | null = null;
    let bestGap = Infinity;
    for (const team of world.teams) {
      if (!hostile(world, team.id, unit.team)) continue;
      const radius = trafficRadius(world, content, team);
      if (radius <= 0) continue;
      for (const core of teamCores(world, content, team)) {
        const d = distance(unit, core);
        if (d <= radius && d < bestGap) {
          best = { x: core.x, y: core.y };
          bestGap = d;
        }
      }
    }
    if (best) return best;
  }
  return pickRoamPoint(world);
}

/** Drift outward: a roam point's chance grows with its distance from the nest. */
function pickRoamPoint(world: World): number {
  const { roamPoints, nest } = world.terrain;
  const weights = roamPoints.map((point) => {
    const dc = point.col - nest.col;
    const dr = point.row - nest.row;
    return 1 + Math.floor(Math.sqrt(dc * dc + dr * dr));
  });
  let roll = randomInt(world, 1, weights.reduce((sum, w) => sum + w, 0));
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i]!;
    if (roll <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * Packs don't all take the shortest road in. Two packs in three swing out to
 * one side or the other (by pack id): a waypoint part of the way there,
 * pushed sideways, on walkable ground. The rest come straight. Null when it
 * goes straight, or there's no ground to swing through.
 */
function flankFor(world: World, unit: Unit, target: Point): Point | null {
  const side = (unit.packId % 3) - 1;
  if (side === 0) return null;
  const dx = target.x - unit.x;
  const dy = target.y - unit.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < FLANK_MIN_DISTANCE) return null;
  const push = Math.min(FLANK_PUSH, length * 0.4) * side;
  const ax = unit.x + dx * 0.6 - (dy / length) * push;
  const ay = unit.y + dy * 0.6 + (dx / length) * push;
  const { terrain } = terrainFor(world, unit.team);
  const col = Math.floor(ax / TILE);
  const row = Math.floor(ay / TILE);
  for (let r = 0; r <= 4; r += 1) {
    for (let dr = -r; dr <= r; dr += 1) {
      for (let dc = -r; dc <= r; dc += 1) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r || !isWalkableTile(terrain, col + dc, row + dr)) continue;
        return { x: (col + dc + 0.5) * TILE, y: (row + dr + 0.5) * TILE };
      }
    }
  }
  return null;
}

/** Next waypoint toward the destination; null on arrival. */
function stepToward(world: World, unit: Unit, destination: Destination): Point | null {
  const { terrain } = terrainFor(world, unit.team);
  if (typeof destination === "number") {
    const point = terrain.roamPoints[destination]!;
    return nextStep(terrain, goalField(world, point.row * terrain.cols + point.col, unit.team), unit.x, unit.y);
  }
  if (distance(unit, destination) <= SENSED_ARRIVAL) return null;
  const tile = Math.floor(destination.y / TILE) * terrain.cols + Math.floor(destination.x / TILE);
  return nextStep(terrain, goalField(world, tile, unit.team), unit.x, unit.y) ?? destination;
}
