// Serverless functions: buildings with no standing army. An invocation costs
// $ and spins up a few short-lived units at the function, which head
// for its rally point (or hold there) and go cold when their time is up.
// Functions fire on their own when an enemy comes within their trigger range
// (they're event-driven), or when the player invokes them.

import { nearestEnemy } from "./combat";
import type { TickContext } from "./context";
import { sendHome, spawnUnit } from "./entities";
import { randomInt } from "./rng";
import type { Building, Team, Unit } from "./types";
import { raceModifiers } from "./tiers";
import { traitsFor } from "./traits";

/** Why this function can't run right now, or null if it can. */
export function invokeBlocker(ctx: TickContext, building: Building): string | null {
  const def = ctx.content.buildings[building.defId]!.invoke;
  if (!def) return "not a function";
  if (building.buildRemaining > 0) return "still deploying";
  if (building.spawnTimer > 0) return "cooling down";
  if (building.jammedUntil !== undefined && ctx.world.tick < building.jammedUntil) return "jammed";
  const team = ctx.world.teams[building.team]!;
  if (team.downTick !== null) return "offline";
  if (team.money < invokeCost(ctx.content, team, def.cost)) return "not enough $";
  return null;
}

/** What one run costs this team (a race perk can make it cheaper). */
export function invokeCost(content: TickContext["content"], team: Team, base: number): number {
  return Math.max(0, Math.round(base * (raceModifiers(content, team).invokeCostMultiplier ?? 1)));
}

/** Run a function: pay, spin up its units, start its cooldown. Call only when invokeBlocker is null. */
export function invoke(ctx: TickContext, building: Building, auto: boolean): Unit[] {
  const { world, content } = ctx;
  const def = content.buildings[building.defId]!.invoke!;
  const team = world.teams[building.team]!;
  team.money -= invokeCost(content, team, def.cost);
  building.spawnTimer = Math.max(1, Math.round(def.cooldownTicks * (raceModifiers(content, team).invokeCooldownMultiplier ?? 1)));
  const units: Unit[] = [];
  const t = traitsFor(content, team, def.unit);
  const count = Math.round(def.count * (t.burstMult ?? 1)) + (t.squad ?? 0);
  for (let i = 0; i < count; i += 1) {
    const x = building.x + randomInt(world, -20, 20);
    const y = building.y + building.radius + 10 + randomInt(world, 0, 8);
    const unit = spawnUnit(ctx, building.team, def.unit, building, x, y, "guard");
    unit.spawnerId = building.id;
    unit.expiresAt = world.tick + def.ttlTicks;
    const rally = building.rally ?? team.rally;
    if (rally) sendHome(world, unit, rally);
    units.push(unit);
  }
  world.events.push({ type: "invoked", buildingId: building.id, team: building.team, units: units.length, auto });
  return units;
}

export function tickFunctions(ctx: TickContext): void {
  const { world, content } = ctx;
  // Cold units go first, so a function can be re-triggered the same tick.
  for (const entity of world.entities) {
    if (entity.kind !== "unit" || entity.expiresAt === undefined || entity.hp <= 0 || world.tick < entity.expiresAt) continue;
    entity.hp = 0;
    world.events.push({ type: "expired", id: entity.id, x: entity.x, y: entity.y, team: entity.team });
  }
  // Snapshot: units spun up this tick are appended and must not be iterated.
  const functions = world.entities.filter(
    (e): e is Building => e.kind === "building" && e.hp > 0 && content.buildings[e.defId]!.invoke !== undefined,
  );
  for (const building of functions) {
    if (building.buildRemaining > 0) continue;
    if (building.jammedUntil !== undefined && world.tick < building.jammedUntil) continue;
    if (building.spawnTimer > 0) {
      building.spawnTimer -= 1;
      continue;
    }
    const def = content.buildings[building.defId]!.invoke!;
    if (!nearestEnemy(ctx, building, def.triggerRange)) continue;
    if (invokeBlocker(ctx, building) === null) invoke(ctx, building, true);
  }
}
