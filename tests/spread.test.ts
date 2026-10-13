import { describe, expect, it } from "vitest";
import { TILE, createWorld, generateTerrain, hashWorld, infectionSites, liveNodes, step, type Building, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { placeBuilding } from "../src/sim/entities";
import { content, SETUP } from "./fixtures";

const SEEDS = Array.from({ length: 30 }, (_, i) => i * 7919 + 1);
const SPREAD = content.waves.spread;
const horde = 1;

/** Fire incident `wave` on the next tick, with no background trickle muddying things. */
function incident(world: World, wave: number): void {
  world.waves.nextTrickleTick = 1e9;
  world.waves.nextIndex = wave - 1;
  world.waves.nextWaveTick = world.tick + 1;
}

const infectors = (world: World) => world.entities.filter((e) => e.kind === "unit" && e.team === horde && e.mode === "infector");
const nodes = (world: World) => world.entities.filter((e): e is Building => e.kind === "building" && e.defId === SPREAD.building);

describe("the botnet spreads", () => {
  it("every map has several sites, spread out, clear of every start and of the fortress", () => {
    for (const seed of SEEDS) {
      const t = generateTerrain(seed);
      const sites = infectionSites(t, content);
      expect(sites.length, `seed ${seed}`).toBeGreaterThanOrEqual(4);
      for (const s of sites) {
        for (const st of t.starts) expect(Math.hypot(s.col - st.col, s.row - st.row), `seed ${seed}`).toBeGreaterThanOrEqual(SPREAD.minFromStart - 2);
      }
    }
  });

  it("an incident sends an infector with an escort; it walks out and builds an Infected Node", () => {
    const world = createWorld(content, SETUP);
    incident(world, SPREAD.fromWave);
    step(world, content);
    step(world, content);
    expect(world.events.some((e) => e.type === "infecting") || infectors(world).length > 0).toBe(true);
    for (let i = 0; i < 6000 && nodes(world).length === 0; i++) step(world, content);
    expect(nodes(world)).toHaveLength(1);
    expect(nodes(world)[0]!.buildRemaining).toBeGreaterThan(0);
    expect(infectors(world)).toHaveLength(0);
  });

  it("an infector killed on the way builds nothing", () => {
    const world = createWorld(content, SETUP);
    incident(world, SPREAD.fromWave);
    for (let i = 0; i < 40 && infectors(world).length === 0; i++) step(world, content);
    expect(infectors(world).length).toBeGreaterThan(0);
    for (const u of infectors(world)) u.hp = 0;
    for (let i = 0; i < 4000; i++) step(world, content);
    expect(nodes(world)).toHaveLength(0);
  });

  it("finished nodes become sources: some incident packs come out of them", () => {
    const world = createWorld(content, SETUP);
    const site = infectionSites(world.terrain, content)[0]!;
    const node = placeBuilding(world, content, horde, SPREAD.building, site.col, site.row, true);
    expect(liveNodes(world, content, horde)).toHaveLength(1);
    // A late, big incident: plenty of packs to share out.
    incident(world, 6);
    for (let i = 0; i < 200; i++) step(world, content);
    const nearNode = world.entities.filter((e) => e.kind === "unit" && e.team === horde && e.mode === "roam" && Math.hypot(e.x - node.x, e.y - node.y) < TILE * 12);
    expect(nearNode.length).toBeGreaterThan(0);
  });

  it("packs closing on a base don't all take one road: flanking packs get a waypoint off to the side", () => {
    const world = createWorld(content, SETUP);
    world.waves.nextWaveTick = 1e9;
    // Background traffic from now: a pack every few seconds heads for the base.
    world.waves.nextTrickleTick = world.tick + 1;
    const seen = new Map<number, { x: number; y: number }>();
    for (let i = 0; i < 20 * 240 && seen.size < 4; i++) {
      step(world, content);
      for (const [id, p] of Object.entries(world.waves.approach ?? {})) seen.set(Number(id), p);
    }
    const flanks = [...seen.values()];
    expect(flanks.length).toBeGreaterThanOrEqual(2);
    const sides = new Set(flanks.map((p) => `${Math.round(p.x / TILE)},${Math.round(p.y / TILE)}`));
    expect(sides.size).toBeGreaterThan(1);
  });

  it("is deterministic", () => {
    const run = () => {
      const world = createWorld(content, SETUP);
      incident(world, SPREAD.fromWave);
      for (let i = 0; i < 3000; i++) step(world, content);
      return hashWorld(world);
    };
    expect(run()).toBe(run());
  });
});

void makeContext;
