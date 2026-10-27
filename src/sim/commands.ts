// Player commands. Everything a player does goes through here, scheduled for
// a tick, so a match is fully described by its seed plus its command log.

import { spotCost } from "./economy";
import { tierOf } from "./tiers";
import { rankBlocker, startRank } from "./ranks";
import type { TickContext } from "./context";
import { placeBuilding, sendHome, spawnUnit } from "./entities";
import { TILE, footprintCenter } from "./map";
import { buildCost, canFound, canPlace, homeCore, isCore } from "./placement";
import { canResearch, nextQueued, slotOf, waitingOf, cancelQueued } from "./upgrades";
import { invoke, invokeBlocker } from "./functions";
import { applyFork } from "./mechanics";
import { applyDecommission, applyDismiss } from "./decommission";
import { heroOf, learnBlocker, orderCast } from "./heroes";
import { INVULNERABLE, invulnerable } from "./fortress";
import { applyBuy, applyPickUp, applySell, applyUse } from "./items";
import { allyBlocker, breakAlliance, hostile, offerAlliance, unallyBlocker } from "./teams";
import { TILE_OPEN, isWalkableTile, tileAt } from "./terrain";
import { nearestFit } from "./nav";
import { MAX_ORDER_UNITS, MAX_WAYPOINTS, ORDER_SPREAD_MAX, ORDER_SPREAD_PER_UNIT, RALLY_SPREAD } from "./tuning";
import type { Command, Entity, OrderCommand, RallyCommand, World } from "./types";

/**
 * Schedule a command. Commands must target the current tick or later; in
 * lockstep play they are scheduled a few ticks ahead to absorb latency.
 */
export function queueCommand(world: World, command: Command): boolean {
  if (command.tick < world.tick) return false;
  world.commands.push(command);
  // Stable sort: by tick, then team, then arrival order.
  world.commands.sort((a, b) => a.tick - b.tick || a.team - b.team);
  return true;
}

export function applyCommands(ctx: TickContext): void {
  const { world } = ctx;
  while (world.commands.length > 0 && world.commands[0]!.tick <= world.tick) {
    const command = world.commands.shift()!;
    const reason = applyCommand(ctx, command);
    if (reason) world.events.push({ type: "rejected", command, reason });
    // A computer player's commands aren't logged: replaying the seed decides them again.
    else if (!world.teams[command.team]?.ai) world.log.push(command);
  }
}

/** Ground you can send someone to: not cliffs or walls. A building counts: they go beside it. */
const walkable = (world: World, x: number, y: number) => {
  const col = Math.floor(x / TILE);
  const row = Math.floor(y / TILE);
  return isWalkableTile(world.terrain, col, row) || world.terrain.built?.[row * world.terrain.cols + col] === 1 && tileAt(world.terrain, col, row) === TILE_OPEN;
};

/** Where a body actually ends up for a point: beside a building rather than in it. */
const landing = (world: World, x: number, y: number, r: number) => nearestFit(world.terrain, x, y, r) ?? { x, y };

