// Income, construction, and cooldown timers.

import type { TickContext } from "./context";
import { TICK_RATE } from "./map";
import type { Team, World } from "./types";
import { multiplier } from "./upgrades";
import { BASE_INCOME, CONSTRUCTION_START_HP } from "./tuning";

export function tickCooldowns(ctx: TickContext): void {
  for (const entity of ctx.world.entities) {
    if (entity.attackCooldown > 0) entity.attackCooldown -= 1;
  }
}

export function tickIncome(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const team of world.teams) {
    team.incomeTimer -= 1;
    if (team.incomeTimer <= 0) {
      team.compute += BASE_INCOME.amount;
      team.incomeTimer = BASE_INCOME.intervalTicks;
    }
  }
  for (const entity of world.entities) {
    if (entity.kind !== "building" || entity.buildRemaining > 0) continue;
    const income = content.buildings[entity.defId]!.income;
    if (!income) continue;
    entity.incomeTimer -= 1;
    if (entity.incomeTimer <= 0) {
      world.teams[entity.team]!.compute += income.amount;
      entity.incomeTimer = income.intervalTicks;
    }
  }
}

export function tickConstruction(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const entity of world.entities) {
    if (entity.kind !== "building" || entity.buildRemaining <= 0) continue;
    const def = content.buildings[entity.defId]!;
    entity.hp = Math.min(entity.maxHp, entity.hp + (entity.maxHp * (1 - CONSTRUCTION_START_HP)) / def.buildTicks);
    entity.buildRemaining -= 1;
  }
}

/** Total users your finished buildings can serve. */
export function userCapacity(world: World, content: TickContext["content"], team: Team): number {
  let capacity = 0;
  for (const entity of world.entities) {
    if (entity.kind !== "building" || entity.team !== team.id || entity.hp <= 0 || entity.buildRemaining > 0) continue;
    capacity += content.buildings[entity.defId]!.userCapacity ?? 0;
  }
  return Math.floor(capacity * multiplier(content, team, "userCapacity"));
}

/**
 * Once a second: users arrive toward capacity, and every user pays revenue.
 * (Churn happens the moment damage lands; see loseUsers.)
 */
export function tickUsers(ctx: TickContext): void {
  const { world, content } = ctx;
  if (world.tick % TICK_RATE !== 0) return;
  const economy = content.economy;
  for (const team of world.teams) {
    if (team.controller !== "human" || team.coreId === -1 || team.downTick !== null) continue;
    const capacity = userCapacity(world, content, team);
    if (team.users < capacity) {
      const gap = capacity - team.users;
      const arrivals = Math.max(economy.minArrivalsPerSecond, Math.floor(gap * economy.growthPerSecond));
      team.users = Math.min(capacity, team.users + arrivals);
    } else if (team.users > capacity) {
      // Lost a building: the users it served have nowhere to go.
      team.users = capacity;
    }
    team.peakUsers = Math.max(team.peakUsers, team.users);

    team.revenueCarry += team.users * economy.revenuePerUserPerSecond * multiplier(content, team, "revenue");
    const revenue = Math.floor(team.revenueCarry);
    team.compute += revenue;
    team.revenueCarry -= revenue;
  }
}

/**
 * Where a team's compute comes from right now, in compute per second. Pure:
 * reads state, changes nothing, so the HUD can call it every frame.
 */
export function incomeRate(world: World, content: TickContext["content"], team: Team): { base: number; buildings: number; users: number } {
  const base = (BASE_INCOME.amount * TICK_RATE) / BASE_INCOME.intervalTicks;
  let buildings = 0;
  for (const entity of world.entities) {
    if (entity.kind !== "building" || entity.team !== team.id || entity.hp <= 0 || entity.buildRemaining > 0) continue;
    const income = content.buildings[entity.defId]!.income;
    if (income) buildings += (income.amount * TICK_RATE) / income.intervalTicks;
  }
  const online = team.controller === "human" && team.coreId !== -1 && team.downTick === null;
  const users = online ? team.users * content.economy.revenuePerUserPerSecond * multiplier(content, team, "revenue") : 0;
  return { base, buildings, users };
}

/**
 * Damage to a building that serves users (core, Web Apps) drives some away.
 * Towers, racks and the rest are what you put between creeps and your users.
 */
export function loseUsers(ctx: TickContext, team: Team, damage: number, defId: string): void {
  if (team.controller !== "human" || team.users <= 0) return;
  if (!ctx.content.buildings[defId]?.userCapacity) return;
  team.churnCarry += damage / ctx.content.economy.damagePerUserLost;
  const lost = Math.floor(team.churnCarry);
  if (lost <= 0) return;
  team.churnCarry -= lost;
  team.users = Math.max(0, team.users - lost);
}

/**
 * How far away (pixels) crawlers can sense this team's cores. It's the noise
 * you make: more buildings and more users, more attention, and it creeps up
 * with time so nobody can hide forever. 0 before a core.
 */
export function trafficRadius(world: World, content: TickContext["content"], team: Team): number {
  if (team.controller !== "human" || team.coreId === -1 || team.downTick !== null) return 0;
  const t = content.economy.traffic;
  let buildings = 0;
  for (const entity of world.entities) {
    if (entity.kind === "building" && entity.team === team.id && entity.hp > 0) buildings += 1;
  }
  const minutes = Math.floor(world.tick / (TICK_RATE * 60));
  return Math.min(t.max, t.base + t.perBuilding * buildings + t.perUser * team.users + t.perMinute * minutes);
}
