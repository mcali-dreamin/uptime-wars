import { describe, expect, it } from "vitest";
import { createWorld, hashWorld } from "../src/sim";
import { balanceContent, playMatch } from "../balance/bot";
import { content } from "./fixtures";

const SETUP = { seed: 42, races: ["open-source", "botnet"] as [string, string], startWithCore: true, ai: ["normal"] };
const opts = { minutes: 2, hero: true, aggressive: true };

describe("balance metrics", () => {
  it("pressure 1000 leaves the content identical", () => {
    expect(balanceContent(content, { pressure: 1000 })).toBe(content);
    expect(balanceContent(content, {})).toBe(content);
    expect(hashWorld(createWorld(balanceContent(content, { pressure: 1000 }), SETUP))).toBe(hashWorld(createWorld(content, SETUP)));
  });

  it("pressure 2000 doubles budget and hp growth without touching the shared content", () => {
    const start = content.waves.budget.start;
    const growth = content.waves.hpGrowthPerWave;
    const c = balanceContent(content, { pressure: 2000 });
    expect(c.waves.budget.start).toBe(Math.round(start * 2));
    expect(c.waves.hpGrowthPerWave).toBe(growth * 2);
    expect(c.waves.budget.growth).toBe(content.waves.budget.growth);
    expect(content.waves.budget.start).toBe(start);
    expect(content.waves.hpGrowthPerWave).toBe(growth);
  });

  it("reports stress metrics", () => {
    const heroId = content.races["open-source"]!.heroes![0]!;
    const r = playMatch(content, "open-source", 42, heroId, { ...opts, pressure: 1500 });
    expect(r.minCorePermille).toBeLessThanOrEqual(1000);
    expect(r.secondsBelowHalf).toBeGreaterThanOrEqual(0);
    expect(r.buildingsLost).toBeGreaterThanOrEqual(0);
    expect(r.pressure).toBe(1500);
    expect(r.minutes).toBe(2);
  });

  it("reflects forced core damage", () => {
    const heroId = content.races["open-source"]!.heroes![0]!;
    const r = playMatch(content, "open-source", 42, heroId, {
      ...opts,
      minutes: 1,
      beforeStep: (w) => {
        if (w.tick < 200) return;
        const core = w.entities.find((e) => e.id === w.teams[0]!.coreId)!;
        core.hp = Math.min(core.hp, Math.floor(core.maxHp * 0.3));
      },
    });
    expect(r.minCorePermille).toBeLessThanOrEqual(300);
    expect(r.secondsBelowHalf).toBeGreaterThan(0);
  });
});
