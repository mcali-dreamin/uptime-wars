// Fighting: pick (or keep) a target, close in, and attack. Shared by every
// mode that fights.

import { canSee, dealDamage, edgeDistance, nearestEnemy } from "../combat";
import type { TickContext } from "../context";
import type { UnitDef } from "../content";
import { distance, walkTo } from "../movement";
import { hasClearPath, moveToward } from "../nav";
import { buffMultiplier, luredBy } from "../heroes";
import { BUILDING_SIGHT, GUARD_RADIUS, LEASH_MULTIPLIER } from "../tuning";
import type { Entity, Unit } from "../types";
import { multiplier } from "../upgrades";

/**
 * Returns true when the unit spent its tick fighting or closing in, false
 * when it should get on with its mode.
 */
export function engage(ctx: TickContext, unit: Unit, def: UnitDef): boolean {
  const { world } = ctx;
  const guard = unit.mode === "guard";
  const home = { x: unit.homeX, y: unit.homeY };

  // Guards defend the ground around home and fight whatever gets in their
  // face on the way there, but won't chase something away from home past
  // their own sight.
  const guardCanHold = (t: Entity) => !guard || distance(t, home) <= GUARD_RADIUS || edgeDistance(unit, t) <= def.aggro;
  const sight = (t: Entity) => (t.kind === "building" && !guard ? BUILDING_SIGHT : def.aggro);

  // A creep lured by a honeypot goes for it, wherever it is.
  const lure = guard ? undefined : luredBy(ctx, unit);
  let target = lure ?? (unit.targetId === null ? undefined : ctx.byId.get(unit.targetId));
  const keep =
    lure !== undefined ||
    target !== undefined &&
    target.hp > 0 &&
    edgeDistance(unit, target) <= sight(target) * LEASH_MULTIPLIER &&
    guardCanHold(target) &&
    canSee(ctx, unit, target);
  if (!keep) {
    target = nearestEnemy(ctx, unit, def.aggro, undefined, guard ? def.aggro : Math.max(def.aggro, BUILDING_SIGHT)) ?? undefined;
  }
  // Roamers find bases by their buildings (seen from far off), but a defender
  // that gets in their face comes first: switch to the nearest enemy unit in
  // aggro range rather than keep chewing on a building while it's shot at.
  if (target?.kind === "building" && !guard) {
    const threat = nearestEnemy(ctx, unit, def.aggro, (e) => e.kind === "unit");
    if (threat) target = threat;
  }
  if (target && !guardCanHold(target)) target = undefined;
  unit.targetId = target?.id ?? null;
  if (!target) return false;

  const gap = edgeDistance(unit, target);
  if (gap <= def.range) {
    if (unit.attackCooldown <= 0) {
      const team = world.teams[unit.team]!;
      const damage = def.damage * multiplier(ctx.content, team, "unitDamage") * buffMultiplier(team, world.tick);
      dealDamage(ctx, unit, target, def.attackType, damage);
      unit.attackCooldown = def.cooldownTicks;
    }
    return true;
  }
  if (lure) {
    walkTo(world, unit, target, def.speed);
    return true;
  }
  if (hasClearPath(world.terrain, unit.x, unit.y, target.x, target.y, unit.radius)) {
    moveToward(world.terrain, unit, target.x, target.y, Math.min(def.speed, gap - def.range + 0.5));
    return true;
  }
  // Seen but not straight-line reachable: carry on with the mode this tick.
  return false;
}
