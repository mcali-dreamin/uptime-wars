// Serverless functions: buildings with no standing army. An invocation costs
// $ and spins up a few short-lived units at the function, which head
// for its rally point (or hold there) and go cold when their time is up.
// Functions fire on their own when an enemy comes within their trigger range
// (they're event-driven), or when the player invokes them.

import type { TickContext } from "./context";
import { sendHome, spawnUnit } from "./entities";
import { rallyFor } from "./placement";
import { randomInt } from "./rng";
import type { Building, Team, Unit } from "./types";
import { runsAreFree } from "./heroes";
import { raceModifiers } from "./tiers";
import { hostile } from "./teams";
import { traitsFor } from "./traits";
import { applyRank, buildingRank, rankedBurst, rankedUpkeep, refitting } from "./ranks";
import { computeBalance, unitUpkeep } from "./economy";

/** Why this function can't run right now, or null if it can. */
export function invokeBlocker(ctx: TickContext, building: Building): string | null {
  const def = ctx.content.buildings[building.defId]!.invoke;
  if (!def) return "not a function";
  if (building.buildRemaining > 0) return "still deploying";
  if (refitting(building)) return "upgrading";
  if ((building.scaleTimer ?? 0) > 0) return "cooling down";
  if (building.jammedUntil !== undefined && ctx.world.tick < building.jammedUntil) return "jammed";
  const team = ctx.world.teams[building.team]!;
  if (team.downTick !== null) return "offline";
  if (burstRoom(ctx, building) < 1) return "at army cap";
  if (!runsAreFree(team, ctx.world.tick) && team.money < invokeCost(ctx.content, team, def.cost)) return "not enough $";
  return null;
}

/** Units a full run spins up. */
function burstSize(ctx: TickContext, building: Building): number {
  const { world, content } = ctx;
  const def = content.buildings[building.defId]!.invoke!;
  const t = traitsFor(content, world.teams[building.team]!, def.unit);
  return Math.round(rankedBurst(content, world, building, def.count) * (t.burstMult ?? 1)) + (t.squad ?? 0);
}

/**
 * How many burst units fit: compute is the army cap for bursts too, the same
 * rule every spawner follows. A burst past it would push the team over
 * capacity and drive its users away.
 */
function burstRoom(ctx: TickContext, building: Building): number {
  const { world, content } = ctx;
  const team = world.teams[building.team]!;
  const size = burstSize(ctx, building);
  if (team.controller !== "human") return size;
  const unit = content.buildings[building.defId]!.invoke!.unit;
  const upkeep = rankedUpkeep(unitUpkeep(content, unit), buildingRank(content, world, building));
  const { supply, demand } = computeBalance(world, content, team);
  return Math.min(size, upkeep > 0 ? Math.floor((supply - demand) / upkeep) : size);
}

/** What one run costs this team (a race perk can make it cheaper). */
export function invokeCost(content: TickContext["content"], team: Team, base: number): number {
  return Math.max(0, Math.round(base * (raceModifiers(content, team).invokeCostMultiplier ?? 1)));
}

/**
 * Run a function: pay, spin up as many of its units as compute has room for,
 * start its cooldown. A partial run costs its share. Call only when invokeBlocker is null.
 */
export function invoke(ctx: TickContext, building: Building, auto: boolean, free = false): Unit[] {
  const { world, content } = ctx;
  const def = content.buildings[building.defId]!.invoke!;
  const team = world.teams[building.team]!;
  const size = burstSize(ctx, building);
  const count = Math.max(0, burstRoom(ctx, building));
  if (!free && !runsAreFree(team, world.tick)) team.money -= Math.round((invokeCost(content, team, def.cost) * count) / Math.max(1, size));
  building.scaleTimer = Math.max(1, Math.round(def.cooldownTicks * (raceModifiers(content, team).invokeCooldownMultiplier ?? 1)));
  const units: Unit[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = building.x + randomInt(world, -20, 20);
    const y = building.y + building.radius + 10 + randomInt(world, 0, 8);
    const unit = spawnUnit(ctx, building.team, def.unit, building, x, y, "guard");
    unit.spawnerId = building.id;
    unit.expiresAt = world.tick + def.ttlTicks;
    applyRank(content, world, unit, building);
    const rally = rallyFor(world, content, building);
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
    if ((building.scaleTimer ?? 0) > 0) {
      building.scaleTimer! -= 1;
      continue;
    }
    const def = content.buildings[building.defId]!.invoke!;
    // Autoscale on load: burst only when the enemies near it outnumber its squad.
    if (!overloaded(ctx, building, def.triggerRange)) continue;
    if (invokeBlocker(ctx, building) === null) invoke(ctx, building, true);
  }
}

/** More enemy units within `range` of a function than units it has up (standing squad and burst). */
function overloaded(ctx: TickContext, building: Building, range: number): boolean {
  const { world } = ctx;
  let enemies = 0;
  let squad = 0;
  const r2 = range * range;
  for (const e of world.entities) {
    if (e.hp <= 0) continue;
    if (e.kind === "unit" && e.spawnerId === building.id) {
      squad += 1;
      continue;
    }
    if (e.kind !== "unit" || !hostile(world, e.team, building.team)) continue;
    const dx = e.x - building.x;
    const dy = e.y - building.y;
    if (dx * dx + dy * dy <= r2) enemies += 1;
  }
  return enemies > squad;
}
