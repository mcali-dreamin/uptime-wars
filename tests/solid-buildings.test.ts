// Buildings are solid: nobody walks through one, its owner's units included.
// Gates are the one exception (see walls.test.ts).

import { describe, expect, it } from "vitest";
import { createWorld, queueCommand, step, TILE, type Building, type Unit, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { content, planBuildOrder } from "./fixtures";

const RACES = ["open-source", "hyperscaler", "serverless", "walled-garden"];

/** Is the unit's centre inside a building's footprint? */
function inside(u: Unit, b: Building): boolean {
  const left = b.col * TILE;
  const top = b.row * TILE;
  const size = b.footprint * TILE;
  return u.x > left && u.x < left + size && u.y > top && u.y < top + size;
}

function stranded(world: World): string | null {
  const buildings = world.entities.filter((e): e is Building => e.kind === "building" && e.hp > 0 && !content.buildings[e.defId]!.gate);
  for (const u of world.entities) {
    if (u.kind !== "unit" || u.hp <= 0) continue;
    const b = buildings.find((b) => inside(u, b));
    if (b) return `${u.defId} (team ${u.team}) inside ${b.defId} (team ${b.team}) at tick ${world.tick}`;
  }
  return null;
}

/** A base with a few of the race's buildings, its own units spawning among them. */
function base(race: string): World {
  const setup = { seed: 1234, races: [race, "botnet"], startWithCore: true };
  const world = createWorld(content, setup);
  world.teams[0]!.money = 100000;
  const roster = content.races[race]!.buildings.filter((id) => id !== content.races[race]!.core && !content.buildings[id]!.gate);
  const spawners = roster.filter((id) => content.buildings[id]!.spawn).slice(0, 2);
  const others = roster.filter((id) => !content.buildings[id]!.spawn && !content.buildings[id]!.blocks).slice(0, 4);
  for (const c of planBuildOrder(content, setup, [...spawners, ...others].map((id) => [0, id] as [number, string]))) queueCommand(world, c);
  return world;
}

describe("solid buildings", () => {
  for (const race of RACES) {
    it(`${race}: no unit, yours or a creep, ever stands inside a building`, () => {
      const world = base(race);
      world.waves.nextWaveTick = 600;
      for (let i = 0; i < 3000 && !world.outcome; i += 1) {
        step(world, content);
        const problem = stranded(world);
        expect(problem).toBeNull();
      }
      expect(world.entities.filter((e) => e.kind === "unit" && e.team === 0).length).toBeGreaterThan(0);
    });
  }

  it("a building that goes down on a unit pushes it out", () => {
    const setup = { seed: 1234, races: ["open-source", "botnet"], startWithCore: true };
    const world = createWorld(content, setup);
    world.waves.nextWaveTick = 1e9;
    world.teams[0]!.money = 10000;
    const [spot] = planBuildOrder(content, setup, [[0, "web-app"]]);
    const size = content.buildings["web-app"]!.footprint;
    const unit = spawnUnit(makeContext(world, content), 0, "process", { x: 0, y: 0 }, (spot!.col + size / 2) * TILE, (spot!.row + size / 2) * TILE, "guard");
    queueCommand(world, { ...spot!, tick: world.tick });
    step(world, content);
    const app = world.entities.find((e): e is Building => e.kind === "building" && e.defId === "web-app")!;
    expect(app).toBeDefined();
    expect(inside(unit, app)).toBe(false);
    expect(inside({ ...unit, x: unit.homeX, y: unit.homeY }, app)).toBe(false);
  });

  it("units ordered onto a building go beside it, and stay out of it", () => {
    const world = base("hyperscaler");
    world.waves.nextWaveTick = 1e9;
    while (world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard").length < 3) step(world, content);
    const core = world.entities.find((e): e is Building => e.id === world.teams[0]!.coreId)!;
    const ids = world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard").map((e) => e.id);
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: ids, x: core.x, y: core.y, attack: false });
    step(world, content);
    expect(world.events.some((e) => e.type === "rejected")).toBe(false);
    for (let i = 0; i < 600; i += 1) {
      step(world, content);
      expect(stranded(world)).toBeNull();
    }
    for (const id of ids) {
      const u = world.entities.find((e) => e.id === id) as Unit;
      // Gathered round it: within a few tiles of the core's edge.
      expect(Math.hypot(u.x - core.x, u.y - core.y)).toBeLessThan(core.radius + 4 * TILE);
    }
  });
});
