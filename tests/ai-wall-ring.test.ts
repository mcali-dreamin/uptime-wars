import { describe, expect, it } from "vitest";
import { createWorld, tierUpgrade, type Building } from "../src/sim";
import { buildRing, rankWalls } from "../src/sim/ai/aggressive";
import { applyCommands, queueCommand } from "../src/sim/commands";
import { makeContext } from "../src/sim/context";
import { TILE_OPEN, isWalkableTile } from "../src/sim/terrain";
import { syncWalls, terrainFor } from "../src/sim/walls";
import { canPlace } from "../src/sim/placement";
import { enclosureBonus } from "../src/sim/enclosure";
import { content } from "./fixtures";

function setup() {
  const world = createWorld(content, { seed: 42, races: ["walled-garden", "botnet"], startWithCore: true, ai: ["normal"] });
  const team = world.teams[0]!;
  const core = world.entities.find(e => e.id === team.coreId) as Building;
  world.entities = [core];
  world.terrain.tiles.fill(TILE_OPEN);
  team.upgrades[tierUpgrade(content)!] = 2;
  team.users = 100000;
  team.money = 100000;
  const level = { ...content.difficulties.normal!, aggressive: true, tierReserve: 100 };
  const issue = (c: Parameters<typeof buildRing>[4] extends (c: infer C) => unknown ? C : never) => queueCommand(world, { ...c, tick: world.tick, team: team.id });
  return { world, team, core, level, issue };
}

describe("aggressive wall ring", () => {
  it("builds a stable gated square in small batches, then ranks it without rejected orders", () => {
    const { world, team, core, level, issue } = setup();
    for (let i = 0; i < 40; i++) {
      buildRing(world, content, team, level, issue);
      const builds = world.commands.filter(c => c.type === "build");
      expect(builds.length).toBeLessThanOrEqual(4);
      for (const c of builds) if (c.type === "build") expect(canPlace(world, content, team.id, c.building, c.col, c.row)).toBeNull();
      applyCommands(makeContext(world, content));
      for (const e of world.entities) if (e.kind === "building") e.buildRemaining = 0;
      world.tick++;
    }
    const radius = team.ai!.wallRing!.radius;
    const ring = world.entities.filter((e): e is Building => e.kind === "building" && e.id !== core.id);
    expect(ring).toHaveLength(8 * radius);
    expect(ring.filter(e => e.defId === "gate")).toHaveLength(4);
    for (const e of ring) expect(Math.max(Math.abs(e.col - core.col), Math.abs(e.row - core.row))).toBe(radius);
    syncWalls(world, content);
    // Flood the friendly pathing view from inside to outside: gates must let
    // units escape even though the same ring closes the garden enclosure.
    const terrain = terrainFor(world, team.id).terrain;
    const seen = new Set<string>();
    const queue = [[core.col - 1, core.row - 1]];
    let escaped = false;
    for (let i = 0; i < queue.length; i++) {
      const [col, row] = queue[i]!;
      if (Math.max(Math.abs(col! - core.col), Math.abs(row! - core.row)) > radius) { escaped = true; break; }
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const c = col! + dc!, r = row! + dr!, key = `${c}:${r}`;
        if (!seen.has(key) && isWalkableTile(terrain, c, r)) { seen.add(key); queue.push([c, r]); }
      }
    }
    expect(escaped).toBe(true);
    expect(enclosureBonus(world, content, core)?.armor).toBe(3);
    rankWalls(world, content, team, level, issue);
    expect(world.commands.some(c => c.type === "rank")).toBe(true);
    applyCommands(makeContext(world, content));
    expect(ring.every(e => (e.refitRemaining ?? 0) > 0)).toBe(true);
    expect(world.events.filter(e => e.type === "rejected")).toEqual([]);
  });

  it("skips blocked tiles and never queues duplicate same-tick segments", () => {
    const { world, team, core, level, issue } = setup();
    // Core footprint 2 plus margin 3 gives radius 4. A cliff closes this tile.
    world.terrain.tiles[(core.row - 4) * world.terrain.cols + core.col - 4] = 1;
    buildRing(world, content, team, level, issue);
    buildRing(world, content, team, level, issue);
    const builds = world.commands.filter(c => c.type === "build");
    const tiles = builds.map(c => c.type === "build" ? `${c.col}:${c.row}` : "");
    expect(new Set(tiles).size).toBe(tiles.length);
    expect(tiles).not.toContain(`${core.col - 4}:${core.row - 4}`);
    applyCommands(makeContext(world, content));
    expect(world.events.filter(e => e.type === "rejected")).toEqual([]);
  });

  it("does nothing when not capped or below reserve", () => {
    const { world, team, level, issue } = setup();
    team.users = 0;
    buildRing(world, content, team, level, issue);
    expect(world.commands).toEqual([]);
    team.users = 100000;
    team.money = level.tierReserve + 19;
    buildRing(world, content, team, level, issue);
    expect(world.commands).toEqual([]);
  });

  it("budgets earlier orders and ring segments before wall ranks", () => {
    const { world, team, level, issue } = setup();
    team.money = 1180;
    issue({ type: "rentCompute" });
    buildRing(world, content, team, level, issue);
    rankWalls(world, content, team, level, issue);
    applyCommands(makeContext(world, content));
    expect(team.money).toBeGreaterThanOrEqual(level.tierReserve);
    expect(world.events.filter(e => e.type === "rejected")).toEqual([]);
  });
});
