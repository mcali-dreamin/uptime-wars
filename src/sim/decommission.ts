// Taking things back: tear down your own buildings for part of what they
// cost, or send your own units away. A base you overbuilt (too many
// Functions burning $, a tower in the wrong place) isn't stuck that way.
//
// Both only mark the entities dead (hp 0); the end of the tick sweeps them
// out and re-reads walls and paths, the same as anything destroyed. They
// raise "expired" (a quiet fizzle, no bounty, no "base lost" alarm) rather
// than "death".

import type { TickContext } from "./context";
import { isCore } from "./placement";
import { MAX_ORDER_UNITS } from "./tuning";
import type { Building, DecommissionCommand, DismissCommand, Unit } from "./types";

/** What decommissioning this building gives back: all of it while it's still deploying, part once it stands. */
export function decommissionRefund(content: TickContext["content"], building: Building): number {
  const paid = building.paid ?? 0;
  if (building.buildRemaining > 0) return paid;
  return Math.floor((paid * content.economy.decommissionRefundPermille) / 1000);
}

/** Why this building can't be torn down by this team, or null if it can. */
export function decommissionBlocker(ctx: Pick<TickContext, "world" | "content">, teamId: number, building: Building | undefined): string | null {
  if (!building || building.kind !== "building" || building.team !== teamId || building.hp <= 0) return "not your building";
  // Every core holds the network up: losing one is the game's job, not yours.
  if (isCore(ctx.content, ctx.world.teams[teamId]!, building)) return "can't decommission a core";
  return null;
}

/** A unit of yours you may send away: a fighting one, never the hero or the deploy agent. */
export function dismissable(teamId: number, unit: Unit | undefined): boolean {
  return unit !== undefined && unit.kind === "unit" && unit.team === teamId && unit.mode === "guard" && unit.hp > 0;
}

export function applyDecommission(ctx: TickContext, command: DecommissionCommand): string | null {
  const { world, content } = ctx;
  if (!Array.isArray(command.buildingIds) || command.buildingIds.length === 0) return "no buildings";
  if (command.buildingIds.length > MAX_ORDER_UNITS) return "too many buildings";
  const doomed: Building[] = [];
  let reason: string | null = null;
  for (const id of command.buildingIds) {
    const entity = ctx.byId.get(id);
    const building = entity?.kind === "building" ? entity : undefined;
    const blocker = decommissionBlocker(ctx, command.team, building);
    // The rest of a group still goes; say why one didn't, if none did.
    if (blocker) reason ??= blocker;
    else if (!doomed.includes(building!)) doomed.push(building!);
  }
  if (doomed.length === 0) return reason ?? "not your building";
  const team = world.teams[command.team]!;
  let refund = 0;
  for (const building of doomed) {
    refund += decommissionRefund(content, building);
    building.hp = 0;
    world.events.push({ type: "expired", id: building.id, x: building.x, y: building.y, team: building.team });
  }
  team.money += refund;
  world.events.push({ type: "decommissioned", team: team.id, buildings: doomed.length, units: 0, refund });
  return null;
}

export function applyDismiss(ctx: TickContext, command: DismissCommand): string | null {
  const { world } = ctx;
  if (!Array.isArray(command.unitIds) || command.unitIds.length === 0) return "no units";
  if (command.unitIds.length > MAX_ORDER_UNITS) return "too many units";
  let count = 0;
  for (const id of command.unitIds) {
    const entity = ctx.byId.get(id);
    const unit = entity?.kind === "unit" ? entity : undefined;
    if (!dismissable(command.team, unit)) continue;
    unit!.hp = 0;
    count += 1;
    world.events.push({ type: "expired", id: unit!.id, x: unit!.x, y: unit!.y, team: unit!.team });
  }
  if (count === 0) return "no units";
  world.events.push({ type: "decommissioned", team: command.team, buildings: 0, units: count, refund: 0 });
  return null;
}
