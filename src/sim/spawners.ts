// Buildings that spawn defenders on a timer.
//
// Compute is the army cap: a spawner only adds a unit if its upkeep fits in
// the compute you have free (supply minus what users and units already use).
// At the cap production stalls; build generators, or tech the core, to field
// more. More spawners make you reinforce faster, never bigger.

import type { TickContext } from "./context";
import { computeBalance, lagging, unitUpkeep } from "./economy";
import { sendHome, spawnInterval, spawnUnit } from "./entities";
import { randomInt } from "./rng";
import type { Building } from "./types";
import { squadBonus } from "./traits";

export function tickSpawners(ctx: TickContext): void {
  const { world, content } = ctx;
  // Snapshot: units spawned this tick are appended and must not be iterated.
  const buildings = world.entities.filter(
    (entity): entity is Building => entity.kind === "building" && entity.hp > 0,
  );
  const alive = new Map<number, number>();
  for (const entity of world.entities) {
    // Burst units (a function's scale-up) don't count against the standing squad.
    if (entity.kind === "unit" && entity.hp > 0 && entity.spawnerId >= 0 && entity.expiresAt === undefined) {
      alive.set(entity.spawnerId, (alive.get(entity.spawnerId) ?? 0) + 1);
    }
  }
  /** Compute each human team has free this tick, spent as units appear. */
  const free = new Map<number, number>();
  const freeFor = (teamId: number) => {
    let left = free.get(teamId);
    if (left === undefined) {
      const team = world.teams[teamId]!;
      const { supply, demand } = computeBalance(world, content, team);
      left = team.controller === "human" ? supply - demand : Infinity;
      free.set(teamId, left);
    }
    return left;
  };
  for (const team of world.teams) team.capped = false;
  for (const building of buildings) {
    const spawn = content.buildings[building.defId]!.spawn;
    if (!spawn || building.buildRemaining > 0) continue;
    // Jammed by a DDoS: the timer stalls.
    if (building.jammedUntil !== undefined && world.tick < building.jammedUntil) continue;
    if (lagging(world, building.team)) continue;
    if (building.spawnTimer > 0) building.spawnTimer -= 1;
    if (building.spawnTimer > 0) continue;
    // At the cap: hold, ready to go the moment there's room.
    const upkeep = unitUpkeep(content, spawn.unit);
    if (freeFor(building.team) < upkeep) {
      world.teams[building.team]!.capped = true;
      continue;
    }
    const extra = squadBonus(content, world.teams[building.team], spawn.unit);
    const room = Math.min(spawn.count + extra, spawn.maxAlive + extra - (alive.get(building.id) ?? 0));
    for (let i = 0; i < room && freeFor(building.team) >= upkeep; i += 1) {
      free.set(building.team, freeFor(building.team) - upkeep);
      const x = building.x + randomInt(world, -20, 20);
      const y = building.y + building.radius + 10 + randomInt(world, 0, 8);
      const unit = spawnUnit(ctx, building.team, spawn.unit, building, x, y, "guard");
      unit.spawnerId = building.id;
      const rally = building.rally ?? world.teams[building.team]!.rally;
      if (rally) sendHome(world, unit, rally);
    }
    building.spawnTimer = spawnInterval(content, world.teams[building.team]!, building.defId);
  }
}
