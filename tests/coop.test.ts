// Co-op: up to four human teams on one map against the horde.

import { describe, expect, it } from "vitest";
import {
  MAX_PLAYERS,
  TILE,
  UNREACHABLE,
  createWorld,
  flowField,
  hashWorld,
  queueCommand,
  step,
  trafficRadius,
  type World,
} from "../src/sim";
import { content, planBuildOrder, OPENING_ORDER } from "./fixtures";

const SEEDS = Array.from({ length: 40 }, (_, i) => 1 + i * 7919);
const COOP = { seed: 1234, races: ["open-source", "hyperscaler", "botnet"], startWithCore: true };
const FOUR = { seed: 1234, races: ["open-source", "hyperscaler", "open-source", "hyperscaler", "botnet"], startWithCore: true };

const coreOf = (world: World, team: number) => world.entities.find((e) => e.id === world.teams[team]!.coreId)!;

function kill(world: World, team: number): void {
  for (const entity of world.entities) {
    if (entity.team === team && entity.kind === "building" && entity.defId === content.races[world.teams[team]!.raceId]!.core) entity.hp = 0;
  }
}

describe("co-op maps", () => {
  it(`every map has ${MAX_PLAYERS} starts: far from the nest and each other, reachable, flat, with wells`, () => {
    for (const seed of SEEDS) {
      const world = createWorld(content, { ...FOUR, seed });
      const { terrain } = world;
      expect(terrain.starts, `seed ${seed}`).toHaveLength(MAX_PLAYERS);
      const nestTile = terrain.nest.row * terrain.cols + terrain.nest.col;
      for (let p = 0; p < MAX_PLAYERS; p += 1) {
        const start = terrain.starts[p]!;
        const core = coreOf(world, p);
        expect(core, `seed ${seed} player ${p}`).toMatchObject({ kind: "building", col: start.col, row: start.row });
        // Creeps can walk from the nest to every base.
        const toCore = flowField(terrain, [start.row * terrain.cols + start.col]);
        expect(toCore[nestTile], `seed ${seed} player ${p}`).not.toBe(UNREACHABLE);
        // Far from the nest and from each other.
        const nest = coreOf(world, MAX_PLAYERS);
        expect(Math.sqrt((nest.x - core.x) ** 2 + (nest.y - core.y) ** 2), `seed ${seed} player ${p}`).toBeGreaterThan(4000);
        for (let q = 0; q < p; q += 1) {
          const other = coreOf(world, q);
          expect(Math.sqrt((other.x - core.x) ** 2 + (other.y - core.y) ** 2), `seed ${seed} players ${q},${p}`).toBeGreaterThan(40 * TILE);
        }
        // Two wells within reach of every start.
        const near = terrain.resources.filter((r) => (r.col - start.col) ** 2 + (r.row - start.row) ** 2 <= 15 * 15);
        expect(near.length, `seed ${seed} player ${p}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("the map is the same whoever plays it", () => {
    const solo = createWorld(content, { seed: 99, races: ["open-source", "botnet"] });
    const four = createWorld(content, { seed: 99, races: ["open-source", "hyperscaler", "open-source", "open-source", "botnet"] });
    expect(Array.from(four.terrain.tiles)).toEqual(Array.from(solo.terrain.tiles));
    expect(four.terrain.starts).toEqual(solo.terrain.starts);
  });

  it("rejects matches with no players, too many, or the horde before a player", () => {
    expect(() => createWorld(content, { seed: 1, races: ["botnet"] })).toThrow();
    expect(() => createWorld(content, { seed: 1, races: ["botnet", "open-source"] })).toThrow();
    expect(() => createWorld(content, { seed: 1, races: [...Array(MAX_PLAYERS + 1).fill("open-source"), "botnet"] })).toThrow();
  });
});

describe("co-op play", () => {
  it("each player gets a deploy agent at their own start", () => {
    const world = createWorld(content, { ...COOP, startWithCore: false });
    for (const p of [0, 1]) {
      const team = world.teams[p]!;
      expect(team.coreId).toBe(-1);
      const agent = world.entities.find((e) => e.id === team.builderId)!;
      const start = world.terrain.starts[p]!;
      expect(Math.abs(agent.x - (start.col + 1) * TILE)).toBeLessThanOrEqual(TILE);
      expect(Math.abs(agent.y - (start.row + 1) * TILE)).toBeLessThanOrEqual(TILE);
    }
    expect(world.teams[2]!.coreId).not.toBe(-1);
  });

  it("allies never shoot each other, even standing in each other's base; both fight the horde", () => {
    const world = createWorld(content, COOP);
    for (const command of planBuildOrder(content, COOP, OPENING_ORDER)) queueCommand(world, command);
    world.teams[1]!.money += 1000;
    for (const command of planBuildOrder(content, COOP, [[1, "hyperscale-rack"], [1, "hyperscale-rack"], [1, "cdn-edge"]], 4, 1)) {
      queueCommand(world, command);
    }
    // The bases are a map apart, so rather than walk them over, drop player
    // 1's units into player 0's base (inside its towers' range) and keep them there.
    const p0 = coreOf(world, 0);
    const visit = () => {
      for (const e of world.entities) {
        if (e.kind !== "unit" || e.team !== 1 || e.homeX === p0.x + 60) continue;
        e.x = e.homeX = p0.x + 60;
        e.y = e.homeY = p0.y + 40;
      }
    };

    let allyShots = 0;
    let hordeShots = 0;
    let visitors = 0;
    const teamOf = new Map<number, number>();
    while (world.tick < 20 * 60 * 6 && !world.outcome) {
      visit();
      for (const e of world.entities) teamOf.set(e.id, e.team);
      step(world, content);
      for (const event of world.events) {
        if (event.type !== "shot") continue;
        const target = teamOf.get(event.to);
        if (target === undefined) continue;
        const human = (t: number) => world.teams[t]!.controller === "human";
        if (human(target) && human(event.team)) allyShots += 1;
        else hordeShots += 1;
      }
      if (world.tick % 200 === 0) {
        visitors = Math.max(
          visitors,
          world.entities.filter((e) => e.kind === "unit" && e.team === 1 && Math.sqrt((e.x - p0.x) ** 2 + (e.y - p0.y) ** 2) < 300).length,
        );
      }
    }
    expect(visitors, "player 1's units reached player 0's base").toBeGreaterThan(0);
    expect(allyShots).toBe(0);
    expect(hordeShots).toBeGreaterThan(0);
  });

  it("either player's traffic draws the horde", () => {
    const world = createWorld(content, COOP);
    expect(trafficRadius(world, content, world.teams[0]!)).toBeGreaterThan(0);
    expect(trafficRadius(world, content, world.teams[1]!)).toBeGreaterThan(0);
    expect(trafficRadius(world, content, world.teams[2]!)).toBe(0);
  });

  it("one player going offline doesn't end the match; their commands stop; the last one does", () => {
    const world = createWorld(content, COOP);
    step(world, content);
    kill(world, 0);
    step(world, content);
    expect(world.teams[0]!.downTick).toBe(1);
    expect(world.outcome).toBeNull();
    expect(world.events).toContainEqual({ type: "offline", team: 0 });

    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: -1, x: 0, y: 0 });
    step(world, content);
    expect(world.events.find((e) => e.type === "rejected")).toMatchObject({ reason: "offline" });
    // An offline team draws no traffic.
    expect(trafficRadius(world, content, world.teams[0]!)).toBe(0);

    kill(world, 1);
    step(world, content);
    expect(world.outcome).toMatchObject({ winners: [2], reason: "all-offline" });
  });

  it("taking the nest offline wins it for every player", () => {
    const world = createWorld(content, COOP);
    step(world, content);
    kill(world, 0);
    step(world, content);
    kill(world, 2);
    step(world, content);
    // Even the player who went offline earlier shares the win.
    expect(world.outcome).toMatchObject({ winners: [0, 1], reason: "nest-offline" });
  });

  it("only real players can issue commands", () => {
    const world = createWorld(content, COOP);
    queueCommand(world, { type: "rally", tick: 0, team: 2, buildingId: world.teams[2]!.coreId, x: 0, y: 0 });
    queueCommand(world, { type: "rally", tick: 0, team: 7, buildingId: -1, x: 0, y: 0 });
    step(world, content);
    expect(world.events.filter((e) => e.type === "rejected").map((e) => e.type === "rejected" && e.reason)).toEqual([
      "no such player",
      "no such player",
    ]);
  });

  it("a co-op match with both players' commands is deterministic", () => {
    const run = () => {
      const world = createWorld(content, COOP);
      for (const command of planBuildOrder(content, COOP, OPENING_ORDER)) queueCommand(world, command);
      const p1 = coreOf(world, 1);
      queueCommand(world, { type: "rally", tick: 40, team: 1, buildingId: world.teams[1]!.coreId, x: p1.x + 200, y: p1.y });
      while (world.tick < 4000 && !world.outcome) step(world, content);
      return hashWorld(world);
    };
    expect(run()).toBe(run());
  });
});
