// Fighting: pick (or keep) a target, close in, and attack. Shared by every
// mode that fights.

import { canSee, edgeDistance, nearestEnemy } from "../combat";
import { rankDamage } from "../ranks";
import type { TickContext } from "../context";
import type { UnitDef } from "../content";
import { distance, walkTo } from "../movement";
import { hasClearPath, moveToward } from "../nav";
import { buffMultiplier, luredBy } from "../heroes";
import { BUILDING_SIGHT, GUARD_RADIUS, LEASH_MULTIPLIER, PROVOKED_TICKS } from "../tuning";
import type { Entity, Unit } from "../types";
import { multiplier } from "../upgrades";
import { roleHit, roleTargets } from "../roles";
import { hostile } from "../teams";
import { terrainFor } from "../walls";

/**
 * Returns true when the unit spent its tick fighting or closing in, false
 * when it should get on with its mode.
 */
/** Can this enemy hurt you? Units (not decoys) and buildings with an attack. */
function fightsBack(ctx: TickContext, e: Entity): boolean {
  if (e.kind === "unit") return e.mode !== "decoy";
  return ctx.content.buildings[e.defId]?.attack !== undefined;
}

/** In range already, or a clear straight walk to its near edge. */
function canReach(ctx: TickContext, unit: Unit, def: UnitDef, e: Entity): boolean {
  if (edgeDistance(unit, e) <= def.range) return true;
  const [x, y] = nearEdge(unit, e);
  // Its own view of the ground: a gate is open to its owner, a wall to nobody.
  return hasClearPath(terrainFor(ctx.world, unit.team).terrain, unit.x, unit.y, x, y, unit.radius);
}

/** Where to walk to reach an entity: a building's near edge (its own tiles may be blocked), a unit's centre. */
function nearEdge(unit: Unit, e: Entity): [number, number] {
  if (e.kind !== "building") return [e.x, e.y];
  const dx = unit.x - e.x;
  const dy = unit.y - e.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  const reach = e.radius + unit.radius + 2;
  return [e.x + (dx / length) * reach, e.y + (dy / length) * reach];
}

/** Whoever hit this creep in the last moments, if it's still there to hit back. */
function provokedTarget(ctx: TickContext, unit: Unit, def: UnitDef): Entity | undefined {
  if (unit.provokedBy === undefined || ctx.world.tick - (unit.provokedAt ?? 0) > PROVOKED_TICKS) return undefined;
  const attacker = ctx.byId.get(unit.provokedBy);
  if (!attacker || attacker.hp <= 0 || !hostile(ctx.world, attacker.team, unit.team)) return undefined;
  // Towers outrange most creeps: chase as far as the shooter's own reach, plus some.
  const reach = Math.max(def.aggro, (attacker.kind === "building" ? ctx.content.buildings[attacker.defId]?.attack?.range : ctx.content.units[attacker.defId]?.range) ?? 0) * LEASH_MULTIPLIER;
  return edgeDistance(unit, attacker) <= reach ? attacker : undefined;
}

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
  const wants = roleTargets(ctx, def.role);
  if (target && wants && !lure && !wants(target)) target = undefined;
  if (!keep || (target === undefined && !lure)) {
    target = nearestEnemy(ctx, unit, def.aggro, wants, guard ? def.aggro : Math.max(def.aggro, BUILDING_SIGHT)) ?? undefined;
  }
  // Roamers find bases by their buildings (seen from far off), but whatever
  // fights back comes first: the tower or unit that just hit it, else the
  // nearest defender (a unit or a tower) in aggro range, rather than keep
  // chewing on a Web App while a firewall shoots it.
  // Specialists only turn on what their role goes for (a siege creep hits
  // back at a tower, a phisher keeps going for your users).
  const taunter = unit.tauntedBy !== undefined && world.tick < (unit.tauntedUntil ?? 0) ? ctx.byId.get(unit.tauntedBy) : undefined;
  if (!guard && !lure && taunter && taunter.hp > 0) {
    target = taunter;
  } else if (!guard && !lure) {
    // Only if it can get at them: a tower shooting over a wall means the wall comes first.
    const reachable = (e: Entity) => (wants === undefined || wants(e)) && canReach(ctx, unit, def, e);
    const provoker = provokedTarget(ctx, unit, def);
    if (provoker && reachable(provoker)) {
      target = provoker;
    } else if (target === undefined || !fightsBack(ctx, target)) {
      const threat = nearestEnemy(ctx, unit, def.aggro, (e) => fightsBack(ctx, e) && reachable(e));
      if (threat) target = threat;
    }
  }
  if (target && !guardCanHold(target)) target = undefined;
  unit.targetId = target?.id ?? null;
  if (!target) return false;

  const gap = edgeDistance(unit, target);
  if (gap <= def.range) {
    // Disarmed: in its face, but can't swing.
    const disarmed = unit.disarmedUntil !== undefined && world.tick < unit.disarmedUntil;
    if (unit.attackCooldown <= 0 && !disarmed) {
      const team = world.teams[unit.team]!;
      const damage = def.damage * multiplier(ctx.content, team, "unitDamage") * buffMultiplier(team, world.tick) * rankDamage(ctx.content, world, unit);
      roleHit(ctx, unit, def, target, damage);
      unit.attackCooldown = def.cooldownTicks;
    }
    return true;
  }
  if (lure) {
    walkTo(world, unit, target, def.speed);
    return true;
  }
  // Head for the near edge of a building, not its centre: a wall's own tiles
  // are blocked, so the way to its centre never looks clear.
  const [aimX, aimY] = nearEdge(unit, target);
  const { terrain } = terrainFor(world, unit.team);
  if (hasClearPath(terrain, unit.x, unit.y, aimX, aimY, unit.radius)) {
    moveToward(terrain, unit, aimX, aimY, Math.min(def.speed, gap - def.range + 0.5));
    return true;
  }
  // Seen but not straight-line reachable: carry on with the mode this tick.
  return false;
}
