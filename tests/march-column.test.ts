// Group orders march as a broad column, not a single file (issue #181).

import { describe, expect, it } from "vitest";
import { TILE, TILE_BLOCKED, TILE_OPEN, createWorld, hashWorld, queueCommand, step, type Command, type Unit, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { content, SETUP } from "./fixtures";

/** Open ground with a long wall across the way, so the order routes on its field. */
function march() {
  const world = createWorld(content, SETUP);
  world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
  const t = world.terrain;
  t.tiles.fill(TILE_OPEN);
  t.heights.fill(0);
  const midC = Math.floor(t.cols / 2);
  const midR = Math.floor(t.rows / 2);
  for (let r = midR - 30; r <= midR + 30; r += 1) t.tiles[r * t.cols + midC] = TILE_BLOCKED;
  world.nav.goals.clear();
  const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
  // No creeps to fight on the way.
  world.entities = world.entities.filter((e) => e.kind !== "unit");
  const ctx = makeContext(world, content);
  const units: Unit[] = [];
  const x0 = (midC - 40) * TILE;
  const y0 = (midR - 20) * TILE;
  for (let i = 0; i < 40; i += 1) units.push(spawnUnit(ctx, 0, "process", core, x0 + (i % 8) * 8, y0 + Math.floor(i / 8) * 8, "guard"));
  const dest = { x: (midC + 40) * TILE, y: (midR - 20) * TILE };
  queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: units.map((u) => u.id), ...dest, attack: false } as Command);
  return { world, units, dest, start: { x: x0, y: y0 } };
}

/** Spread of the column perpendicular to the line from its centre to the goal. */
function spread(units: Unit[], dest: { x: number; y: number }): number {
  const cx = units.reduce((a, u) => a + u.x, 0) / units.length;
  const cy = units.reduce((a, u) => a + u.y, 0) / units.length;
  const len = Math.hypot(dest.x - cx, dest.y - cy);
  const px = -(dest.y - cy) / len;
  const py = (dest.x - cx) / len;
  const side = units.map((u) => (u.x - cx) * px + (u.y - cy) * py);
  return (Math.max(...side) - Math.min(...side)) / TILE;
}

function run(ticks: number, world: World) {
  for (let i = 0; i < ticks; i += 1) step(world, content);
}

describe("marching column", () => {
  it("spreads wide across open ground and still arrives", () => {
    const { world, units, dest } = march();
    // Partway to the wall's end, well before the column squeezes round it.
    run(300, world);
    const wide = spread(units, dest);
    // A single file measures about 1 tile here on the old flow-field-only march.
    expect(wide).toBeGreaterThan(3);
    run(3000, world);
    for (const u of units) expect(Math.hypot(u.x - dest.x, u.y - dest.y)).toBeLessThan(ORDER_ARRIVE);
  });

  it("two identical runs hash the same", () => {
    const a = march();
    const b = march();
    run(400, a.world);
    run(400, b.world);
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
  });
});

const ORDER_ARRIVE = 8 * TILE;
