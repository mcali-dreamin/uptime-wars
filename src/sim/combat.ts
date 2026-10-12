// Targeting and damage.

import { creditKill } from "./heroes";
import { hostile } from "./teams";
import { GRID_CELL, GRID_STRIDE, type TickContext } from "./context";
import { loseUsers } from "./economy";
import { TILE } from "./map";
import { hasLineOfSight } from "./nav";
import { heightAtTile } from "./terrain";
import { HIGH_GROUND_DAMAGE, LOW_GROUND_SIGHT } from "./tuning";
import { multiplier } from "./upgrades";
import type { Entity } from "./types";

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
): void {
  const { world, content } = ctx;
  // One kind of damage: high ground hits harder, armor takes a flat amount off.
  const downhill = heightOf(ctx, attacker) > heightOf(ctx, target) ? HIGH_GROUND_DAMAGE : 1;
  const damage = Math.max(1, Math.round(baseDamage * downhill) - target.armor);
  const wasAlive = target.hp > 0;
  target.hp -= damage;
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
    const attack = content.buildings[building.defId]!.attack;
    if (!attack || building.attackCooldown > 0) continue;
    const range = attack.range * multiplier(content, world.teams[building.team]!, "towerRange");
    const target = nearestEnemy(ctx, building, range, (entity) => entity.kind === "unit");
    if (!target) continue;
    dealDamage(ctx, building, target, attack.damage);
    building.attackCooldown = attack.cooldownTicks;
  }
}
