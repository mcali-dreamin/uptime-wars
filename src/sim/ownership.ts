// Ownership changes. transferOwnership is the ONLY place the sim assigns
// `entity.team` after an entity is spawned (tests/sites.test.ts greps for
// that), so everything keyed on the owner (fog, compute, income, targeting)
// follows from one choke point.

import type { TickContext } from "./context";
import { centerOf, cancelQueued, queueOf } from "./upgrades";
import { neutralTeam } from "./teams";
import type { Entity, Team, TeamId } from "./types";

/** Is this a capturable site (see neutrals.json -> sites)? */
export function isSite(content: TickContext["content"], entity: Entity): boolean {
  return entity.kind === "building" && content.buildings[entity.defId]?.site === true;
}

/**
 * Hand `entity` to `team`. Capture state, its target and cooldown are
 * cleared; a building's income timer starts over so a flip can't pay twice;
 * any research queue held at it is cancelled and refunded to the old owner
 * (the #141 path, cancelQueued). Raises siteCaptured when it goes to a
 * player-side team, siteLost when it falls back to neutral from one (`by`
 * is who did it, default the new owner).
 */
export function transferOwnership(ctx: TickContext, entity: Entity, team: TeamId, by: TeamId = team): void {
  const { world, content } = ctx;
  const from = entity.team;
  if (from === team) return;
  const old = world.teams[from]!;
  if (entity.kind === "building") {
    // Queues live at a building: the core's at the core, the lab's at the upgrade center.
    if (old.coreId === entity.id) cancelAll(content, old, "research");
    if (centerOf(world, content, old) === entity) cancelAll(content, old, "labResearch");
    entity.incomeTimer = content.buildings[entity.defId]?.income?.intervalTicks ?? 0;
    entity.rally = null;
    entity.jammedUntil = undefined;
    entity.captureTeam = undefined;
    entity.captureProgress = undefined;
  } else {
    entity.moveTo = null;
    entity.order = null;
    entity.waypoints = undefined;
    entity.provokedBy = undefined;
    entity.provokedAt = undefined;
  }
  entity.team = team;
  entity.targetId = null;
  entity.attackCooldown = 0;
  const neutral = neutralTeam(world)?.id;
  if (team !== neutral) world.events.push({ type: "siteCaptured", team, from, x: entity.x, y: entity.y, id: entity.id });
  else if (from !== neutral) world.events.push({ type: "siteLost", team: from, by, x: entity.x, y: entity.y, id: entity.id });
}

function cancelAll(content: TickContext["content"], team: Team, slot: "research" | "labResearch"): void {
  // Last entry first, so a head is never cancelled out from under the ones waiting behind it.
  for (let i = queueOf(team, slot).length - 1; i >= 0; i -= 1) {
    if (i < queueOf(team, slot).length) cancelQueued(content, team, slot, i);
  }
}
