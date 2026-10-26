import { describe, expect, it } from "vitest";
import { createWorld, isJammed, queueCommand, step, TILE, type Building, type Unit, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { bodyFits } from "../src/sim/nav";
import { content, planBuildOrder } from "./fixtures";

const SETUP = { seed: 1234, races: ["open-source", "botnet"], startWithCore: true };

/** A base with `list` finished, no waves, no neutral camps, the hero and any guards parked far off. */
function base(list: string[]): World {
  const world = createWorld(content, SETUP);
  // Creeps pick fights with any camp they pass; these tests are about creeps and buildings.
  world.entities = world.entities.filter((e) => world.teams[e.team]!.controller !== "neutral");
  world.waves.nextWaveTick = 1e9;
  world.teams[0]!.money = 10000;
  for (const c of planBuildOrder(content, SETUP, list.map((b) => [0, b] as [number, string]))) queueCommand(world, c);
  const done = () => world.entities.filter((e) => e.kind === "building" && e.team === 0 && e.defId !== "core" && e.buildRemaining <= 0).length;
  while (done() < list.length) step(world, content);
  park(world);
  return world;
}

function park(world: World): void {
  const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
  for (const u of world.entities) {
    if (u.kind === "unit" && u.team === 0) {
      u.x = u.homeX = core.x - 3000;
      u.y = u.homeY = core.y;
    }
  }
}

/** A creep of `defId` on open ground `tiles` out from building `near`. */
function creepNear(world: World, defId: string, near: Building, tiles: number, nearest = true): Unit {
  const ctx = makeContext(world, content);
  for (let r = tiles; r <= tiles + 4; r += 1) {
    for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) {
      const x = near.x + dc * TILE;
      const y = near.y + dr * TILE;
      if (!bodyFits(world.terrain, x, y, content.units[defId]!.size)) continue;
      if (world.terrain.heights[Math.floor(y / TILE) * world.terrain.cols + Math.floor(x / TILE)] !== world.terrain.heights[near.row * world.terrain.cols + near.col]) continue;
      // `near` must be the closest of your buildings by edge, with room to spare.
      const gap = Math.hypot(x - near.x, y - near.y) - near.radius;
      const others = world.entities.filter((e) => e.kind === "building" && e.team === 0 && e.id !== near.id);
      if (nearest && others.some((o) => Math.hypot(x - o.x, y - o.y) - o.radius <= gap + TILE)) continue;
      const unit = spawnUnit(ctx, 1, defId, near, x, y, "roam");
      unit.packId = 9000 + unit.id;
      return unit;
    }
  }
  throw new Error("no open ground");
}

const building = (world: World, defId: string) => world.entities.find((e): e is Building => e.kind === "building" && e.team === 0 && e.defId === defId)!;

describe("creep roles", () => {
  it("a scanner that lives long enough sends nearby packs marching on what it saw; killed first, it sends nobody", () => {
    const run = (killAfter: number | null) => {
      const world = base(["web-app"]);
      const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)! as Building;
      const scanner = creepNear(world, "scanner", core, 6);
      // A pack wandering far off, on its own roam route.
      const pack = creepNear(world, "bot", core, 20);
      world.waves.packs[pack.packId] = 0;
      let reported = false;
      for (let i = 0; i < 400 && !reported; i++) {
        if (killAfter !== null && i === killAfter) scanner.hp = 0;
        step(world, content);
        reported = world.events.some((e) => e.type === "reported");
      }
      return { reported, marching: typeof world.waves.packs[pack.packId] === "object" };
    };
    expect(run(null)).toEqual({ reported: true, marching: true });
    // Killed first: no report. (The pack may still find you by your traffic.)
    expect(run(20).reported).toBe(false);
  });

  it("a phisher next to a tower ignores it and goes for what serves users", () => {
    const world = base(["firewall", "web-app"]);
    // Right next to the tower: a bot would hit it, the phisher walks on.
    const tower = building(world, "firewall");
    const phisher = creepNear(world, "phisher", tower, 1, false);
    phisher.hp = phisher.maxHp = 1e9;
    for (let i = 0; i < 40; i++) step(world, content);
    expect(phisher.targetId).not.toBe(tower.id);
    const target = world.entities.find((e) => e.id === phisher.targetId);
    expect(target?.kind === "building" && (target.defId === "web-app" || target.defId === "core")).toBe(true);
  });

  it("a cryptominer drains $ with every hit", () => {
    const world = base(["solar-array"]);
    const solar = building(world, "solar-array");
    creepNear(world, "cryptominer", solar, 2);
    world.teams[0]!.money = 1000;
    const income = () => world.teams[0]!.money;
    let drained = false;
    for (let i = 0; i < 300 && !drained; i++) {
      const before = income();
      step(world, content);
      drained = income() < before;
    }
    expect(drained).toBe(true);
  });

  it("a DDoS node jams a tower: it stops shooting while jammed", () => {
    const world = base(["firewall"]);
    const tower = building(world, "firewall");
    const ddos = creepNear(world, "ddos", tower, 2);
    ddos.hp = 1e9;
    ddos.maxHp = 1e9;
    let jammedAt = -1;
    for (let i = 0; i < 300 && jammedAt < 0; i++) {
      step(world, content);
      if (isJammed(tower, world.tick)) jammedAt = world.tick;
    }
    expect(jammedAt).toBeGreaterThan(0);
    const shots = world.events.filter((e) => e.type === "shot" && e.from === tower.id);
    expect(shots).toHaveLength(0);
  });

  it("a brute forcer hits buildings four times as hard as its listed damage", () => {
    const world = base(["firewall"]);
    const tower = building(world, "firewall");
    tower.hp = tower.maxHp = 1e6;
    const brute = creepNear(world, "brute-forcer", tower, 2);
    let hit = 0;
    for (let i = 0; i < 300 && hit === 0; i++) {
      const before = tower.hp;
      step(world, content);
      hit = before - tower.hp;
    }
    const def = content.units["brute-forcer"]!;
    expect(hit).toBeGreaterThanOrEqual(def.damage * 4 - tower.armor - 1);
    expect(brute.targetId).toBe(tower.id);
  });
});
