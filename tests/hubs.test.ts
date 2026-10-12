import { describe, expect, it } from "vitest";
import {
  TILE_OPEN,
  createWorld,
  generateTerrain,
  hashWorld,
  hubBuilding,
  queueCommand,
  step,
  userCapacity,
  type World,
} from "../src/sim";
import { dealDamage } from "../src/sim/combat";
import { makeContext } from "../src/sim/context";
import { placeBuilding } from "../src/sim/entities";
import { bfs } from "../src/sim/terrain/grid";
import { content, SETUP } from "./fixtures";

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 1);

/** Put a finished Mesh Node of `team` right beside hub `i`, so its network reaches it. */
function reach(world: World, i: number, team = 0) {
  const hub = world.terrain.hubs[i]!;
  const { cols, tiles } = world.terrain;
  for (const [dc, dr] of [[-2, 0], [3, 0], [0, -2], [0, 3], [-2, -2], [3, 3], [-2, 3], [3, -2]] as const) {
    const col = hub.col + dc;
    const row = hub.row + dr;
    if (tiles[row * cols + col] !== TILE_OPEN) continue;
    if (world.entities.some((e) => e.kind === "building" && e.col === col && e.row === row)) continue;
    return placeBuilding(world, content, team, "mesh-node", col, row, true);
  }
  throw new Error(`no room beside hub ${i}`);
}
const second = (world: World, seconds = 1) => {
  for (let i = 0; i < 20 * seconds; i++) step(world, content);
};

describe("user hubs", () => {
  it("every map has a campus near every start and some metros, on open, flat, reachable ground", () => {
    for (const seed of SEEDS) {
      const terrain = generateTerrain(seed);
      const { cols, rows } = terrain;
      const campuses = terrain.hubs.filter((h) => h.size === "campus");
      expect(campuses.length, `seed ${seed}`).toBe(terrain.starts.length);
      expect(terrain.hubs.filter((h) => h.size === "metro").length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      const dist = bfs(terrain.tiles, cols, rows, terrain.starts[0]!);
      for (const hub of terrain.hubs) {
        const level = terrain.heights[hub.row * cols + hub.col];
        for (let r = hub.row; r < hub.row + 2; r++) {
          for (let c = hub.col; c < hub.col + 2; c++) {
            expect(terrain.tiles[r * cols + c], `seed ${seed} hub ${hub.col},${hub.row}`).toBe(TILE_OPEN);
            expect(terrain.heights[r * cols + c]).toBe(level);
            expect(dist[r * cols + c]).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it("nobody holds a hub at the start, and nothing can be built on one", () => {
    const world = createWorld(content, SETUP);
    expect(world.hubs.every((h) => h.owner === -1)).toBe(true);
    const hub = world.terrain.hubs[0]!;
    world.teams[0]!.money = 10_000;
    reach(world, 0);
    queueCommand(world, { type: "build", tick: world.tick, team: 0, building: "server-rack", col: hub.col, row: hub.row });
    step(world, content);
    expect(world.events.some((e) => e.type === "rejected" && e.reason === "users live there")).toBe(true);
  });

  it("bring your network within reach and it connects: more user room", () => {
    const world = createWorld(content, SETUP);
    const before = userCapacity(world, content, world.teams[0]!);
    reach(world, 0);
    second(world);
    expect(world.hubs[0]!.owner).toBe(0);
    const spot = world.terrain.hubs[0]!;
    expect(hubBuilding(world, spot)?.team).toBe(0);
    expect(userCapacity(world, content, world.teams[0]!)).toBe(before + content.buildings[spot.size]!.userCapacity!);
  });

  it("cut it off from your network and it's gone, but free to reconnect", () => {
    const world = createWorld(content, SETUP);
    const node = reach(world, 0);
    second(world);
    node.hp = 0;
    second(world, 2);
    expect(world.hubs[0]!.owner).toBe(-1);
    expect(hubBuilding(world, world.terrain.hubs[0]!)).toBeUndefined();
    reach(world, 0);
    second(world);
    expect(world.hubs[0]!.owner).toBe(0);
  });

  it("knocked offline, nobody can reconnect it for a while", () => {
    const world = createWorld(content, SETUP);
    reach(world, 0);
    second(world);
    hubBuilding(world, world.terrain.hubs[0]!)!.hp = 0;
    second(world, 2);
    expect(world.hubs[0]!.owner).toBe(-1);
    const wait = content.economy.hubs.reconnectTicks / 20;
    second(world, wait - 3);
    expect(world.hubs[0]!.owner).toBe(-1);
    second(world, 4);
    expect(world.hubs[0]!.owner).toBe(0);
  });

  it("hitting a hub drives users away, like any building that serves them", () => {
    const frozen = structuredClone(content);
    frozen.economy = { ...content.economy, growthPerSecond: 0, minArrivalsPerSecond: 0 };
    const world = createWorld(frozen, SETUP);
    reach(world, 0);
    for (let i = 0; i < 20; i++) step(world, frozen);
    world.teams[0]!.users = 40;
    const hub = hubBuilding(world, world.terrain.hubs[0]!)!;
    const creep = { ...hub, id: -9, team: 1 } as typeof hub;
    dealDamage(makeContext(world, frozen), creep, hub, 240);
    expect(world.teams[0]!.users).toBeLessThan(40);
  });

  it("is deterministic", () => {
    const run = () => {
      const world = createWorld(content, SETUP);
      reach(world, 0);
      for (let i = 0; i < 3000; i++) step(world, content);
      return hashWorld(world);
    };
    expect(run()).toBe(run());
  });
});
