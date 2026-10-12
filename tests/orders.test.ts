import { describe, expect, it } from "vitest";
import { TILE, createWorld, hashWorld, queueCommand, step, tileAt, TILE_OPEN, type Unit, type World } from "../src/sim";
import { content, SETUP, firstSpot } from "./fixtures";

/** A world with a few guards out of a rack, and a spot on open ground some way off. */
function withGuards(count = 4): { world: World; guards: Unit[]; spot: { x: number; y: number } } {
  const world = createWorld(content, SETUP);
  world.teams[0]!.money = 10_000;
  queueCommand(world, firstSpot("server-rack"));
  queueCommand(world, firstSpot("server-rack", 1));
  const guards = () => world.entities.filter((e): e is Unit => e.kind === "unit" && e.team === 0 && e.mode === "guard");
  while (guards().length < count && world.tick < 4000) step(world, content);
  const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
  // Open ground ~8 tiles away, away from the nest.
  let spot = { x: core.x, y: core.y };
  for (let r = 8; r < 14; r += 1) {
    const candidates = [[r, 0], [-r, 0], [0, r], [0, -r]];
    const hit = candidates.find(([dc, dr]) => tileAt(world.terrain, Math.floor(core.x / TILE) + dc!, Math.floor(core.y / TILE) + dr!) === TILE_OPEN);
    if (hit) {
      spot = { x: (Math.floor(core.x / TILE) + hit[0]! + 0.5) * TILE, y: (Math.floor(core.y / TILE) + hit[1]! + 0.5) * TILE };
      break;
    }
  }
  return { world, guards: guards().slice(0, count), spot };
}

const run = (world: World, ticks: number) => {
  for (let i = 0; i < ticks; i += 1) step(world, content);
};

describe("unit orders", () => {
  it("a move order walks the group there, then they hold the spot", () => {
    const { world, guards, spot } = withGuards();
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: guards.map((g) => g.id), ...spot, attack: false });
    step(world, content);
    expect(guards.every((g) => g.order === "move" && g.commanded)).toBe(true);
    run(world, 600);
    for (const g of guards) expect(Math.hypot(g.x - spot.x, g.y - spot.y)).toBeLessThan(120);
    expect(guards.every((g) => g.order === null)).toBe(true);
    // ...and they stay.
    run(world, 200);
    for (const g of guards) expect(Math.hypot(g.x - spot.x, g.y - spot.y)).toBeLessThan(120);
  });

  it("a spawner's rally no longer moves units you ordered; it still moves the others", () => {
    const { world, guards, spot } = withGuards(4);
    const [ordered, ...rest] = guards as [Unit, ...Unit[]];
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: [ordered.id], ...spot, attack: true });
    run(world, 2);
    const home = { x: ordered.homeX, y: ordered.homeY };
    const coreId = world.teams[0]!.coreId;
    const core = world.entities.find((e) => e.id === coreId)!;
    // Open ground on the other side of the core.
    let rally = { x: core.x, y: core.y };
    for (let r = 3; r < 10; r += 1) {
      const x = core.x - Math.sign(spot.x - core.x || 1) * r * TILE;
      const y = core.y - Math.sign(spot.y - core.y) * r * TILE;
      if (tileAt(world.terrain, Math.floor(x / TILE), Math.floor(y / TILE)) === TILE_OPEN) {
        rally = { x, y };
        break;
      }
    }
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: coreId, ...rally });
    step(world, content);
    expect(world.events.filter((e) => e.type === "rejected")).toEqual([]);
    expect({ x: ordered.homeX, y: ordered.homeY }).toEqual(home);
    expect(rest.some((g) => Math.hypot(g.homeX - rally.x, g.homeY - rally.y) < 60)).toBe(true);
  });

  it("an attack-move fights on the way; a plain move doesn't stop to", () => {
    const { world, guards } = withGuards(6);
    const nestId = world.teams[1]!.coreId;
    const nest = world.entities.find((e) => e.id === nestId)!;
    // Drop the group next to the nest and send them past it.
    const next = (x: number) => ({ x, y: nest.y });
    for (const g of guards) {
      g.x = nest.x - 260;
      g.y = nest.y;
      g.homeX = g.x;
      g.homeY = g.y;
    }
    const target = next(nest.x - 120);
    const passing = structuredClone(world);
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: guards.map((g) => g.id), ...target, attack: true });
    run(world, 60);
    expect(world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.targetId !== null).length).toBeGreaterThan(0);

    const ids = guards.map((g) => g.id);
    queueCommand(passing, { type: "order", tick: passing.tick, team: 0, unitIds: ids, ...target, attack: false });
    run(passing, 20);
    const movers = passing.entities.filter((e) => ids.includes(e.id)) as Unit[];
    expect(movers.every((u) => u.order !== "move" || u.targetId === null)).toBe(true);
  });

  it("rejects orders for nobody, for someone else's units, and for too many", () => {
    const { world, guards, spot } = withGuards(1);
    const nest = world.teams[1]!.coreId;
    const builderless = world.entities.find((e) => e.kind === "unit" && e.team !== 0);
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: [], ...spot, attack: true });
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: [nest, builderless?.id ?? -5], ...spot, attack: true });
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: Array.from({ length: 201 }, () => guards[0]!.id), ...spot, attack: true });
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: [guards[0]!.id], x: -500, y: -500, attack: true });
    step(world, content);
    const reasons = world.events.flatMap((e) => (e.type === "rejected" ? [e.reason] : []));
    expect(reasons).toEqual(["no units", "no units", "too many units", "can't go there"]);
    expect(guards[0]!.commanded).toBe(false);
  });

  it("orders are deterministic", () => {
    const a = withGuards(4);
    const b = withGuards(4);
    for (const w of [a, b]) {
      queueCommand(w.world, { type: "order", tick: w.world.tick, team: 0, unitIds: w.guards.map((g) => g.id), ...w.spot, attack: true });
      run(w.world, 300);
    }
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
  });

  it("route caches stay bounded however many places you send units", () => {
    const { world, guards } = withGuards(1);
    const { terrain } = world;
    let sent = 0;
    for (let i = 0; i < terrain.tiles.length && sent < 150; i += 211) {
      if (terrain.tiles[i] !== TILE_OPEN) continue;
      const x = ((i % terrain.cols) + 0.5) * TILE;
      const y = (Math.floor(i / terrain.cols) + 0.5) * TILE;
      queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: [guards[0]!.id], x, y, attack: false });
      run(world, 2);
      sent += 1;
    }
    expect(sent).toBeGreaterThan(100);
    expect(world.nav.goals.size).toBeLessThanOrEqual(96);
  });
});
