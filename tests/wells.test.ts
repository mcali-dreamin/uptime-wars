import { describe, expect, it } from "vitest";
import {
  TILE_OPEN,
  canPlace,
  createWorld,
  footprintCenter,
  queueCommand,
  step,
  tileAt,
  type World,
} from "../src/sim";
import { content, SETUP } from "./fixtures";

const PUMP = "data-pump";

function core(world: World) {
  const c = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
  if (c.kind !== "building") throw new Error("core must be a building");
  return c;
}

/** The data well nearest the core. */
function nearestWell(world: World) {
  const c = core(world);
  return [...world.terrain.resources].sort(
    (a, b) => Math.hypot(a.col - c.col, a.row - c.row) - Math.hypot(b.col - c.col, b.row - c.row),
  )[0]!;
}

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i += 1) step(world, content);
}

/**
 * Chain Mesh Nodes from the core toward a well until a pump fits on it.
 * Returns the number of nodes it took.
 */
function reachWell(world: World, well: { col: number; row: number }): number {
  const team = world.teams[0]!;
  let nodes = 0;
  while (canPlace(world, content, 0, PUMP, well.col, well.row) === "outside your network" && nodes < 12) {
    team.compute += 1000;
    const target = footprintCenter(well.col, well.row, 1);
    let best: { col: number; row: number; d: number } | null = null;
    for (let row = 0; row < world.terrain.rows; row += 1) {
      for (let col = 0; col < world.terrain.cols; col += 1) {
        if (tileAt(world.terrain, col, row) !== TILE_OPEN) continue;
        if (canPlace(world, content, 0, "mesh-node", col, row) !== null) continue;
        const p = footprintCenter(col, row, 1);
        const d = Math.hypot(p.x - target.x, p.y - target.y);
        if (!best || d < best.d) best = { col, row, d };
      }
    }
    if (!best) throw new Error("no room to extend the network");
    queueCommand(world, { type: "build", tick: world.tick, team: 0, building: "mesh-node", col: best.col, row: best.row });
    run(world, content.buildings["mesh-node"]!.buildTicks + 2);
    nodes += 1;
  }
  return nodes;
}

describe("data wells", () => {
  it("every playable race can build a Data Pump", () => {
    for (const race of Object.values(content.races)) {
      if (race.controller === "human") expect(race.buildings).toContain(PUMP);
    }
  });

  it("a pump only goes on a well, and nothing else does", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.compute = 10_000;
    const c = core(world);
    // Open ground right next to the core: fine for a rack, not for a pump.
    let open: { col: number; row: number } | null = null;
    for (let r = c.row - 3; r <= c.row + 4 && !open; r += 1)
      for (let k = c.col - 3; k <= c.col + 4 && !open; k += 1)
        if (canPlace(world, content, 0, "server-rack", k, r) === null) open = { col: k, row: r };
    expect(open).not.toBeNull();
    expect(canPlace(world, content, 0, PUMP, open!.col, open!.row)).toBe("needs a data well");

    const well = nearestWell(world);
    expect(canPlace(world, content, 0, "server-rack", well.col, well.row)).toBe("terrain is not buildable");
  });

  it("on every map the nearest well is past the core's reach", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const world = createWorld(content, { ...SETUP, seed });
      world.teams[0]!.compute = 10_000;
      const well = nearestWell(world);
      expect(canPlace(world, content, 0, PUMP, well.col, well.row), `seed ${seed}`).toBe("outside your network");
    }
  });

  it("...but a short hop out: a node or two away", () => {
    const world = createWorld(content, SETUP);
    const well = nearestWell(world);
    expect(canPlace(world, content, 0, PUMP, well.col, well.row)).toBe("outside your network");
    const nodes = reachWell(world, well);
    expect(nodes).toBeGreaterThan(0);
    expect(nodes).toBeLessThanOrEqual(3);
    expect(canPlace(world, content, 0, PUMP, well.col, well.row)).toBe(null);
  });

  it("a finished pump pays its income, on top of everything else", () => {
    const def = content.buildings[PUMP]!;
    const withPump = createWorld(content, SETUP);
    const without = createWorld(content, SETUP);
    const well = nearestWell(withPump);
    reachWell(withPump, well);
    reachWell(without, well);
    queueCommand(withPump, { type: "build", tick: withPump.tick, team: 0, building: PUMP, col: well.col, row: well.row });
    run(withPump, def.buildTicks + 2);
    run(without, def.buildTicks + 2);
    const pump = withPump.entities.find((e) => e.kind === "building" && e.defId === PUMP);
    expect(pump).toMatchObject({ buildRemaining: 0 });

    const before = [withPump.teams[0]!.compute, without.teams[0]!.compute];
    const seconds = 10;
    run(withPump, seconds * 20);
    run(without, seconds * 20);
    const gained = withPump.teams[0]!.compute - before[0]! - (without.teams[0]!.compute - before[1]!);
    // The pump's own income, give or take one payout either side and the user drift its cost causes.
    const expected = (def.income!.amount * seconds * 20) / def.income!.intervalTicks;
    expect(gained).toBeGreaterThanOrEqual(expected - def.income!.amount * 2);
    expect(gained).toBeLessThanOrEqual(expected + def.income!.amount * 2);
  });
});
