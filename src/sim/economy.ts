// $ and compute, construction, and cooldown timers.
//
// Two resources. $ is money: users pay it, everything is bought with it.
// Compute is capacity: your core and generators supply it, every user and
// unit uses it. It can go negative, and the further over you are the worse
// it gets (see overload).

import type { TickContext } from "./context";
import { TICK_RATE } from "./map";
import type { Team, World } from "./types";
import { multiplier } from "./upgrades";
import { BASE_INCOME, CONSTRUCTION_START_HP } from "./tuning";

export function tickCooldowns(ctx: TickContext): void {
  const { world } = ctx;
  for (const entity of world.entities) {
    if (entity.attackCooldown > 0 && !lagging(world, entity.team)) entity.attackCooldown -= 1;
  }
}

/** Compute supplied and used by a team right now. Integers; pure. */
export function computeBalance(world: World, content: TickContext["content"], team: Team): { supply: number; demand: number } {
  const per = content.economy.compute;
  let supply = 0;
  let units = 0;
  for (const entity of world.entities) {
    if (entity.team !== team.id || entity.hp <= 0) continue;
    if (entity.kind === "building") {
      if (entity.buildRemaining <= 0) supply += content.buildings[entity.defId]!.compute ?? 0;
    } else if (entity.mode !== "builder") {
      units += content.units[entity.defId]!.upkeep ?? per.perUnit;
    }
  }
  return { supply, demand: team.users * per.perUser + units };
}

/** The share of demand a team can't serve, in permille (0 when within capacity), capped at maxOverload. */
export function overloadOf(world: World, content: TickContext["content"], team: Team): number {
  if (team.controller !== "human" || team.coreId === -1) return 0;
  const { supply, demand } = computeBalance(world, content, team);
  if (demand <= supply) return 0;
  const cap = Math.round(content.economy.compute.maxOverload * 1000);
  return Math.min(cap, Math.floor(((demand - supply) * 1000) / demand));
}

/**
 * Does this team's overload skip this tick? Spread evenly: at 250 permille
 * one tick in four is skipped, so every timer runs at 75% speed. Integer
 * only, so every peer agrees.
 */
export function lagging(world: World, teamId: number): boolean {
  const p = world.teams[teamId]?.overload ?? 0;
  if (p <= 0) return false;
  const t = world.tick;
  return Math.floor(((t + 1) * p) / 1000) - Math.floor((t * p) / 1000) === 1;
}

export function tickIncome(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const team of world.teams) {
    team.incomeTimer -= 1;
    if (team.incomeTimer <= 0) {
      team.money += BASE_INCOME.amount;
      team.incomeTimer = BASE_INCOME.intervalTicks;
    }
  }
  for (const entity of world.entities) {
    if (entity.kind !== "building" || entity.buildRemaining > 0) continue;
    const income = content.buildings[entity.defId]!.income;
    if (!income) continue;
    entity.incomeTimer -= 1;
    if (entity.incomeTimer <= 0) {
      world.teams[entity.team]!.money += income.amount;
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
 * Once a second: refresh the compute overload; users arrive toward capacity
 * (or, overloaded, leave); every user pays $. (Damage churn happens the
 * moment damage lands; see loseUsers.)
 */
export function tickUsers(ctx: TickContext): void {
  const { world, content } = ctx;
  if (world.tick % TICK_RATE !== 0) return;
  const economy = content.economy;
  for (const team of world.teams) {
    if (team.controller !== "human" || team.coreId === -1 || team.downTick !== null) {
      team.overload = 0;
      continue;
    }
    team.overload = overloadOf(world, content, team);
    const capacity = userCapacity(world, content, team);
    if (team.overload > 0) {
      // Over capacity: nobody new arrives, and users leave in proportion.
      team.churnCarry += (team.users * economy.compute.churnPerSecond * team.overload) / 1000;
      const lost = Math.floor(team.churnCarry);
      team.churnCarry -= lost;
      team.users = Math.max(0, Math.min(capacity, team.users - lost));
    } else if (team.users < capacity) {
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
    team.money += revenue;
    team.revenueCarry -= revenue;
  }
}

/**
 * Where a team's $ comes from right now, in $ per second. Pure:
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

/** Damage to a player's building drives users away. */
export function loseUsers(ctx: TickContext, team: Team, damage: number): void {
  if (team.controller !== "human" || team.users <= 0) return;
  team.churnCarry += damage / ctx.content.economy.damagePerUserLost;
  const lost = Math.floor(team.churnCarry);
  if (lost <= 0) return;
  team.churnCarry -= lost;
  team.users = Math.max(0, team.users - lost);
}

/**
 * How far away (pixels) crawlers can sense this team's cores. It's the noise
 * you make: more buildings and more users, more attention. 0 before a core.
 */
export function trafficRadius(world: World, content: TickContext["content"], team: Team): number {
  if (team.controller !== "human" || team.coreId === -1 || team.downTick !== null) return 0;
  const t = content.economy.traffic;
  let buildings = 0;
  for (const entity of world.entities) {
    if (entity.kind === "building" && entity.team === team.id && entity.hp > 0) buildings += 1;
  }
  return Math.min(t.max, t.base + t.perBuilding * buildings + t.perUser * team.users);
}