/** Returns a rejection reason, or null when the command was applied. */
function applyCommand(ctx: TickContext, command: Command): string | null {
  const { world, content } = ctx;
  const issuer = world.teams[command.team]!;
  if (!issuer || issuer.controller !== "human") return "no such player";
  if (issuer.downTick !== null) return "offline";
  switch (command.type) {
    case "ally": {
      const reason = allyBlocker(world, command.team, command.with);
      if (reason) return reason;
      if (offerAlliance(world, command.team, command.with)) {
        world.events.push({ type: "allied", team: command.team, with: command.with });
        alliancesChanged(ctx);
      } else {
        world.events.push({ type: "ally-offer", team: command.team, with: command.with });
      }
      return null;
    }
    case "unally": {
      const reason = unallyBlocker(world, command.team, command.with);
      if (reason) return reason;
      breakAlliance(world, command.team, command.with);
      world.events.push({ type: "unallied", team: command.team, with: command.with });
      alliancesChanged(ctx);
      return null;
    }
    case "build": {
      const reason = canPlace(world, content, command.team, command.building, command.col, command.row);
      if (reason) return reason;
      const team = world.teams[command.team]!;
      const cost = buildCost(world, content, team.id, command.building);
      team.money -= cost;
      const building = placeBuilding(world, content, team.id, command.building, command.col, command.row, false);
      building.paid = cost;
      ctx.byId.set(building.id, building);
      return null;
    }
    case "fork":
      return applyFork(ctx, command);
    case "decommission":
      return applyDecommission(ctx, command);
    case "dismiss":
      return applyDismiss(ctx, command);
    case "rally":
      return applyRally(ctx, command);
    case "order":
      return applyOrder(ctx, command);
    case "research": {
      const team = world.teams[command.team]!;
      const reason = canResearch(content, team, command.upgrade, world);
      if (reason) return reason;
      // WC3 style: the entry is paid for as it's queued, priced and timed for
      // the level it will be once everything queued ahead finishes.
      const next = nextQueued(content, team, command.upgrade);
      team.money -= next.cost;
      const slot = slotOf(content, command.upgrade);
      const entry = { upgrade: command.upgrade, ticks: next.ticks, paid: next.cost };
      if (team[slot]) waitingOf(team, slot).push(entry);
      else team[slot] = { upgrade: command.upgrade, remaining: next.ticks };
      return null;
    }
    case "cancelResearch": {
      const team = world.teams[command.team]!;
      return cancelQueued(content, team, command.slot, command.index);
    }
    case "attack": {
      const team = world.teams[command.team]!;
      const hero = heroOf(world, team);
      if (!hero) return "no hero";
      const target = ctx.byId.get(command.targetId);
      if (!target || target.hp <= 0 || !hostile(world, target.team, team.id)) return "not an enemy";
      if (invulnerable(world, content, target)) return INVULNERABLE;
      team.hero!.focusId = target.id;
      team.hero!.cast = null;
      team.hero!.pickup = null;
      hero.moveTo = null;
      return null;
    }
    case "cast":
      return orderCast(ctx, world.teams[command.team]!, command);
    case "rank": {
      const building = ctx.byId.get(command.buildingId);
      const target = building?.kind === "building" ? building : undefined;
      const reason = rankBlocker(content, world, command.team, target);
      if (reason) return reason;
      startRank(content, world, target!);
      return null;
    }
    case "invoke": {
      const building = ctx.byId.get(command.buildingId);
      if (!building || building.kind !== "building" || building.team !== command.team || building.hp <= 0) return "not your building";
      const reason = invokeBlocker(ctx, building);
      if (reason) return reason;
      invoke(ctx, building, false);
      return null;
    }
    case "learn": {
      const team = world.teams[command.team]!;
      const reason = learnBlocker(content, team, command.ability);
      if (reason) return reason;
      team.hero!.ranks[command.ability] = (team.hero!.ranks[command.ability] ?? 0) + 1;
      return null;
    }
    case "move":
      // Before the core, "move" walks the deploy agent; after, the hero.
      if (world.teams[command.team]!.coreId !== -1) return moveHero(ctx, command);
      return moveBuilder(ctx, command);
    case "found":
      return moveBuilder(ctx, command);
    case "trainAgent":
      return trainAgent(ctx, command);
    case "rentCompute":
      return rentCompute(ctx, command);
    case "buyItem":
      return applyBuy(ctx, command);
    case "sellItem":
      return applySell(ctx, command);
    case "useItem":
      return applyUse(ctx, command);
    case "pickUp":
      return applyPickUp(ctx, command);
  }
}

/** Rent Spot Capacity: +compute for a while, one rental at a time, dearer each time. */
function rentCompute(ctx: TickContext, command: Extract<Command, { type: "rentCompute" }>): string | null {
  const { world, content } = ctx;
  const team = world.teams[command.team]!;
  if (team.coreId === -1) return "no core";
  if (team.spot !== null) return "spot capacity already running";
  const cost = spotCost(content, team);
  if (team.money < cost) return "not enough $";
  const spot = content.economy.spot;
  team.money -= cost;
  team.spot = { compute: spot.compute[Math.min(tierOf(content, team), spot.compute.length - 1)]!, untilTick: world.tick + spot.ticks };
  team.spotRentals += 1;
  world.events.push({ type: "spotStarted", team: team.id });
  return null;
}

/**
 * Train a deploy agent at one of your finished cores ($ the core's price):
 * it walks to a site and founds an expansion there. One agent at a time; if
 * it dies on the way, the $ is gone.
 */
function trainAgent(ctx: TickContext, command: Extract<Command, { type: "trainAgent" }>): string | null {
  const { world, content } = ctx;
  const team = world.teams[command.team]!;
  const core = ctx.byId.get(command.coreId);
  if (!core || core.kind !== "building" || core.team !== team.id || core.hp <= 0 || !isCore(content, team, core)) return "not your core";
  if (core.buildRemaining > 0) return "still building";
  const agent = ctx.byId.get(team.builderId);
  if (agent && agent.hp > 0) return "an agent is already out";
  const race = content.races[team.raceId]!;
  const cost = content.buildings[race.core]!.cost;
  if (team.money < cost) return "not enough $";
  team.money -= cost;
  // Out the front of the core, where spawners put their units: at its centre
  // it would sit inside the footprint, under the core, where you can't click it.
  const spawned = spawnUnit(ctx, team.id, race.builder!, core, core.x, core.y + core.radius + 16, "builder");
  team.builderId = spawned.id;
  return null;
}

/**
 * Sides changed: nobody keeps fighting a new ally, and gates open (or shut)
 * for the new sides, so paths are worked out again.
 */
function alliancesChanged(ctx: TickContext): void {
  const { world } = ctx;
  const friendly = (owner: Entity, id: number | null | undefined) => {
    const other = id === null || id === undefined ? undefined : ctx.byId.get(id);
    return other !== undefined && !hostile(world, owner.team, other.team);
  };
  for (const entity of world.entities) {
    if (friendly(entity, entity.targetId)) entity.targetId = null;
    if (entity.kind !== "unit") continue;
    if (friendly(entity, entity.provokedBy)) entity.provokedBy = undefined;
    if (friendly(entity, entity.tauntedBy)) entity.tauntedBy = undefined;
  }
  for (const team of world.teams) {
    const target = team.hero?.focusId == null ? undefined : ctx.byId.get(team.hero.focusId);
    if (target && !hostile(world, team.id, target.team)) team.hero!.focusId = null;
  }
  world.nav.builtKey = undefined;
}

