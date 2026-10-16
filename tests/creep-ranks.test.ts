// Late incidents get tougher, not bigger: past waves.ranks.maxUnits a wave
// comes as fewer ranked creeps worth the same.

import { describe, expect, it } from "vitest";
import { createWorld, planWave, step, type Unit } from "../src/sim";
import type { Content } from "../src/sim/content";
import { dealDamage } from "../src/sim/combat";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { stampRank } from "../src/sim/ranks";
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
    for (const wave of [10, 12, 14, 16]) {
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
    world.waves.nextIndex = 13;
    world.waves.nextWaveTick = world.tick;
    world.waves.nextTrickleTick = 1e9;
    step(world, content);
    const creeps = world.entities.filter((e): e is Unit => e.kind === "unit" && e.team === 1 && e.defId === "bot");
    expect(creeps.length).toBeGreaterThan(0);
    const level = creeps[0]!.rank!;
    expect(level).toBeGreaterThan(0);
    const plain = Math.round(content.units.bot!.hp * (1 + content.waves.hpGrowthPerWave * 13));
    expect(creeps[0]!.maxHp).toBeCloseTo((plain * ranks.levels[level - 1]!.hpPermille) / 1000, -1);
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
});
