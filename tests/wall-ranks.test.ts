import { describe, expect, it } from "vitest";
import { createWorld, rankBlocker, rankCost, rankGroup, tierUpgrade, type Building } from "../src/sim";
import { applyCommands, queueCommand } from "../src/sim/commands";
import { syncWalls, terrainFor } from "../src/sim/walls";
import { isWalkableTile } from "../src/sim/terrain";
import { makeContext } from "../src/sim/context";
import { placeBuilding } from "../src/sim/entities";
import { startRank, tickRefits } from "../src/sim/ranks";
import { rankWalls } from "../src/sim/ai/aggressive";
import { validateContent } from "../src/sim/content/validate";
import { content } from "./fixtures";

function setup(race = "open-source", def = "wall") {
  const w = createWorld(content, { seed: 1234, races: [race, "botnet"], startWithCore: true });
  const t = w.teams[0]!;
  const core = w.entities.find(e => e.id === t.coreId) as Building;
  const b = placeBuilding(w, content, 0, def, core.col + 4, core.row, true);
  t.money = 10000;
  t.upgrades[tierUpgrade(content)!] = 2;
  return { w, t, b, core };
}
function finish(w: ReturnType<typeof createWorld>, b: Building) {
  const ctx = makeContext(w, content);
  while (b.refitRemaining) tickRefits(ctx);
}

describe("wall ranks", () => {
  it("shares flat prices and tier gates across all human races and gates", () => {
    for (const [race, def] of Object.entries(content.races)) {
      if (def.controller !== "human") continue;
      for (const id of ["wall", "gate"]) {
        const { w, t, b } = setup(race, id);
        for (const [i, price] of [80, 200, 450].entries()) {
          t.upgrades[tierUpgrade(content)!] = i === 0 ? 0 : 1;
          expect(rankBlocker(content, w, 0, b)).toBe(i === 0 ? "needs Data Center" : "needs Region");
          t.upgrades[tierUpgrade(content)!] = 2;
          expect(rankCost(content, w, b)).toBe(price);
          const money = t.money;
          startRank(content, w, b);
          expect(t.money).toBe(money - price);
          finish(w, b);
        }
        expect(rankBlocker(content, w, 0, b)).toBe("top rank");
      }
    }
  });

  it("grows damaged HP proportionally, adds cumulative armor, and keeps occupied tiles during refit", () => {
    for (const race of ["open-source", "walled-garden"]) {
      const { w, b } = setup(race);
      const hp = b.maxHp;
      const armor = b.armor;
      b.hp = hp / 2;
      syncWalls(w, content);
      const tiles = Array.from(w.terrain.built!);
      for (const rank of content.economy.wallRanks) {
        startRank(content, w, b);
        syncWalls(w, content);
        expect(isWalkableTile(terrainFor(w, 1).terrain, b.col, b.row)).toBe(false);
        expect(Array.from(w.terrain.built!)).toEqual(tiles);
        expect(b.hp).toBeGreaterThan(0);
        finish(w, b);
        expect(b.maxHp).toBe(Math.round(hp * rank.hpPermille / 1000));
        expect(b.hp).toBeCloseTo(b.maxHp / 2, 0);
        expect(b.armor).toBe(armor + rank.armor);
        syncWalls(w, content);
        expect(Array.from(w.terrain.built!)).toEqual(tiles);
      }
    }
  });

  it("charges each segment and skips unaffordable segments", () => {
    const { w, t, b, core } = setup();
    const second = placeBuilding(w, content, 0, "gate", core.col + 5, core.row, true);
    const third = placeBuilding(w, content, 0, "wall", core.col + 6, core.row, true);
    t.money = 170;
    const plan = rankGroup(content, w, 0, [b, second, third]);
    expect(plan).toEqual({ ids: [b.id, second.id], cost: 160, short: 1 });
    for (const e of [b, second]) startRank(content, w, e);
    expect(t.money).toBe(10);
    expect(rankBlocker(content, w, 0, third)).toBe("not enough $");
  });

  it("bot ranks capped walls without spending its reserve or issuing blocked commands", () => {
    const { w, t, b, core } = setup();
    const second = placeBuilding(w, content, 0, "wall", core.col + 5, core.row, true);
    t.users = 100000;
    const level = { ...content.difficulties.normal!, tierReserve: 100 };
    t.money = 200;
    const issued: number[] = [];
    const issue = (c: { type: string; buildingId?: number }) => {
      const e = w.entities.find(e => e.id === c.buildingId) as Building;
      expect(rankBlocker(content, w, 0, e)).toBeNull();
      issued.push(e.id);
      startRank(content, w, e);
    };
    rankWalls(w, content, t, level, issue);
    expect(issued).toEqual([b.id]);
    expect(t.money).toBe(120);
    rankWalls(w, content, t, level, issue);
    expect(issued).toEqual([b.id]);
    expect(second.rank).toBeUndefined();
    t.users = 0;
    t.money = 10000;
    rankWalls(w, content, t, level, issue);
    expect(issued).toEqual([b.id]);
  });

  it("bot budgets queued Spot and per-segment orders without rejections", () => {
    const { w, t, core } = setup();
    for (let i = 1; i < 8; i++) placeBuilding(w, content, 0, "wall", core.col + 4 + i, core.row, true);
    t.users = 100000;
    t.money = 1200;
    const level = { ...content.difficulties.normal!, tierReserve: 100 };
    queueCommand(w, { type: "rentCompute", tick: w.tick, team: 0 });
    rankWalls(w, content, t, level, c => queueCommand(w, { ...c, tick: w.tick, team: 0 }));
    expect(w.commands.filter(c => c.type === "rank")).toHaveLength(2);
    applyCommands(makeContext(w, content));
    expect(t.money).toBe(140);
    expect(w.events.filter(e => e.type === "rejected")).toEqual([]);
  });

  it("validates malformed wall rank content", () => {
    for (const patch of [{ cost: 0 }, { tier: 99 }, { ticks: NaN }, { hpPermille: 900 }, { armor: -1 }]) {
      const broken = structuredClone(content);
      Object.assign(broken.economy.wallRanks[0]!, patch);
      expect(() => validateContent(broken)).toThrow(/wall rank/);
    }
  });
});
