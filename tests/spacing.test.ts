import { describe, expect, it } from "vitest";
import { createWorld, step, type Unit, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { content, SETUP } from "./fixtures";

/** A pile of guards dropped on one spot next to the core, nothing else going on. */
function pile(count: number): { world: World; units: Unit[]; at: { x: number; y: number } } {
  const world = createWorld(content, SETUP);
  world.waves.nextWaveTick = 1e9;
  world.waves.nextTrickleTick = 1e9;
  const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
  const ctx = makeContext(world, content);
  const at = { x: core.x + 120, y: core.y };
  const units: Unit[] = [];
  for (let i = 0; i < count; i += 1) {
    const u = spawnUnit(ctx, 0, "process", core, at.x, at.y, "guard");
    u.homeX = at.x;
    u.homeY = at.y;
    units.push(u);
  }
  return { world, units, at };
}

/** Deepest overlap between any two units, as a share of their combined radius. */
function worstOverlap(units: Unit[]): number {
  let worst = 0;
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i]!;
      const b = units[j]!;
      const min = a.radius + b.radius;
      const d = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
      worst = Math.max(worst, (min - d) / min);
    }
  }
  return worst;
}

const run = (world: World, ticks: number) => {
  for (let i = 0; i < ticks; i += 1) step(world, content);
};

describe("units take up room", () => {
  it("a stack of units on one spot spreads into a blob around it", () => {
    const { world, units, at } = pile(20);
    expect(worstOverlap(units)).toBe(1);
    run(world, 200);
    expect(worstOverlap(units)).toBeLessThan(0.2);
    // Still a group at the spot, not scattered across the map.
    for (const u of units) expect(Math.sqrt((u.x - at.x) * (u.x - at.x) + (u.y - at.y) * (u.y - at.y))).toBeLessThan(80);
  });

  it("the blob settles instead of jostling forever", () => {
    const { world, units } = pile(20);
    run(world, 300);
    const before = units.map((u) => [u.x, u.y]);
    run(world, 60);
    const drift = Math.max(...units.map((u, i) => Math.abs(u.x - before[i]![0]!) + Math.abs(u.y - before[i]![1]!)));
    expect(drift).toBeLessThan(2);
  });

  it("is deterministic", () => {
    const a = pile(20);
    const b = pile(20);
    run(a.world, 150);
    run(b.world, 150);
    expect(a.units.map((u) => [u.x, u.y])).toEqual(b.units.map((u) => [u.x, u.y]));
  });
});
