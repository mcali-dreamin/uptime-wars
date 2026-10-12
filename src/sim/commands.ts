// Player commands. Everything a player does goes through here, scheduled for
// a tick, so a match is fully described by its seed plus its command log.

import type { TickContext } from "./context";
import { placeBuilding, sendHome } from "./entities";
import { TILE, footprintCenter } from "./map";
import { buildCost, canFound, canPlace, isCore } from "./placement";
import { canResearch, nextLevel } from "./upgrades";
import { isWalkableTile } from "./terrain";
import { MAX_ORDER_UNITS, ORDER_SPREAD_MAX, ORDER_SPREAD_PER_UNIT, RALLY_SPREAD } from "./tuning";
import type { Command, OrderCommand, RallyCommand, World } from "./types";

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
  }
}

const walkable = (world: World, x: number, y: number) =>
  isWalkableTile(world.terrain, Math.floor(x / TILE), Math.floor(y / TILE));

/** Returns a rejection reason, or null when the command was applied. */
function applyCommand(ctx: TickContext, command: Command): string | null {
  const { world, content } = ctx;
  const issuer = world.teams[command.team]!;
  if (!issuer || issuer.controller !== "human") return "no such player";
  if (issuer.downTick !== null) return "offline";
  switch (command.type) {
    case "build": {
      const reason = canPlace(world, content, command.team, command.building, command.col, command.row);
      if (reason) return reason;
      const team = world.teams[command.team]!;
      team.compute -= buildCost(content, team.raceId, command.building);
      const building = placeBuilding(world, content, team.id, command.building, command.col, command.row, false);
      ctx.byId.set(building.id, building);
      return null;
    }
    case "rally":
      return applyRally(ctx, command);
    case "order":
      return applyOrder(ctx, command);
    case "research": {
      const team = world.teams[command.team]!;
      const reason = canResearch(content, team, command.upgrade);
      if (reason) return reason;
      const next = nextLevel(content, team, command.upgrade);
      team.compute -= next.cost;
      team.research = { upgrade: command.upgrade, remaining: next.ticks };
      return null;
    }
    case "found":
    case "move": {
      const builder = ctx.byId.get(world.teams[command.team]!.builderId);
      if (!builder || builder.kind !== "unit" || builder.hp <= 0) return "no builder";
      if (command.type === "found") {
        const reason = canFound(world, content, command.team, command.col, command.row);
        if (reason) return reason;
        builder.moveTo = footprintCenter(command.col, command.row, 2);
        builder.foundAt = { col: command.col, row: command.row };
      } else {
        if (!walkable(world, command.x, command.y)) return "can't walk there";
        builder.moveTo = { x: command.x, y: command.y };
        builder.foundAt = null;
      }
      return null;
    }
  }
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
    if (unit?.kind === "unit" && unit.team === command.team && unit.mode === "guard" && unit.hp > 0) units.push(unit);
  }
  if (units.length === 0) return "no units";
  const point = { x: command.x, y: command.y };
  // A bigger group needs more room at the destination.
  const spread = Math.min(ORDER_SPREAD_MAX, Math.max(RALLY_SPREAD / 2, Math.round(ORDER_SPREAD_PER_UNIT * Math.sqrt(units.length) * 2)));
  for (const unit of units) {
    sendHome(world, unit, point, units.length === 1 ? 0 : spread);
    unit.order = command.attack ? "attack" : "move";
    unit.commanded = true;
    // A plain move drops whatever it was fighting.
    if (!command.attack) unit.targetId = null;
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
  const global = isCore(content, team, building);
  if (!global && !content.buildings[building.defId]!.spawn) return "doesn't spawn units";
  if (!walkable(world, command.x, command.y)) return "can't rally there";
  const point = { x: command.x, y: command.y };
  if (global) team.rally = point;
  else building.rally = point;

  // Send the units already out there, not just new ones.
  for (const unit of world.entities) {
    // Units you've ordered somewhere are yours to move, not the rally's.
    if (unit.kind !== "unit" || unit.team !== team.id || unit.mode !== "guard" || unit.spawnerId < 0 || unit.commanded) continue;
    const spawner = ctx.byId.get(unit.spawnerId);
    if (spawner?.kind !== "building") continue;
    const affected = global ? spawner.rally === null : spawner.id === building.id;
    if (affected) sendHome(world, unit, point);
  }
  return null;
}