function applyOrder(ctx: TickContext, command: OrderCommand): string | null {
  const { world } = ctx;
  if (!Array.isArray(command.unitIds) || command.unitIds.length === 0) return "no units";
  if (command.unitIds.length > MAX_ORDER_UNITS) return "too many units";
  if (!walkable(world, command.x, command.y)) return "can't go there";
  const units = [];
  for (const id of command.unitIds) {
    const unit = ctx.byId.get(id);
    // Units that died since the order was given just drop out.
    if (unit?.kind === "unit" && unit.team === command.team && (unit.mode === "guard" || unit.mode === "builder") && unit.hp > 0) units.push(unit);
  }
  if (units.length === 0) return "no units";
  const point = { x: command.x, y: command.y };
  // A bigger group needs more room at the destination. Part of a split order
  // spreads for the whole group (see OrderCommand.group).
  const group = Number.isInteger(command.group) ? Math.min(Math.max(command.group!, units.length), MAX_ORDER_UNITS * 10) : units.length;
  const spread = Math.min(ORDER_SPREAD_MAX, Math.max(RALLY_SPREAD / 2, Math.round(ORDER_SPREAD_PER_UNIT * Math.sqrt(group) * 2)));
  const groupSpread = group === 1 ? 0 : spread;
  for (const unit of units) {
    // The deploy agent walks exactly where it's sent (its founding site is
    // set separately, by a found order).
    if (unit.mode === "builder") {
      unit.moveTo = landing(world, point.x, point.y, unit.radius);
      unit.foundAt = null;
      continue;
    }
    unit.commanded = true;
    // Queued behind an order still under way: wait its turn (see guard).
    if (command.queue && unit.order !== null) {
      if ((unit.waypoints?.length ?? 0) >= MAX_WAYPOINTS) continue;
      (unit.waypoints ??= []).push({ x: point.x, y: point.y, attack: command.attack, spread: groupSpread });
      continue;
    }
    unit.waypoints = undefined;
    sendHome(world, unit, point, groupSpread);
    unit.order = command.attack ? "attack" : "move";
    // A plain move drops whatever it was fighting.
    if (!command.attack) unit.targetId = null;
  }
  return null;
}

function moveHero(ctx: TickContext, command: Extract<Command, { type: "move" }>): string | null {
  const { world } = ctx;
  const team = world.teams[command.team]!;
  const hero = heroOf(world, team);
  if (!hero) return "no hero";
  if (!walkable(world, command.x, command.y)) return "can't walk there";
  hero.moveTo = landing(world, command.x, command.y, hero.radius);
  team.hero!.focusId = null;
  team.hero!.cast = null;
  team.hero!.pickup = null;
  return null;
}

function moveBuilder(ctx: TickContext, command: Extract<Command, { type: "move" | "found" }>): string | null {
  const { world, content } = ctx;
  const builder = ctx.byId.get(world.teams[command.team]!.builderId);
  if (!builder || builder.kind !== "unit" || builder.hp <= 0) return "no builder";
  if (command.type === "found") {
    const reason = canFound(world, content, command.team, command.col, command.row);
    if (reason) return reason;
    builder.moveTo = footprintCenter(command.col, command.row, 2);
    builder.foundAt = { col: command.col, row: command.row };
  } else {
    if (!walkable(world, command.x, command.y)) return "can't walk there";
    builder.moveTo = landing(world, command.x, command.y, builder.radius);
    builder.foundAt = null;
  }
  return null;
}

function applyRally(ctx: TickContext, command: RallyCommand): string | null {
  const { world, content } = ctx;
  const team = world.teams[command.team]!;
  const building = ctx.byId.get(command.buildingId);
  if (!building || building.kind !== "building" || building.team !== command.team || building.hp <= 0) {
    return "not your building";
  }
  const core = isCore(content, team, building);
  const def = content.buildings[building.defId]!;
  if (!core && !def.spawn && !def.invoke) return "doesn't spawn units";
  if (!walkable(world, command.x, command.y)) return "can't rally there";
  const point = { x: command.x, y: command.y };
  building.rally = point;

  // Send the units already out there, not just new ones. A core's rally
  // moves the guards of the spawners that follow it (their nearest core);
  // any other building moves its own.
  for (const unit of world.entities) {
    // Units you've ordered somewhere are yours to move, not the rally's.
    if (unit.kind !== "unit" || unit.team !== team.id || unit.mode !== "guard" || unit.spawnerId < 0 || unit.commanded) continue;
    const spawner = ctx.byId.get(unit.spawnerId);
    if (spawner?.kind !== "building") continue;
    const affected = core
      ? spawner.rally === null && homeCore(world, content, spawner)?.id === building.id
      : spawner.id === building.id;
    if (affected) sendHome(world, unit, point);
  }
  return null;
}
