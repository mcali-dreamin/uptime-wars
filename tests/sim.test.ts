import { describe, expect, it } from "vitest";
import {
  UNREACHABLE,
  createWorld,
  hashTerrain,
  hashWorld,
  loadDefaultContent,
  queueCommand,
  simulate,
  tileAt,
  TILE_BLOCKED,
  step,
  validateContent,
  type Command,
  type Content,
} from "../src/sim";
import { planBuildOrder } from "./helpers";

const content = loadDefaultContent();
const SETUP = { seed: 1234, races: ["open-source", "botnet"] as [string, string] };

const OPENING_ORDER: [number, string][] = [
  [1, "server-rack"],
  [1, "server-rack"],
  [200, "firewall"],
  [400, "solar-array"],
  [700, "gpu-cluster"],
  [1000, "firewall"],
  [1300, "server-rack"],
];
const OPENING = planBuildOrder(content, SETUP, OPENING_ORDER);

function firstSpot(building: string, tick = 0): Command {
  return planBuildOrder(content, SETUP, [[tick, building]])[0]!;
}

describe("determinism", () => {
  it("same seed and command log produce the same world", () => {
    const a = simulate(content, SETUP, OPENING, 3000);
    const b = simulate(content, SETUP, OPENING, 3000);
    expect(a.tick).toBe(b.tick);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it("a different seed diverges", () => {
    const other = { ...SETUP, seed: 99 };
    const a = simulate(content, SETUP, OPENING, 1500);
    const b = simulate(content, other, planBuildOrder(content, other, OPENING_ORDER), 1500);
    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });

  it("hash is stable when checked mid-match (replay checkpoints)", () => {
    const run = () => {
      const world = createWorld(content, SETUP);
      for (const command of OPENING) queueCommand(world, command);
      const checkpoints: string[] = [];
      for (let i = 0; i < 1500; i += 1) {
        step(world, content);
        if (world.tick % 300 === 0) checkpoints.push(hashWorld(world));
      }
      return checkpoints;
    };
    expect(run()).toEqual(run());
  });
});

describe("terrain", () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 1);

  it("the same seed always generates the same map", () => {
    for (const seed of SEEDS.slice(0, 5)) {
      const a = createWorld(content, { ...SETUP, seed });
      const b = createWorld(content, { ...SETUP, seed });
      expect(hashTerrain(a)).toBe(hashTerrain(b));
    }
  });

  it("every map is playable: clear core, reachable nest, wells within reach", () => {
    for (const seed of SEEDS) {
      const world = createWorld(content, { ...SETUP, seed });
      const { terrain } = world;
      const core = world.entities.find((e) => e.id === world.teams[0].coreId)!;
      const nest = world.entities.find((e) => e.id === world.teams[1].coreId)!;
      const nestTile = Math.floor(nest.y / 32) * terrain.cols + Math.floor(nest.x / 32);

      // Creeps can walk from the nest to the core.
      expect(world.nav.toCore[0][nestTile], `seed ${seed}`).not.toBe(UNREACHABLE);
      // Far apart, so the enemy is off-screen.
      const dx = nest.x - core.x;
      const dy = nest.y - core.y;
      expect(Math.sqrt(dx * dx + dy * dy), `seed ${seed}`).toBeGreaterThan(1200);
      // There is room to build around the core.
      expect(planBuildOrder(content, { ...SETUP, seed }, OPENING_ORDER)).toHaveLength(OPENING_ORDER.length);
      // At least two wells near the start.
      const near = terrain.resources.filter((r) => {
        const rx = r.col - terrain.start.col;
        const ry = r.row - terrain.start.row;
        return rx * rx + ry * ry <= 15 * 15;
      });
      expect(near.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      // Plenty of places for creeps to wander between.
      expect(terrain.roamPoints.length, `seed ${seed}`).toBeGreaterThanOrEqual(12);
    }
  });
});

describe("building", () => {
  it("charges compute and places the building", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    step(world, content);
    expect(world.teams[0].compute).toBe(200 - 60);
    expect(world.entities.some((e) => e.kind === "building" && e.defId === "server-rack")).toBe(true);
  });

  it("rejects blocked terrain, far-away tiles, occupied tiles, and empty wallets", () => {
    const world = createWorld(content, SETUP);
    const { terrain } = world;
    const spot = firstSpot("server-rack");
    let blocked = { col: 0, row: 0 }; // map border is always blocked
    const far = { col: terrain.nest.col - 3, row: terrain.nest.row };
    const reject = (building: string, col: number, row: number) => {
      queueCommand(world, { type: "build", tick: world.tick, team: 0, building, col, row });
      step(world, content);
      const rejected = world.events.find((e) => e.type === "rejected");
      return rejected?.type === "rejected" ? rejected.reason : null;
    };
    blocked = { col: 0, row: terrain.start.row };
    expect(reject("server-rack", blocked.col, blocked.row)).toBe("terrain is not buildable");
    expect(reject("server-rack", far.col, far.row)).toMatch(/terrain is not buildable|too far from your core/);
    expect(reject("server-rack", spot.col, spot.row)).toBeNull();
    expect(reject("firewall", spot.col, spot.row)).toBe("tile occupied");
    world.teams[0].compute = 0;
    const other = planBuildOrder(content, SETUP, [[0, "server-rack"], [0, "server-rack"]])[1]!;
    expect(reject("server-rack", other.col, other.row)).toBe("not enough compute");
  });

  it("rejects buildings outside the race roster", () => {
    const world = createWorld(content, SETUP);
    const spot = firstSpot("server-rack");
    queueCommand(world, { ...spot, building: "core" });
    step(world, content);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "rejected", reason: "not in this race's roster" }));
  });
});

