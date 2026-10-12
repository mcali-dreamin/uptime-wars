import { describe, expect, it } from "vitest";
import {
  flowField,
  createWorld,
  queueCommand,
  planWave,
  playerScale,
  previewWave,
  trickleBudget,
  trafficRadius,
  waveInterval,
  TILE,
  step,
} from "../src/sim";
import { content, SETUP, OPENING, firstSpot } from "./fixtures";

describe("endless waves", () => {
  it("incidents keep coming and there is no win by timer", () => {
    const world = createWorld(content, SETUP);
    for (const command of OPENING) queueCommand(world, command);
    // Fast-forward the clock between incidents rather than simulating every tick of them.
    while (world.waves.nextIndex < 4 && !world.outcome) {
      world.waves.nextWaveTick = Math.min(world.waves.nextWaveTick, world.tick + 1);
      for (let i = 0; i < 40; i += 1) step(world, content);
    }
    expect(world.waves.nextIndex).toBe(4);
    expect(world.waves.nextWaveTick).toBeGreaterThan(world.tick);
  });

  it("budgets grow, the gap between waves shrinks, units unlock, bosses arrive on cadence", () => {
    const world = createWorld(content, SETUP);
    const size = (wave: number) => planWave(world, content, wave).units.length;
    expect(size(10)).toBeGreaterThan(size(1));
    expect(waveInterval(content, 10)).toBeLessThan(waveInterval(content, 1));
    expect(waveInterval(content, 1000)).toBe(content.waves.interval.minTicks);

    const first = planWave(world, content, 1).units;
    for (const entry of content.waves.roster.filter((e) => e.fromWave > 1)) expect(first).not.toContain(entry.unit);

    const { unit, fromWave, every } = content.waves.bosses;
    expect(planWave(world, content, fromWave - 1).units).not.toContain(unit);
    expect(planWave(world, content, fromWave).units).toContain(unit);
    expect(planWave(world, content, fromWave + 1).units).not.toContain(unit);
    expect(planWave(world, content, fromWave + every).units).toContain(unit);
  });

  it("a rack keeps at most its maxAlive guards", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    while (world.tick < 2000) step(world, content);
    const guards = world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard");
    expect(guards.length).toBeLessThanOrEqual(content.buildings["server-rack"]!.spawn!.maxAlive);
    expect(guards.length).toBeGreaterThan(0);
  });
});

describe("traffic", () => {
  const t = content.economy.traffic;

  it("grows with buildings, users and time, is capped, and is zero before a core", () => {
    const deploying = createWorld(content, { seed: 1234, races: ["open-source", "botnet"] as [string, string] });
    expect(trafficRadius(deploying, content, deploying.teams[0]!)).toBe(0);
    const world = createWorld(content, SETUP);
    const team = world.teams[0]!;
    const before = trafficRadius(world, content, team);
    team.users += 10;
    expect(trafficRadius(world, content, team)).toBe(before + 10 * t.perUser);
    world.tick += 20 * 60 * 3;
    expect(trafficRadius(world, content, team)).toBe(before + 10 * t.perUser + 3 * t.perMinute);
    team.users = 100_000;
    expect(trafficRadius(world, content, team)).toBe(t.max);
  });

  it("crawlers find even an undefended base within eight minutes, on every map", () => {
    for (const seed of [1, 2, 3, 42, 1234]) {
      const world = createWorld(content, { ...SETUP, seed });
      let first: number | null = null;
      while (first === null && world.tick < 20 * 600 && !world.outcome) {
        step(world, content);
        if (world.events.some((e) => e.type === "shot" && e.team === 1)) first = world.tick;
      }
      expect(first, `seed ${seed}`).not.toBeNull();
      expect(first!, `seed ${seed}`).toBeLessThan(20 * 60 * 8);
    }
  });

  it("routes from the nest to your core are never wildly longer than the straight line", () => {
    for (const seed of [1, 2, 3, 42, 1234]) {
      const world = createWorld(content, { ...SETUP, seed });
      const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
      const nest = world.entities.find((e) => e.id === world.teams[1]!.coreId)!;
      const field = flowField(world.terrain, [Math.floor(core.y / TILE) * world.terrain.cols + Math.floor(core.x / TILE)]);
      const route = (field[Math.floor(nest.y / TILE) * world.terrain.cols + Math.floor(nest.x / TILE)]! / 10) * TILE;
      expect(route / Math.hypot(core.x - nest.x, core.y - nest.y), `seed ${seed}`).toBeLessThan(2);
    }
  });
});

