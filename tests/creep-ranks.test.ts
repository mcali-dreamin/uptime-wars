// Late incidents get tougher, not bigger: past waves.ranks.maxUnits a wave
// comes as fewer ranked creeps worth the same.

import { describe, expect, it } from "vitest";
import { createWorld, planWave, step, type Unit } from "../src/sim";
import type { Content } from "../src/sim/content";
import { dealDamage } from "../src/sim/combat";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { rankWorth, stampRank } from "../src/sim/ranks";
import { content, SETUP } from "./fixtures";

const ranks = content.waves.ranks!;
const unranked: Content = { ...content, waves: { ...content.waves, ranks: undefined } };
const cost = (unit: string) => content.waves.roster.find((r) => r.unit === unit)?.cost ?? 0;
const worthOf = (units: string[], rank: number) => units.reduce((sum, u) => sum + cost(u), 0) * (rank ? ranks.levels[rank - 1]!.worth! : 1);

describe("creep ranks", () => {
  it("each level is worth twice the one before, and hp x damage keeps pace", () => {
    let worth = 1;
    for (const level of ranks.levels) {
      expect(level.worth, level.name).toBe(worth * 2);
      worth = level.worth!;
      // Strength ~ hp x damage: a rank worth w hits and takes like w plain creeps.
      expect((level.hpPermille * level.damagePermille) / 1e6, level.name).toBeCloseTo(worth, 0);
    }
  });

  it("an early wave is untouched", () => {
    const plain = planWave(createWorld(unranked, SETUP), unranked, 5);
    const plan = planWave(createWorld(content, SETUP), content, 5);
    expect(plan.rank).toBe(0);
    expect(plan.units).toEqual(plain.units);
  });

  it("a big wave comes as at most maxUnits ranked creeps, worth about the same", () => {
    for (const wave of [20, 30, 40, 50]) {
      const plain = planWave(createWorld(unranked, SETUP), unranked, wave);
      const plan = planWave(createWorld(content, SETUP), content, wave);
      expect(plain.units.length, `wave ${wave}`).toBeGreaterThan(ranks.maxUnits);
      expect(plan.rank, `wave ${wave}`).toBeGreaterThan(0);
      expect(plan.units.length, `wave ${wave}`).toBeLessThanOrEqual(ranks.maxUnits);
      const ratio = worthOf(plan.units, plan.rank) / worthOf(plain.units, 0);
      expect(ratio, `wave ${wave}`).toBeGreaterThan(0.7);
      expect(ratio, `wave ${wave}`).toBeLessThan(1.4);
    }
  });

  it("a late incident's creeps arrive ranked: tougher, harder-hitting, worth more", () => {
    const world = createWorld(content, SETUP);
    world.waves.nextIndex = 30;
    world.waves.nextWaveTick = world.tick;
    world.waves.nextTrickleTick = 1e9;
    step(world, content);
    while (world.waves.pending.length > 0 && world.tick < 600) step(world, content);
    const creeps = world.entities.filter((e): e is Unit => e.kind === "unit" && e.team === 1);
    // (Infector escorts come plain; the incident's own creeps are ranked.)
    const ranked = creeps.filter((c) => c.rank);
    expect(ranked.length).toBeGreaterThan(creeps.length / 2);
    const creep = ranked[0]!;
    const plain = Math.round(content.units[creep.defId]!.hp * (1 + content.waves.hpGrowthPerWave * 30));
    expect(creep.maxHp).toBeCloseTo((plain * ranks.levels[creep.rank! - 1]!.hpPermille) / 1000, -1);
  });

  it("killing a ranked creep pays its worth in bounty", () => {
    const world = createWorld(content, SETUP);
    const ctx = makeContext(world, content);
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    const paid = (level: number) => {
      const creep = spawnUnit(ctx, 1, "bot", core, core.x + 200, core.y, "roam");
      if (level) stampRank(creep, level, ranks.levels[level - 1]!);
      const before = world.teams[0]!.money;
      dealDamage(ctx, core, creep, 1e9);
      return world.teams[0]!.money - before;
    };
    const plain = paid(0);
    expect(plain).toBeGreaterThan(0);
    expect(paid(3)).toBe(plain * ranks.levels[2]!.worth!);
  });

  it("the alive cap counts worth, not heads: ranked creeps don't multiply the horde", () => {
    const world = createWorld(content, SETUP);
    world.waves.nextIndex = 16;
    world.waves.nextTrickleTick = 1e9;
    const top = Math.max(...ranks.levels.map((l) => l.worth!));
    let peak = 0;
    for (let i = 0; i < 1200; i += 1) {
      // An incident every 5 seconds: far more than the cap holds.
      if (i % 100 === 0) world.waves.nextWaveTick = world.tick;
      step(world, content);
      let worth = 0;
      for (const e of world.entities) if (e.kind === "unit" && e.team === 1) worth += rankWorth(content, world, e);
      peak = Math.max(peak, worth);
    }
    expect(peak).toBeGreaterThan(content.waves.maxAlive / 2);
    expect(peak).toBeLessThan(content.waves.maxAlive + top);
  });

  it("late incidents don't queue up forever: each arrives soon after it's announced", () => {
    // Waves past budget.lateFrom grow gently, so the botnet's backlog stays short.
    let scale = 1;
    const b = content.waves.budget;
    for (let w = 2; w <= 40; w += 1) scale *= w > b.lateFrom! ? b.lateGrowth! : b.growth;
    const units = b.start * scale;
    const levels = ranks.levels;
    expect(units / levels[levels.length - 1]!.worth!).toBeLessThan(ranks.maxUnits * 2);
  });
});
