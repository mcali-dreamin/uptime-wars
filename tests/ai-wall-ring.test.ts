import { describe, expect, it } from "vitest";
import { createWorld, tierUpgrade, type Building } from "../src/sim";
import { buildRing, onWallRing, rankWalls } from "../src/sim/ai/aggressive";
import { tickAi } from "../src/sim/ai";
import { computeBalance, squadReserve } from "../src/sim/economy";
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

  it.each(["walled-garden", "open-source"])("%s does not wall when uncapped at tier 0 (or Open Source at tier 1)", race => {
    const { world, team, level, issue } = setup();
    team.raceId = race;
    team.users = 0;
    for (const tier of race === "open-source" ? [0, 1, 2] : [0]) {
      team.upgrades[tierUpgrade(content)!] = tier;
      buildRing(world, content, team, level, issue);
      rankWalls(world, content, team, level, issue);
      expect(world.commands).toEqual([]);
      expect(team.ai!.wallRing).toBeUndefined();
    }
  });

  it("keeps the reserve even for an uncapped enclosure race", () => {
    const { world, team, level, issue } = setup();
    team.users = 0;
    team.money = level.tierReserve + 19;
    buildRing(world, content, team, level, issue);
    expect(world.commands).toEqual([]);
  });

  it("builds, ranks and repairs its tier-1 enclosure without being compute-capped", () => {
    const { world, team, core, level, issue } = setup();
    team.users = 0;
    team.upgrades[tierUpgrade(content)!] = 1;
    const { supply, demand } = computeBalance(world, content, team);
    expect(supply - demand).toBeGreaterThanOrEqual(squadReserve(world, content, team));
    for (let i = 0; i < 12; i++) {
      buildRing(world, content, team, level, issue);
      expect(world.commands.filter(c => c.type === "build").length).toBeLessThanOrEqual(4);
      applyCommands(makeContext(world, content));
      for (const e of world.entities) if (e.kind === "building") e.buildRemaining = 0;
      world.tick++;
    }
    const ring = team.ai!.wallRing!;
    expect(world.entities).toHaveLength(1 + 8 * ring.radius);
    rankWalls(world, content, team, level, issue);
    expect(world.commands.some(c => c.type === "rank")).toBe(true);
    applyCommands(makeContext(world, content));
    world.tick++;
    const destroyed = world.entities.find(e => e.kind === "building" && e.id !== core.id) as Building;
    destroyed.hp = 0;
    buildRing(world, content, team, level, issue);
    expect(world.commands).toEqual([expect.objectContaining({ type: "build", building: destroyed.defId, col: destroyed.col, row: destroyed.row })]);
    applyCommands(makeContext(world, content));
    expect(world.entities.some(e => e.kind === "building" && e.hp > 0 && e.col === destroyed.col && e.row === destroyed.row)).toBe(true);
    expect(team.ai!.wallRing).toEqual(ring);
    expect(world.events.filter(e => e.type === "rejected")).toEqual([]);
  });

  it("base placement skips reserved ring tiles, including footprint edges", () => {
    const { world, team, core, level } = setup();
    team.users = 0;
    team.upgrades[tierUpgrade(content)!] = 1;
    const testContent = {
      ...content,
      difficulties: { ...content.difficulties, normal: { ...level, maxTier: 1, researchAbove: null, rankAbove: null, playsHero: false } },
      races: { ...content.races, "walled-garden": { ...content.races["walled-garden"]!, buildings: ["web-app"] } },
    };
    world.tick = level.buildEveryTicks;
    tickAi(world, testContent);
    const unreserved = world.commands.find(c => c.type === "build" && c.building === "web-app");
    expect(unreserved).toBeDefined();
    world.commands = [];
    team.ai!.wallRing = { coreId: core.id, radius: 2 };
    if (unreserved?.type === "build") expect(onWallRing(team, core, unreserved.col, unreserved.row, content.buildings["web-app"]!.footprint)).toBe(true);
    // The origin is inside the ring, but the far edge overlaps it.
    expect(onWallRing(team, core, core.col + 1, core.row, 2)).toBe(true);
    tickAi(world, testContent);
    const builds = world.commands.filter(c => c.type === "build" && c.building === "web-app");
    expect(builds).toHaveLength(1);
    for (const c of builds) if (c.type === "build") {
      for (let dr = 0; dr < content.buildings[c.building]!.footprint; dr++) {
        for (let dc = 0; dc < content.buildings[c.building]!.footprint; dc++) {
          expect(Math.max(Math.abs(c.col + dc - core.col), Math.abs(c.row + dr - core.row))).not.toBe(2);
        }
      }
    }
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
