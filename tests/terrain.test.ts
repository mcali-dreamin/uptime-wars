import { describe, expect, it } from "vitest";
import {
  UNREACHABLE,
  TILE_CLIFF,
  TILE_RAMP,
  canSee,
  hasLineOfSight,
  hasClearPath,
  type Entity,
  flowField,
  createWorld,
  generateTerrain,
  hashTerrain,
  queueCommand,
  TILE,
  TILE_BLOCKED,
  step,
} from "../src/sim";
import { makeContext } from "../src/sim/context";
import { dealDamage } from "../src/sim/combat";
import { content, SETUP, OPENING_ORDER, firstSpot, planBuildOrder } from "./fixtures";

describe("no slowing terrain", () => {
  it("no map has data swamps (tile 2): ground is open, walls, cliffs, ramps, or wells", () => {
    for (let k = 0; k < 40; k += 1) {
      const { tiles } = generateTerrain(k * 7919 + 1);
      expect(tiles.includes(2), `seed ${k * 7919 + 1}`).toBe(false);
    }
  });
});

describe("terrain", () => {
  const SEEDS = Array.from({ length: 12 }, (_, i) => i * 7919 + 1);

  it("the same seed always generates the same map", () => {
    for (const seed of SEEDS.slice(0, 5)) {
      const a = createWorld(content, { ...SETUP, seed });
      const b = createWorld(content, { ...SETUP, seed });
      expect(hashTerrain(a)).toBe(hashTerrain(b));
    }
  });

  it("every map is playable: nest in the middle, start far out, reachable, room to build", () => {
    for (const seed of SEEDS) {
      const world = createWorld(content, { ...SETUP, seed });
      const { terrain } = world;
      const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
      const nest = world.entities.find((e) => e.id === world.teams[1]!.coreId)!;
      const nestTile = Math.floor(nest.y / TILE) * terrain.cols + Math.floor(nest.x / TILE);
      // The nest is the center of the web.
      expect(Math.abs(nest.x - (terrain.cols * TILE) / 2), `seed ${seed}`).toBeLessThanOrEqual(TILE * 2);
      expect(Math.abs(nest.y - (terrain.rows * TILE) / 2), `seed ${seed}`).toBeLessThanOrEqual(TILE * 2);

      // Creeps can walk from the nest to the core.
      const toCore = flowField(terrain, [Math.floor(core.y / TILE) * terrain.cols + Math.floor(core.x / TILE)]);
      expect(toCore[nestTile], `seed ${seed}`).not.toBe(UNREACHABLE);
      // Far apart, so the enemy is off-screen.
      const dx = nest.x - core.x;
      const dy = nest.y - core.y;
      expect(Math.sqrt(dx * dx + dy * dy), `seed ${seed}`).toBeGreaterThan(4000);
      // There is room to build around the core.
      expect(planBuildOrder(content, { ...SETUP, seed }, OPENING_ORDER)).toHaveLength(OPENING_ORDER.length);
      // At least two wells near the start.
      const near = terrain.resources.filter((r) => {
        const rx = r.col - terrain.starts[0]!.col;
        const ry = r.row - terrain.starts[0]!.row;
        return rx * rx + ry * ry <= 15 * 15;
      });
      expect(near.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      // Plenty of places for creeps to wander between.
      expect(terrain.roamPoints.length, `seed ${seed}`).toBeGreaterThanOrEqual(12);
    }
  });
});

describe("elevation", () => {
  const walkable = (tile: number) => tile !== TILE_BLOCKED && tile !== TILE_CLIFF;

  it("height only changes through ramps, and every walkable tile is reachable", () => {
    for (const seed of [1, 2, 3, 42, 1234, 77]) {
      const { terrain } = createWorld(content, { ...SETUP, seed });
      const { cols, tiles, heights } = terrain;
      let cliffs = 0;
      let ramps = 0;
      for (let i = 0; i < tiles.length; i++) {
        if (tiles[i] === TILE_CLIFF) cliffs++;
        if (tiles[i] === TILE_RAMP) ramps++;
        for (const n of [i + 1, i + cols]) {
          if (n >= tiles.length || (n === i + 1 && (i + 1) % cols === 0)) continue;
          if (!walkable(tiles[i]!) || !walkable(tiles[n]!)) continue;
          if (tiles[i] === TILE_RAMP || tiles[n] === TILE_RAMP) continue;
          expect(heights[i], `seed ${seed} tile ${i}`).toBe(heights[n]);
        }
      }
      expect(cliffs, `seed ${seed}`).toBeGreaterThan(100);
      expect(ramps, `seed ${seed}`).toBeGreaterThan(10);
      const field = flowField(terrain, [terrain.starts[0]!.row * cols + terrain.starts[0]!.col]);
      for (let i = 0; i < tiles.length; i++) {
        if (walkable(tiles[i]!)) expect(field[i], `seed ${seed} tile ${i} unreachable`).not.toBe(UNREACHABLE);
      }
    }
  });

  /** A low tile directly below a cliff, and the high tile behind it. */
  function cliffPair(world: ReturnType<typeof createWorld>) {
    const { cols, rows, tiles, heights } = world.terrain;
    for (let row = 2; row < rows - 2; row++) {
      for (let col = 2; col < cols - 6; col++) {
        const low = row * cols + col;
        // low | cliff | high | high ... far enough apart to test sight range
        const cliff = low + 1;
        const high = low + 4;
        if (tiles[low] !== 0 || tiles[cliff] !== TILE_CLIFF || tiles[high] !== 0) continue;
        if (heights[high]! <= heights[low]! || heights[low + 2] !== heights[high] || tiles[low + 2] === TILE_BLOCKED) continue;
        return { low: { x: (col + 0.5) * TILE, y: (row + 0.5) * TILE }, high: { x: (col + 4.5) * TILE, y: (row + 0.5) * TILE } };
      }
    }
    throw new Error("no cliff pair");
  }

  function unitAt(team: 0 | 1, at: { x: number; y: number }) {
    return { kind: "unit", id: 900 + team, team, x: at.x, y: at.y, radius: 8, armor: 0, hp: 1000, maxHp: 1000 } as unknown as Entity;
  }

  it("units walk around cliffs instead of into them", () => {
    // A cliff between here and there is not a straight path, even though
    // you can see across it.
    const world = createWorld(content, SETUP);
    const { low, high } = cliffPair(world);
    expect(hasLineOfSight(world.terrain, low.x, low.y, high.x, high.y)).toBe(true);
    expect(hasClearPath(world.terrain, low.x, low.y, high.x, high.y, 8)).toBe(false);
  });

  it("guards reach a rally point on another level", () => {
    const world = createWorld(content, SETUP);
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    const { terrain } = world;
    const coreHeight = terrain.heights[Math.floor(core.y / TILE) * terrain.cols + Math.floor(core.x / TILE)];
    // The nearest open tile on a different level from the core.
    let target: { x: number; y: number } | null = null;
    for (let r = 3; r < 40 && !target; r++) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) {
        const col = Math.floor(core.x / TILE) + dc;
        const row = Math.floor(core.y / TILE) + dr;
        const i = row * terrain.cols + col;
        if (terrain.tiles[i] === 0 && terrain.heights[i] !== coreHeight) {
          target = { x: (col + 0.5) * TILE, y: (row + 0.5) * TILE };
          break;
        }
      }
    }
    expect(target).not.toBeNull();
    queueCommand(world, firstSpot("server-rack"));
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard")) step(world, content);
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: world.teams[0]!.coreId, x: target!.x, y: target!.y });
    for (let i = 0; i < 20 * 90; i++) step(world, content);
    const guards = world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard");
    expect(guards.length).toBeGreaterThan(0);
    for (const g of guards) expect(Math.hypot(g.x - target!.x, g.y - target!.y)).toBeLessThan(90);
  });

  it("low ground can't see up a cliff; high ground can see down", () => {
    const world = createWorld(content, SETUP);
    const { low, high } = cliffPair(world);
    const ctx = makeContext(world, content);
    const below = unitAt(1, low);
    const above = unitAt(0, high);
    expect(canSee(ctx, below, above)).toBe(false);
    expect(canSee(ctx, above, below)).toBe(true);
  });

  it("attacking downhill hits harder", () => {
    const world = createWorld(content, SETUP);
    const { low, high } = cliffPair(world);
    const ctx = makeContext(world, content);
    const below = unitAt(1, low);
    const above = unitAt(0, high);
    const level = unitAt(1, { x: high.x + TILE, y: high.y });
    dealDamage(ctx, above, below, 40);
    dealDamage(ctx, above, level, 40);
    const downhill = 1000 - below.hp;
    const flat = 1000 - level.hp;
    expect(downhill).toBe(Math.round(40 * 1.25));
    expect(flat).toBe(40);
  });
});
