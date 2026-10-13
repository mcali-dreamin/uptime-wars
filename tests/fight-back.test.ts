import { describe, expect, it } from "vitest";
import { TILE, TILE_OPEN, createWorld, step, type Building, type Unit, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { placeBuilding, spawnUnit } from "../src/sim/entities";
import { content } from "./fixtures";

/**
 * A Web App, and a firewall a few tiles toward the creep: the creep locks on
 * to the Web App from afar, then walks into the firewall's range.
 */
function scene(creepId: string): { world: World; app: Building; tower: Building; creep: Unit } {
  const world = createWorld(content, { seed: 1234, races: ["open-source", "botnet"], startWithCore: true });
  world.waves.nextWaveTick = 1e9;
  const core = world.entities.find((e) => e.id === world.teams[0]!.coreId) as Building;
  const { cols, tiles } = world.terrain;
  // Find a row near the core with a clear run of open tiles: app, gap, tower, then the creep further out.
  for (let dr = -6; dr <= 6; dr += 1) {
    for (const dir of [1, -1]) {
      const row = core.row + dr;
      const cs = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((d) => core.col + dir * d);
      if (!cs.every((c) => tiles[row * cols + c] === TILE_OPEN)) continue;
      if (world.terrain.heights[row * cols + cs[0]!] !== world.terrain.heights[row * cols + cs[10]!]) continue;
      const app = placeBuilding(world, content, 0, "web-app", cs[0]!, row, true);
      const tower = placeBuilding(world, content, 0, "firewall", cs[4]!, row, true);
      const ctx = makeContext(world, content);
      const creep = spawnUnit(ctx, 1, creepId, tower, (cs[10]! + 0.5) * TILE, (row + 0.5) * TILE, "roam");
      creep.targetId = app.id;
      return { world, app, tower, creep };
    }
  }
  throw new Error("no room for the scene");
}

const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i += 1) step(w, content);
};

describe("creeps fight back", () => {
  it("a creep shot by a tower turns on the tower, not the Web App it was heading for", () => {
    const { world, app, tower, creep } = scene("bot");
    let turned = false;
    for (let i = 0; i < 200 && creep.hp > 0 && !turned; i += 1) {
      step(world, content);
      turned = creep.targetId === tower.id;
    }
    expect(turned).toBe(true);
    expect(app.hp).toBe(app.maxHp);
  });

  it("a siege creep hits back at the tower too (it goes for buildings anyway)", () => {
    const { world, tower, creep } = scene("brute-forcer");
    let turned = false;
    for (let i = 0; i < 200 && creep.hp > 0 && !turned; i += 1) {
      step(world, content);
      turned = creep.targetId === tower.id;
    }
    expect(turned).toBe(true);
  });

  it("a phisher ignores the tower and keeps going for your users", () => {
    const { world, tower, creep } = scene("phisher");
    let turned = false;
    for (let i = 0; i < 200 && creep.hp > 0; i += 1) {
      step(world, content);
      if (creep.targetId === tower.id) turned = true;
    }
    expect(turned).toBe(false);
  });

  it("stops caring once the shooting stops", () => {
    const { world, tower, creep } = scene("bot");
    run(world, 5);
    creep.provokedBy = tower.id;
    creep.provokedAt = world.tick - 1000;
    tower.hp = 0;
    run(world, 2);
    expect(creep.targetId).not.toBe(tower.id);
  });
});