describe("auto-spawn", () => {
  it("a finished server rack forks processes on its (race-modified) timer", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    const def = content.buildings["server-rack"]!;
    const interval = Math.round(def.spawn!.intervalTicks * content.races["open-source"]!.modifiers.spawnIntervalMultiplier);
    // Placed on step 0, built after buildTicks steps, then fires on the
    // interval-th step after that.
    const stepsBeforeSpawn = def.buildTicks + interval - 1;

    while (world.tick < stepsBeforeSpawn) step(world, content);
    const processes = () => world.entities.filter((e) => e.kind === "unit" && e.defId === "process").length;
    expect(processes()).toBe(0);
    step(world, content);
    expect(processes()).toBe(def.spawn!.count);
  });

  it("guards stay near where they spawned when nothing is around", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    while (world.tick < 400) step(world, content);
    const guards = world.entities.filter((e) => e.kind === "unit" && e.team === 0);
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) {
      if (guard.kind !== "unit") continue;
      const dx = guard.x - guard.homeX;
      const dy = guard.y - guard.homeY;
      expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThan(40);
    }
  });
});

describe("creeps", () => {
  it("each wave enters as random-sized packs, out of sight of every building you own", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    while (world.waves.pending.length === 0 || world.tick <= content.waves.firstWaveTicks + 200) step(world, content);
    const creeps = world.entities.filter((e) => e.kind === "unit" && e.team === 1);
    const packs = new Map<number, number>();
    for (const creep of creeps) if (creep.kind === "unit") packs.set(creep.packId, (packs.get(creep.packId) ?? 0) + 1);
    expect(packs.size).toBeGreaterThan(1);
    for (const size of packs.values()) expect(size).toBeLessThanOrEqual(content.waves.packSize.max);

    const entries = new Set(world.waves.pending.map((p) => `${p.col},${p.row}`));
    const mine = world.entities.filter((e) => e.kind === "building" && e.team === 0);
    const min = content.waves.spawnMinDistanceTiles * 32;
    for (const key of entries) {
      const [col, row] = key.split(",").map(Number) as [number, number];
      for (const b of mine) {
        expect(Math.hypot((col + 0.5) * 32 - b.x, (row + 0.5) * 32 - b.y)).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it("creeps never know where you are: they only target what they can see", () => {
    const world = createWorld(content, SETUP);
    let targeted = 0;
    while (world.tick < 8000 && !world.outcome) {
      step(world, content);
      const byId = new Map(world.entities.map((e) => [e.id, e]));
      for (const creep of world.entities) {
        if (creep.kind !== "unit" || creep.team !== 1 || creep.targetId === null) continue;
        const target = byId.get(creep.targetId);
        if (!target) continue;
        targeted += 1;
        const edge = Math.hypot(target.x - creep.x, target.y - creep.y) - target.radius - creep.radius;
        // Within sight (plus the chase leash), and never through a wall.
        expect(edge).toBeLessThanOrEqual(content.units[creep.defId]!.aggro * 1.5 + 1);
      }
    }
    expect(targeted).toBeGreaterThan(0);
  });

  it("no creep is ever inside a wall", () => {
    for (const seed of [1, 42]) {
      const world = createWorld(content, { ...SETUP, seed });
      while (world.tick < 6000 && !world.outcome) {
        step(world, content);
        for (const e of world.entities) {
          if (e.kind !== "unit") continue;
          expect(tileAt(world.terrain, Math.floor(e.x / 32), Math.floor(e.y / 32)), `seed ${seed}`).not.toBe(TILE_BLOCKED);
        }
      }
    }
  });

  it("packs reach an undefended core from more than one direction", () => {
    const sectors = new Set<number>();
    for (const seed of [1, 2, 3, 42, 1234]) {
      const world = createWorld(content, { ...SETUP, seed });
      const core = world.entities.find((e) => e.id === world.teams[0].coreId)!;
      while (world.tick < 12_000 && !world.outcome) {
        step(world, content);
        for (const ev of world.events) {
          if (ev.type !== "shot" || ev.team !== 1 || ev.to !== core.id) continue;
          const angle = Math.atan2(ev.y1 - core.y, ev.x1 - core.x);
          sectors.add(Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 8) % 8);
        }
      }
    }
    expect(sectors.size).toBeGreaterThanOrEqual(3);
  });

  it("you win by holding out until the timer after the last wave runs down", () => {
    const short: Content = structuredClone(content);
    short.waves = { ...short.waves, firstWaveTicks: 10, holdTicksAfterLastWave: 50, waves: [{ name: "Ping", delayTicks: 0, groups: [{ unit: "bot", count: 1 }] }] };
    const world = simulate(short, SETUP, [], 1000);
    expect(world.outcome).toMatchObject({ winner: 0, reason: "survived", tick: 60 });
  });
});

describe("content", () => {
  it("rejects broken references", () => {
    const broken: Content = structuredClone(content);
    broken.waves.waves[0]!.groups[0]!.unit = "missing";
    expect(() => validateContent(broken)).toThrow(/unknown unit missing/);
  });

  it("requires every race to have an unbuildable 2x2 core", () => {
    const broken: Content = structuredClone(content);
    broken.races.botnet!.core = "server-rack";
    expect(() => validateContent(broken)).toThrow(/must not be buildable/);
  });
});
