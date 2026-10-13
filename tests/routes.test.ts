import { describe, expect, it } from "vitest";
import { TILE_BLOCKED, TILE_OPEN, createWorld, farmSpots, fortressGates, generateTerrain } from "../src/sim";
import { bfs } from "../src/sim/terrain/grid";
import { content } from "./fixtures";

const SEEDS = Array.from({ length: 30 }, (_, i) => i * 7919 + 1);
const routes = (seed: number) => generateTerrain(seed, undefined, undefined, "routes");

describe("routes layout", () => {
  it("every start reaches the nest and every other start, and nothing open is cut off", () => {
    for (const seed of SEEDS) {
      const t = routes(seed);
      const dist = bfs(t.tiles, t.cols, t.rows, t.starts[0]!);
      expect(dist[t.nest.row * t.cols + t.nest.col], `seed ${seed} nest`).toBeGreaterThanOrEqual(0);
      for (const s of t.starts) expect(dist[s.row * t.cols + s.col], `seed ${seed} start`).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < t.tiles.length; i += 1) {
        if (t.tiles[i] === TILE_OPEN) expect(dist[i], `seed ${seed} pocket at ${i}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("is mostly solid web: far less open ground than the noise layout", () => {
    const open = (tiles: Uint8Array) => tiles.reduce((n, t) => n + (t !== TILE_BLOCKED ? 1 : 0), 0) / tiles.length;
    for (const seed of SEEDS.slice(0, 8)) {
      expect(open(routes(seed).tiles)).toBeLessThan(open(generateTerrain(seed).tiles) * 0.75);
    }
  });

  it("keeps a fortress with its gates and farms, and room to build at every start", () => {
    for (const seed of SEEDS) {
      const t = routes(seed);
      expect(fortressGates(t).length, `seed ${seed}`).toBeGreaterThanOrEqual(3);
      expect(farmSpots(t).length, `seed ${seed}`).toBe(4);
      for (const s of t.starts) {
        let room = 0;
        for (let dr = -6; dr <= 6; dr += 1) for (let dc = -6; dc <= 6; dc += 1) if (t.tiles[(s.row + dr) * t.cols + s.col + dc] === TILE_OPEN) room += 1;
        expect(room, `seed ${seed}`).toBeGreaterThan(80);
      }
    }
  });

  it("is a match setting: same seed and layout, same map; the default is unchanged", () => {
    const a = createWorld(content, { seed: 42, races: ["open-source", "botnet"], layout: "routes" });
    const b = createWorld(content, { seed: 42, races: ["open-source", "botnet"], layout: "routes" });
    const plain = createWorld(content, { seed: 42, races: ["open-source", "botnet"] });
    expect(Array.from(a.terrain.tiles)).toEqual(Array.from(b.terrain.tiles));
    expect(Array.from(plain.terrain.tiles)).toEqual(Array.from(generateTerrain(42).tiles));
    expect(Array.from(a.terrain.tiles)).not.toEqual(Array.from(plain.terrain.tiles));
  });
});
