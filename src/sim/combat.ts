// Targeting and damage.

import { creditKill } from "./heroes";
import { hostile } from "./teams";
import { GRID_CELL, GRID_STRIDE, type TickContext } from "./context";
import { regionShield } from "./mechanics";
import { loseUsers } from "./economy";
import { TILE } from "./map";
import { hasLineOfSight } from "./nav";
import { heightAtTile } from "./terrain";
import { HIGH_GROUND_DAMAGE, LOW_GROUND_SIGHT } from "./tuning";
import { multiplier } from "./upgrades";
import type { Entity } from "./types";
import { heroShield } from "./heroes";
import { raceMechanics } from "./tiers";
import { bonus } from "./upgrades";
import { afterHit, critMultiplier, onUnitDeath, traitArmor } from "./traits";

/** Attacks this close (edge to edge) are melee, for thorns. */
const MELEE_RANGE = 40;

export function edgeDistance(a: Entity, b: Entity): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy) - a.radius - b.radius;
}

/** Height level under an entity. */
export function heightOf(ctx: TickContext, entity: Entity): number {
  return heightAtTile(ctx.world.terrain, Math.floor(entity.x / TILE), Math.floor(entity.y / TILE));
}

/**
 * Line of sight, plus the high-ground rule: from lower ground you can't see
 * up a cliff unless you're right at its foot.
 */
export function canSee(ctx: TickContext, from: Entity, to: Entity): boolean {
  if (heightOf(ctx, to) > heightOf(ctx, from) && edgeDistance(from, to) > LOW_GROUND_SIGHT) return false;
  return hasLineOfSight(ctx.world.terrain, from.x, from.y, to.x, to.y);
}

/** Towers ignore walls (they're tall) but still can't see up cliffs. */
function towerCanSee(ctx: TickContext, from: Entity, to: Entity): boolean {
  return !(heightOf(ctx, to) > heightOf(ctx, from) && edgeDistance(from, to) > LOW_GROUND_SIGHT);
}

/** Largest entity radius, so the grid search never misses a big target's edge. */
const MAX_RADIUS = 48;

export function nearestEnemy(
  ctx: TickContext,
  from: Entity,
  maxDistance: number,
  filter: (entity: Entity) => boolean = () => true,
  buildingDistance = maxDistance,
): Entity | null {
  const reach = Math.max(maxDistance, buildingDistance) + from.radius + MAX_RADIUS;
  const minCol = Math.floor((from.x - reach) / GRID_CELL);
  const maxCol = Math.floor((from.x + reach) / GRID_CELL);
  const minRow = Math.floor((from.y - reach) / GRID_CELL);
  const maxRow = Math.floor((from.y + reach) / GRID_CELL);

  let best: Entity | null = null;
  let bestDistance = Infinity;
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      const cell = ctx.grid.get(row * GRID_STRIDE + col);
      if (!cell) continue;
      for (const entity of cell) {
        if (!hostile(ctx.world, entity.team, from.team) || entity.hp <= 0 || !filter(entity)) continue;
        const limit = entity.kind === "building" ? buildingDistance : maxDistance;
        const distance = edgeDistance(from, entity);
        if (distance > limit) continue;
        // Closest wins; ties go to the lower id whatever order cells were visited in.
        const better =
          best === null || distance < bestDistance || (distance === bestDistance && entity.id < best.id);
        if (!better) continue;
        if (from.kind === "unit" ? !canSee(ctx, from, entity) : !towerCanSee(ctx, from, entity)) continue;
        best = entity;
        bestDistance = distance;
      }
    }
  }
  return best;
}

export function dealDamage(
  ctx: TickContext,
  attacker: Entity,
  target: Entity,
  baseDamage: number,
  secondary = false,
): void {
  const { world, content } = ctx;
  const attackerUnit = attacker.kind === "unit" ? content.units[attacker.defId] : undefined;
  if (!secondary) baseDamage *= critMultiplier(content, world, attacker);
  // Siege units tear into buildings.
  if (attackerUnit?.siege && target.kind === "building") baseDamage *= attackerUnit.siege;
  // One kind of damage: high ground hits harder, armor takes a flat amount off.
  const downhill = heightOf(ctx, attacker) > heightOf(ctx, target) ? HIGH_GROUND_DAMAGE : 1;
  const owner = world.teams[target.team];
  const armor =
    target.armor +
    (target.kind === "building" ? bonus(content, owner, "buildingArmor") : bonus(content, owner, "unitArmor")) +
    traitArmor(content, world, target);
  let damage = Math.max(1, Math.round(baseDamage * downhill) - armor);
  if (target.kind === "building") {
    target.lastHitTick = world.tick;
    const shield = Math.min(900, regionShield(world, content, target).permille + heroShield(world, target));
    if (shield > 0) damage = Math.max(1, Math.round((damage * (1000 - shield)) / 1000));
  }
  const wasAlive = target.hp > 0;
  target.hp -= damage;
  // Remember who's shooting: a creep turns on the tower or unit hitting it.
  if (target.kind === "unit" && attacker.id !== target.id) {
    target.provokedBy = attacker.id;
    target.provokedAt = world.tick;
  }
  // Paperwork: a slowing hit makes an enemy unit act at half speed for a while.
  if (attackerUnit?.slowTicks && target.kind === "unit" && target.hp > 0) target.slowedUntil = world.tick + attackerUnit.slowTicks;
  if (target.kind === "building") loseUsers(ctx, world.teams[target.team]!, damage, target.defId);
  world.events.push({
    type: "shot",
    from: attacker.id,
    to: target.id,
    x1: attacker.x,
    y1: attacker.y,
    x2: target.x,
    y2: target.y,
    team: attacker.team,
  });
  if (!secondary) afterHit(ctx, attacker, target, baseDamage, (to, amount) => dealDamage(ctx, attacker, to, amount, true));
  // A trait may keep it alive (revive) or split it on the way out.
  if (wasAlive && target.hp <= 0 && target.kind === "unit" && onUnitDeath(ctx, target)) return;
  // Thorns: a melee blow on a spiked building hits back (never twice: the attacker is a unit).
  if (target.kind === "building" && attacker.kind === "unit" && attacker.hp > 0 && (attackerUnit?.range ?? Infinity) <= MELEE_RANGE) {
    const thorns = raceMechanics(content, world.teams[target.team]!).thorns;
    if (thorns && thorns.buildings.includes(target.defId)) dealDamage(ctx, target, attacker, thorns.damage);
  }
  if (wasAlive && target.hp <= 0) {
    world.events.push({ type: "death", id: target.id, x: target.x, y: target.y, team: target.team, kind: target.kind, defId: target.defId });
    if (target.kind === "unit") {
      world.teams[attacker.team]!.money += content.units[target.defId]!.bounty;
      creditKill(ctx, target);
    }
  }
}

export function tickBuildingAttacks(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const building of world.entities) {
    if (building.kind !== "building" || building.hp <= 0 || building.buildRemaining > 0) continue;
    if (building.jammedUntil !== undefined && world.tick < building.jammedUntil) continue;
    const attack = content.buildings[building.defId]!.attack;
    if (!attack || building.attackCooldown > 0) continue;
    const range = attack.range * multiplier(content, world.teams[building.team]!, "towerRange");
    const target = nearestEnemy(ctx, building, range, (entity) => entity.kind === "unit");
    if (!target) continue;
    dealDamage(ctx, building, target, attack.damage * multiplier(content, world.teams[building.team]!, "towerDamage"));
    building.attackCooldown = attack.cooldownTicks;
  }
}
