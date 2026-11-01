import { describe, expect, it } from "vitest";
import { createWorld, hashWorld, tierUpgrade } from "../src/sim";
import { queueCommand } from "../src/sim/commands";
import { canPlace } from "../src/sim/placement";
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

  it("records final bank and actual wall construction and rank spending", () => {
    const heroId = content.races["open-source"]!.heroes![0]!;
    const r = playMatch(content, "open-source", 42, heroId, {
      minutes: 0.1, hero: false, aggressive: false,
      beforeStep: w => {
        const t = w.teams[0]!;
        // Isolate successful payments, not attempted commands or free walls.
        t.ai!.difficulty = "disabled-for-test";
        t.money = 1000;
        t.upgrades[tierUpgrade(content)!] = 2;
        if (w.tick === 1) {
          const core = w.entities.find(e => e.id === t.coreId)!;
          if (core.kind !== "building") return;
          for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
            const col = core.col + dc, row = core.row + dr;
            if (canPlace(w, content, 0, "wall", col, row) !== null) continue;
            queueCommand(w, { type: "build", team: 0, tick: w.tick, building: "wall", col, row });
            return;
          }
        }
        const wall = w.entities.find(e => e.kind === "building" && e.defId === "wall");
        if (wall?.kind === "building" && wall.buildRemaining === 0 && !wall.refitRemaining && !wall.rank) {
          queueCommand(w, { type: "rank", team: 0, tick: w.tick, buildingId: wall.id });
        }
      },
    });
    expect(r.wallBuildSpent).toBe(20);
    expect(r.wallRankSpent).toBe(80);
    expect(r.wallSpent).toBe(100);
    expect(r.finalMoney).toBeGreaterThanOrEqual(0);
    expect(r.finalMoney).toBeLessThanOrEqual(r.peakMoney);
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
