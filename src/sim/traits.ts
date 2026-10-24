// Unit traits: each race's own upgrades, researched at its upgrade center
// (a "trait" upgrade names a unit and a TraitDef). A handful of reusable
// effects, so a new race's traits are content, not code.

import { distance } from "./movement";
import type { TickContext } from "./context";
import type { Content, TraitDef, UnitDef } from "./content";
import { spawnUnit } from "./entities";
import { hostile } from "./teams";
import { HOME_SLACK } from "./tuning";
import { TICK_RATE } from "./map";
import { multiplier } from "./upgrades";
import type { Entity, Team, Unit, World } from "./types";

const NONE: TraitDef = {};

/** Every trait this team has researched for this unit, merged. */
export function traitsFor(content: Content, team: Team | undefined, unitId: string): TraitDef {
  if (!team) return NONE;
  let merged: TraitDef | null = null;
  for (const [id, level] of Object.entries(team.upgrades)) {
    if (level <= 0) continue;
    const def = content.upgrades[id];
    if (def?.stat !== "trait" || def.unit !== unitId || !def.trait) continue;
    merged = { ...(merged ?? {}), ...def.trait };
  }
  return merged ?? NONE;
}

/** A unit's def with its speed and range traits, and the team's Unit Speed upgrade, applied. */
export function effectiveDef(content: Content, team: Team | undefined, unit: Unit, def: UnitDef): UnitDef {
  const t = traitsFor(content, team, unit.defId);
  const faster = multiplier(content, team, "unitSpeed");
  if (!t.speed && !t.range && faster === 1) return def;
  return { ...def, speed: def.speed * (t.speed ?? 1) * faster, range: def.range * (t.range ?? 1) };
}

/** Is this unit holding its post (home, no order)? */
export function holding(unit: Unit): boolean {
  return unit.order === null && distance(unit, { x: unit.homeX, y: unit.homeY }) <= HOME_SLACK * 2;
}

/** Extra armor a target gets from its traits right now. */
export function traitArmor(content: Content, world: World, target: Entity): number {
  if (target.kind !== "unit") return 0;
  const hold = traitsFor(content, world.teams[target.team], target.defId).holdArmor;
  return hold && holding(target) ? hold : 0;
}

/** Damage multiplier from a crit trait; counts the hit. */
export function critMultiplier(content: Content, world: World, attacker: Entity): number {
  if (attacker.kind !== "unit") return 1;
  const crit = traitsFor(content, world.teams[attacker.team], attacker.defId).crit;
  if (!crit) return 1;
  attacker.hits = (attacker.hits ?? 0) + 1;
  return attacker.hits % crit.every === 0 ? crit.mult : 1;
}

/**
 * After a unit's hit lands: disarm/stun the target, and splash or chain to
 * others. `hit` deals damage without triggering any of this again.
 */
export function afterHit(ctx: TickContext, attacker: Entity, target: Entity, damage: number, hit: (to: Entity, amount: number) => void): void {
  const { world, content } = ctx;
  if (attacker.kind !== "unit") return;
  const t = traitsFor(content, world.teams[attacker.team], attacker.defId);
  if (t === NONE) return;
  if (target.kind === "unit" && target.hp > 0) {
    if (t.disarmTicks) target.disarmedUntil = world.tick + t.disarmTicks;
    if (t.stunTicks) target.stunnedUntil = world.tick + t.stunTicks;
  }
  if (t.splash) {
    for (const other of world.entities) {
      if (other === target || other.hp <= 0 || !hostile(world, other.team, attacker.team)) continue;
      if (distance(other, target) <= t.splash.radius + other.radius) hit(other, damage * t.splash.share);
    }
  }
  if (t.chain) {
    let best: Entity | undefined;
    let bestD = Infinity;
    for (const other of world.entities) {
      if (other === target || other.kind !== "unit" || other.hp <= 0 || !hostile(world, other.team, attacker.team)) continue;
      const d = distance(other, target);
      if (d <= t.chain.radius && d < bestD) {
        best = other;
        bestD = d;
      }
    }
    if (best) hit(best, damage * t.chain.share);
  }
}

/**
 * A unit is about to die. A Kernel with Self-Hosting nearby may bring it
 * back (returns true: it lives). Otherwise a unit with Fork on Exit splits.
 */
export function onUnitDeath(ctx: TickContext, unit: Unit): boolean {
  const { world, content } = ctx;
  const team = world.teams[unit.team];
  if (!team || unit.mode === "hero" || unit.mode === "decoy") return false;
  for (const kernel of world.entities) {
    if (kernel.kind !== "unit" || kernel === unit || kernel.hp <= 0 || kernel.team !== unit.team) continue;
    const revive = traitsFor(content, team, kernel.defId).revive;
    const heal = content.units[kernel.defId]!.heal;
    if (!revive || !heal || (kernel.reviveAt ?? 0) > world.tick || distance(kernel, unit) > heal.radius) continue;
    unit.hp = Math.max(1, Math.round(unit.maxHp * revive.hpShare));
    kernel.reviveAt = world.tick + revive.cooldownTicks;
    world.events.push({ type: "revived", id: unit.id, x: unit.x, y: unit.y, team: unit.team });
    return true;
  }
  const split = traitsFor(content, team, unit.defId).split;
  if (split && !unit.forked) {
    for (let i = 0; i < split.count; i += 1) {
      const child = spawnUnit(ctx, unit.team, unit.defId, unit, unit.x + (i % 2 ? 12 : -12), unit.y, unit.mode);
      child.maxHp = child.hp = Math.max(1, Math.round(child.maxHp * split.hpShare));
      child.forked = true;
      child.homeX = unit.homeX;
      child.homeY = unit.homeY;
      child.order = unit.order;
      child.commanded = unit.commanded;
    }
  }
  return false;
}

/** Once a second: taunters pull nearby creeps onto themselves. */
export function tickTaunts(ctx: TickContext): void {
  const { world, content } = ctx;
  if (world.tick % TICK_RATE !== 0) return;
  for (const taunter of world.entities) {
    if (taunter.kind !== "unit" || taunter.hp <= 0) continue;
    const taunt = traitsFor(content, world.teams[taunter.team], taunter.defId).taunt;
    if (!taunt) continue;
    for (const creep of world.entities) {
      if (creep.kind !== "unit" || creep.hp <= 0 || creep.mode !== "roam" || !hostile(world, creep.team, taunter.team)) continue;
      if (distance(creep, taunter) > taunt.radius) continue;
      creep.targetId = taunter.id;
      creep.tauntedBy = taunter.id;
      creep.tauntedUntil = world.tick + TICK_RATE + 1;
    }
  }
}

/** Extra standing squad / burst size a function or spawner gets from its unit's traits. */
export function squadBonus(content: Content, team: Team | undefined, unitId: string): number {
  return traitsFor(content, team, unitId).squad ?? 0;
}
