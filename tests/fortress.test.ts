import { describe, expect, it } from "vitest";
import { TILE_RAMP, createWorld, fortressGates, fortressSpots, generateTerrain, step, type World } from "../src/sim";
import { bfs } from "../src/sim/terrain/grid";
import { content, SETUP } from "./fixtures";

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 1);
/** The nest's own C2 Servers (the hubs' squatters are covered in hubs.test.ts). */
const towers = (world: World) => {
  const nest = new Set(fortressSpots(world.terrain).map((s) => `${s.col},${s.row}`));
  return world.entities.filter(
    (e) => e.kind === "building" && e.team === 1 && e.defId === content.waves.fortress.building && nest.has(`${e.col},${e.row}`),
  );
};

describe("nest fortress", () => {
  it("on every map the nest sits on the backbone, with at least three gateways up, all reachable from every start", () => {
    for (const seed of SEEDS) {
      const terrain = generateTerrain(seed);
      const { cols, nest } = terrain;
      expect(terrain.heights[(nest.row + 1) * cols + nest.col + 1], `seed ${seed}`).toBe(2);
      const gates = fortressGates(terrain);
      expect(gates.length, `seed ${seed}`).toBeGreaterThanOrEqual(3);
      for (const gate of gates) expect(terrain.tiles[gate.row * cols + gate.col]).toBe(TILE_RAMP);
      for (const start of terrain.starts) {
        const dist = bfs(terrain.tiles, cols, terrain.rows, start);
        expect(dist[nest.row * cols + nest.col], `seed ${seed}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("C2 Servers stand guard from the first tick: one per gateway plus a ring round the nest", () => {
    const world = createWorld(content, SETUP);
    const spots = fortressSpots(world.terrain);
    expect(spots.length).toBeGreaterThanOrEqual(fortressGates(world.terrain).length + 3);
    expect(towers(world).length).toBe(spots.length);
    for (const t of towers(world)) expect(world.terrain.heights[(t as { row: number }).row * world.terrain.cols + (t as { col: number }).col]).toBe(2);
  });

  it("knocked-down C2 Servers come back every few waves, tougher", () => {
    const world = createWorld(content, SETUP);
    const before = towers(world);
    const baseHp = before[0]!.maxHp;
    for (const t of before) t.hp = 0;
    const every = content.waves.fortress.rebuildEvery;
    while (world.waves.nextIndex < every - 1) step(world, content);
    expect(towers(world).length).toBe(0);
    while (world.waves.nextIndex < every) step(world, content);
    const after = towers(world);
    expect(after.length).toBe(before.length);
    expect(after[0]!.maxHp).toBeGreaterThan(baseHp);
  });

  it("the fortress is part of the map: same seed, same towers", () => {
    const a = createWorld(content, SETUP);
    const b = createWorld(content, SETUP);
    expect(towers(a).map((t) => [t.x, t.y])).toEqual(towers(b).map((t) => [t.x, t.y]));
  });
});
