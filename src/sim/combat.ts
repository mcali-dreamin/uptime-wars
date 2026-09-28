// Targeting and damage.

import { GRID_CELL, GRID_STRIDE, type TickContext } from "./context";
import type { Content } from "./content";
import { hasLineOfSight } from "./nav";
import type { Entity } from "./types";

export function edgeDistance(a: Entity, b: Entity): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy) - a.radius - b.radius;
}

export function canSee(ctx: TickContext, from: Entity, to: Entity): boolean {
  return hasLineOfSight(ctx.world.terrain, from.x, from.y, to.x, to.y);
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
        if (entity.team === from.team || entity.hp <= 0 || !filter(entity)) continue;
        const limit = entity.kind === "building" ? buildingDistance : maxDistance;
        const distance = edgeDistance(from, entity);
        if (distance > limit) continue;
        // Closest wins; ties go to the lower id whatever order cells were visited in.
        const better =
          best === null || distance < bestDistance || (distance === bestDistance && entity.id < best.id);
        if (!better) continue;
        if (from.kind === "unit" && !canSee(ctx, from, entity)) continue;
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
  attackType: keyof Content["damage"],
  baseDamage: number,
): void {
  const { world, content } = ctx;
  const multiplier = content.damage[attackType][target.armorType];
  const damage = Math.max(1, Math.round(baseDamage * multiplier) - target.armor);
  const wasAlive = target.hp > 0;
  target.hp -= damage;
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
    world.events.push({ type: "death", id: target.id, x: target.x, y: target.y, team: target.team });
    if (target.kind === "unit") {
      world.teams[attacker.team].compute += content.units[target.defId]!.bounty;
    }
  }
}

export function tickBuildingAttacks(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const building of world.entities) {
    if (building.kind !== "building" || building.hp <= 0 || building.buildRemaining > 0) continue;
    const attack = content.buildings[building.defId]!.attack;
    if (!attack || building.attackCooldown > 0) continue;
    const target = nearestEnemy(ctx, building, attack.range, (entity) => entity.kind === "unit");
    if (!target) continue;
    dealDamage(ctx, building, target, attack.attackType, attack.damage);
    building.attackCooldown = attack.cooldownTicks;
  }
}
