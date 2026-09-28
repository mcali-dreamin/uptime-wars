// Unit behaviour. Each unit has one mode:
//
// - guard:   yours. Holds its home (spawn spot or rally point), fights
//            anything that comes near, and fights through whatever it meets
//            on the way there.
// - roam:    creeps. Wanders the web with its pack and attacks whatever it
//            sees. No shared knowledge: every pack finds (or misses) you on
//            its own.
// - builder: your deploy agent. Walks where it's told and becomes the core.

import { canSee, dealDamage, edgeDistance, nearestEnemy } from "./combat";
import type { TickContext } from "./context";
import type { UnitDef } from "./content";
import { foundCore } from "./entities";
import { goalField, distance, walkTo } from "./movement";
import { hasClearPath, moveToward, nextStep } from "./nav";
import { canFound } from "./placement";
import { randomInt } from "./rng";
import { multiplier } from "./upgrades";
import {
  BUILDING_SIGHT,
  FOUND_REACH,
  GUARD_RADIUS,
  HOME_SLACK,
  LEASH_MULTIPLIER,
  MOVE_REACH,
  PACK_SPREAD,
  ROAM_SPEED,
} from "./tuning";
import type { Entity, Unit, World } from "./types";

export function tickUnits(ctx: TickContext): void {
  const { world, content } = ctx;

  // Pack leader = lowest-id living member (entities are in id order).
  const leaders = new Map<number, Unit>();
  for (const entity of world.entities) {
    if (entity.kind === "unit" && entity.hp > 0 && entity.packId >= 0 && !leaders.has(entity.packId)) {
      leaders.set(entity.packId, entity);
    }
  }

  for (const unit of world.entities) {
    if (unit.kind !== "unit" || unit.hp <= 0) continue;
    const def = content.units[unit.defId]!;
    if (unit.mode === "builder") {
      tickBuilder(ctx, unit, def.speed);
      continue;
    }
    // Fighting comes first for guards and roamers alike.
    if (engage(ctx, unit, def)) continue;
    if (unit.mode === "guard") {
      const home = { x: unit.homeX, y: unit.homeY };
      if (distance(unit, home) > HOME_SLACK) walkTo(world, unit, home, def.speed);
    } else {
      roam(ctx, unit, leaders.get(unit.packId), def.speed * ROAM_SPEED);
    }
  }
}

/**
 * Pick (or keep) a target and fight it. Returns true when the unit spent its
 * tick fighting or closing in, false when it should get on with its mode.
 */
function engage(ctx: TickContext, unit: Unit, def: UnitDef): boolean {
  const { world } = ctx;
  const guard = unit.mode === "guard";
  const home = { x: unit.homeX, y: unit.homeY };

  // Guards defend the ground around home and fight whatever gets in their
  // face on the way there, but won't chase something away from home past
  // their own sight.
  const guardCanHold = (t: Entity) => !guard || distance(t, home) <= GUARD_RADIUS || edgeDistance(unit, t) <= def.aggro;
  const sight = (t: Entity) => (t.kind === "building" && !guard ? BUILDING_SIGHT : def.aggro);

  let target = unit.targetId === null ? undefined : ctx.byId.get(unit.targetId);
  const keep =
    target !== undefined &&
    target.hp > 0 &&
    edgeDistance(unit, target) <= sight(target) * LEASH_MULTIPLIER &&
    guardCanHold(target) &&
    canSee(ctx, unit, target);
  if (!keep) {
    target = nearestEnemy(ctx, unit, def.aggro, undefined, guard ? def.aggro : Math.max(def.aggro, BUILDING_SIGHT)) ?? undefined;
  }
  if (target && !guardCanHold(target)) target = undefined;
  unit.targetId = target?.id ?? null;
  if (!target) return false;

  const gap = edgeDistance(unit, target);
  if (gap <= def.range) {
    if (unit.attackCooldown <= 0) {
      const damage = def.damage * multiplier(ctx.content, world.teams[unit.team], "unitDamage");
      dealDamage(ctx, unit, target, def.attackType, damage);
      unit.attackCooldown = def.cooldownTicks;
    }
    return true;
  }
  if (hasClearPath(world.terrain, unit.x, unit.y, target.x, target.y, unit.radius)) {
    moveToward(world.terrain, unit, target.x, target.y, Math.min(def.speed, gap - def.range + 0.5));
    return true;
  }
  // Seen but not straight-line reachable: carry on with the mode this tick.
  return false;
}

/**
 * Traffic flows outward from the middle of the web: a roam point's chance of
 * being picked grows with its distance from the nest. No knowledge of where
 * anyone lives, just which way the current runs.
 */
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

function roamField(world: World, index: number): Int32Array {
  const point = world.terrain.roamPoints[index]!;
  return goalField(world, point.row * world.terrain.cols + point.col);
}

/** Follow the pack: straggle back to the leader, else walk the pack's route. */
function roam(ctx: TickContext, unit: Unit, leader: Unit | undefined, speed: number): void {
  const { world } = ctx;
  const { terrain } = world;
  if (terrain.roamPoints.length === 0) return;

  if (leader && leader !== unit && distance(unit, leader) > PACK_SPREAD) {
    if (hasClearPath(terrain, unit.x, unit.y, leader.x, leader.y, unit.radius)) {
      moveToward(terrain, unit, leader.x, leader.y, speed * 1.3);
      return;
    }
  }

  let destination = world.waves.packs[unit.packId];
  let waypoint = destination === undefined ? null : nextStep(terrain, roamField(world, destination), unit.x, unit.y);
  if (!waypoint) {
    // Arrived, or new pack: wander somewhere else.
    destination = pickRoamPoint(world);
    world.waves.packs[unit.packId] = destination;
    waypoint = nextStep(terrain, roamField(world, destination), unit.x, unit.y);
  }
  if (waypoint) moveToward(terrain, unit, waypoint.x, waypoint.y, speed);
}

/** Walk to the order; on arrival at a founding site, become the core. */
function tickBuilder(ctx: TickContext, unit: Unit, speed: number): void {
  const { world, content } = ctx;
  const goal = unit.moveTo;
  if (!goal) return;
  if (distance(unit, goal) > (unit.foundAt ? FOUND_REACH : MOVE_REACH)) {
    walkTo(world, unit, goal, speed);
    return;
  }
  unit.moveTo = null;
  const site = unit.foundAt;
  unit.foundAt = null;
  if (!site) return;
  const reason = canFound(world, content, unit.team, site.col, site.row);
  if (reason) {
    world.events.push({ type: "rejected", command: { type: "found", tick: world.tick, team: unit.team, ...site }, reason });
    return;
  }
  const core = foundCore(world, content, unit.team, site.col, site.row);
  ctx.byId.set(core.id, core);
  // The agent deploys into the core.
  unit.hp = 0;
  world.teams[unit.team].builderId = -1;
  world.events.push({ type: "founded", x: core.x, y: core.y });
}
