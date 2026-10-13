// Creep roles: the horde's specialists (see CreepRole in content/schema.ts).
// Each forces a different answer: kill the scanner before it reports, guard
// the Web Apps from phishers, hunt the miner, keep DDoS off your towers, and
// don't trust walls against siege.

import { canSee, dealDamage, nearestEnemy } from "./combat";
import type { TickContext } from "./context";
import type { CreepRole, UnitDef } from "./content";
import { loseUsers } from "./economy";
import { isCore } from "./placement";
import { hostile } from "./teams";
import { BUILDING_SIGHT } from "./tuning";
import type { Building, Entity, Unit } from "./types";

export function isJammed(building: Building, tick: number): boolean {
  return building.jammedUntil !== undefined && tick < building.jammedUntil;
}

/** Only these targets interest a creep with this role (undefined: anything). */
export function roleTargets(ctx: TickContext, role: CreepRole | undefined): ((e: Entity) => boolean) | undefined {
  if (!role) return undefined;
  const { world, content } = ctx;
  switch (role.kind) {
    case "phisher":
      return (e) => e.kind === "building" && (Boolean(content.buildings[e.defId]!.userCapacity) || isCore(content, world.teams[e.team]!, e));
    case "miner":
    case "jammer":
    case "siege":
      return (e) => e.kind === "building";
    case "scanner":
      return () => false;
  }
}

/** Hit `target`, with the role's twist. */
export function roleHit(ctx: TickContext, unit: Unit, def: UnitDef, target: Entity, damage: number): void {
  const { world } = ctx;
  const role = def.role;
  if (role?.kind === "siege" && target.kind === "building") damage *= role.buildingMultiplier;
  dealDamage(ctx, unit, target, damage);
  if (target.kind !== "building") return;
  const owner = world.teams[target.team]!;
  switch (role?.kind) {
    case "phisher":
      // dealDamage already churned once; the rest of the multiplier on top.
      loseUsers(ctx, owner, Math.max(1, Math.round(damage - target.armor)) * (role.churnMultiplier - 1), target.defId);
      break;
    case "miner":
      owner.money = Math.max(0, owner.money - role.drain);
      break;
    case "jammer":
      target.jammedUntil = world.tick + role.jamTicks;
      break;
  }
}

/**
 * Scanners: spot a building, then report it once they've lived `reportTicks`
 * longer. Reporting sends every horde pack in range marching on it.
 */
export function tickScanner(ctx: TickContext, unit: Unit, role: Extract<CreepRole, { kind: "scanner" }>): void {
  const { world } = ctx;
  if (unit.reported) return;
  if (!unit.spotted) {
    const seen = nearestEnemy(ctx, unit, 0, (e) => e.kind === "building", BUILDING_SIGHT);
    if (seen && canSee(ctx, unit, seen)) unit.spotted = { tick: world.tick, x: seen.x, y: seen.y, team: seen.team };
    return;
  }
  if (world.tick - unit.spotted.tick < role.reportTicks) return;
  const { x, y, team } = unit.spotted;
  const reach = role.reportRadius;
  const packs = new Set<number>();
  for (const other of world.entities) {
    if (other.kind !== "unit" || other.team !== unit.team || other.packId < 0 || other.hp <= 0) continue;
    const dx = other.x - unit.x;
    const dy = other.y - unit.y;
    if (dx * dx + dy * dy <= reach * reach) packs.add(other.packId);
  }
  for (const pack of [...packs].sort((a, b) => a - b)) world.waves.packs[pack] = { x, y };
  unit.reported = true;
  if (hostile(world, team, unit.team)) world.events.push({ type: "reported", team, x, y, packs: packs.size });
}
