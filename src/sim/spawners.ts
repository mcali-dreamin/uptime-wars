// Buildings that spawn defenders on a timer.

import type { TickContext } from "./context";
import { sendHome, spawnInterval, spawnUnit } from "./entities";
import { randomInt } from "./rng";
import type { Building } from "./types";

export function tickSpawners(ctx: TickContext): void {
  const { world, content } = ctx;
  // Snapshot: units spawned this tick are appended and must not be iterated.
  const buildings = world.entities.filter(
    (entity): entity is Building => entity.kind === "building" && entity.hp > 0,
  );
  const alive = new Map<number, number>();
  for (const entity of world.entities) {
    if (entity.kind === "unit" && entity.hp > 0 && entity.spawnerId >= 0) {
      alive.set(entity.spawnerId, (alive.get(entity.spawnerId) ?? 0) + 1);
    }
  }
  for (const building of buildings) {
    const spawn = content.buildings[building.defId]!.spawn;
    if (!spawn || building.buildRemaining > 0) continue;
    building.spawnTimer -= 1;
    if (building.spawnTimer > 0) continue;
    const room = Math.min(spawn.count, spawn.maxAlive - (alive.get(building.id) ?? 0));
    for (let i = 0; i < room; i += 1) {
      const x = building.x + randomInt(world, -20, 20);
      const y = building.y + building.radius + 10 + randomInt(world, 0, 8);
      const unit = spawnUnit(ctx, building.team, spawn.unit, building, x, y, "guard");
      unit.spawnerId = building.id;
      const rally = building.rally ?? world.teams[building.team].rally;
      if (rally) sendHome(world, unit, rally);
    }
    building.spawnTimer = spawnInterval(content, world.teams[building.team], building.defId);
  }
}