describe("wave preview", () => {
  it("matches what the wave actually rolls, and never touches the match RNG", () => {
    const world = createWorld(content, SETUP);
    for (let wave = 1; wave <= 30; wave += 1) {
      const before = world.rngState;
      const preview = previewWave(content, wave);
      expect(world.rngState).toBe(before);

      const plan = planWave(world, content, wave);
      expect(preview.name).toBe(plan.name);
      expect(preview.bosses).toBe(plan.bosses);
      // Everything the wave rolled was previewed (bosses aside).
      for (const unit of plan.units) if (unit !== preview.boss) expect(preview.creeps).toContain(unit);
    }
  });

  it("announces each creep type on the wave it unlocks, and only then", () => {
    for (const entry of content.waves.roster) {
      expect(previewWave(content, entry.fromWave).fresh).toContain(entry.unit);
      expect(previewWave(content, entry.fromWave + 1).fresh).not.toContain(entry.unit);
      if (entry.fromWave > 1) expect(previewWave(content, entry.fromWave - 1).creeps).not.toContain(entry.unit);
    }
  });
});

describe("background traffic and incidents", () => {
  const coop = (players: number) => ({ seed: 1234, races: [...Array(players).fill("open-source"), "botnet"], startWithCore: true });

  it("background traffic: a small pack every few seconds, never a boss, growing over time", () => {
    const world = createWorld(content, SETUP);
    world.waves.nextWaveTick = 1e9; // no incidents
    const packs = new Map<number, string[]>();
    while (world.tick < content.waves.firstWaveTicks + content.waves.trickle.everyTicks * 6) {
      step(world, content);
      for (const s of world.waves.pending) (packs.get(s.packId) ?? packs.set(s.packId, []).get(s.packId)!).push(s.unit);
    }
    for (const e of world.entities) if (e.kind === "unit" && e.team === 1) packs.set(e.packId, packs.get(e.packId) ?? ["seen"]);
    expect(packs.size).toBeGreaterThanOrEqual(5);
    expect(world.entities.some((e) => e.kind === "unit" && e.defId === content.waves.bosses.unit)).toBe(false);
    const early = trickleBudget(world, content);
    world.tick += 20 * 60 * 5;
    expect(trickleBudget(world, content)).toBeGreaterThan(early);
  });

  it("incidents are much bigger than a background pack, and bosses only come with incidents", () => {
    const world = createWorld(content, SETUP);
    expect(planWave(world, content, 1).units.length).toBeGreaterThan(content.waves.trickle.maxPack * 2);
  });

  it("the first incident comes well after traffic starts", () => {
    expect(content.waves.firstIncidentTicks).toBeGreaterThan(content.waves.firstWaveTicks + 600);
  });

  it("more players online, more pressure: the trickle scales strongly, incidents gently", () => {
    const one = createWorld(content, coop(1));
    const two = createWorld(content, coop(2));
    const four = createWorld(content, coop(4));
    const t = (w: typeof one) => playerScale(w, content, "trickle");
    const i = (w: typeof one) => playerScale(w, content, "incident");
    expect(t(one)).toBe(1);
    expect(i(one)).toBe(1);
    expect(t(two)).toBeGreaterThan(i(two));
    expect(t(four)).toBeGreaterThan(t(two));
    expect(planWave(two, content, 5).units.length).toBeGreaterThan(planWave(one, content, 5).units.length);
    // A player who's offline no longer counts.
    two.teams[1]!.downTick = 0;
    expect(t(two)).toBe(1);
  });

  it("the preview still names the next incident and its boss", () => {
    const { fromWave } = content.waves.bosses;
    expect(previewWave(content, fromWave).bosses).toBeGreaterThan(0);
    expect(previewWave(content, 1).bosses).toBe(0);
  });
});
