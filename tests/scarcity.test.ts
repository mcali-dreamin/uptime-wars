// Spending has to be a choice: every building of a kind costs more than the
// last, and the botnet answers a big base with bigger incidents.

import { describe, expect, it } from "vitest";
import { baseCost, buildCost, createWorld, planWave, threatPermille, type World } from "../src/sim";
import { placeBuilding } from "../src/sim/entities";
import { content, SETUP } from "./fixtures";

const growth = content.economy.costGrowthPermille;
const world = (): World => createWorld(content, SETUP);
const core = (w: World) => w.entities.find((e) => e.id === w.teams[0]!.coreId) as { col: number; row: number };

describe("each one costs more than the last", () => {
  it("the nth rack costs base × (1 + growth × owned)", () => {
    const w = world();
    const base = baseCost(content, "open-source", "server-rack");
    expect(buildCost(w, content, 0, "server-rack")).toBe(base);
    const c = core(w);
    for (let i = 0; i < 4; i += 1) placeBuilding(w, content, 0, "server-rack", c.col + 3 + i * 2, c.row + 3, true);
    expect(buildCost(w, content, 0, "server-rack")).toBe(Math.round((base * (1000 + growth * 4)) / 1000));
    // Other kinds aren't affected.
    expect(buildCost(w, content, 0, "firewall")).toBe(baseCost(content, "open-source", "firewall"));
  });

  it("network buildings don't get dearer: expanding stays cheap", () => {
    const w = world();
    const c = core(w);
    for (let i = 0; i < 5; i += 1) placeBuilding(w, content, 0, "mesh-node", c.col + 3 + i * 2, c.row - 3, true);
    expect(buildCost(w, content, 0, "mesh-node")).toBe(baseCost(content, "open-source", "mesh-node"));
  });

  it("losing one makes the next cheaper again", () => {
    const w = world();
    const c = core(w);
    const rack = placeBuilding(w, content, 0, "server-rack", c.col + 3, c.row + 3, true);
    const dearer = buildCost(w, content, 0, "server-rack");
    rack.hp = 0;
    expect(buildCost(w, content, 0, "server-rack")).toBeLessThan(dearer);
  });
});

describe("the botnet notices a big base", () => {
  it("a fresh base sees normal incidents", () => {
    expect(threatPermille(world(), content)).toBe(1000);
  });

  it("building up and banking $ both grow incidents, up to the cap", () => {
    const w = world();
    const small = planWave(w, content, 4, threatPermille(w, content)).units.length;
    w.teams[0]!.money = content.waves.threat!.referenceWorth * 4;
    const t = threatPermille(w, content);
    expect(t).toBeGreaterThanOrEqual(2000);
    expect(planWave(w, content, 4, t).units.length).toBeGreaterThan(small * 1.5);
    w.teams[0]!.money = 1e9;
    expect(threatPermille(w, content)).toBe(content.waves.threat!.maxScale * 1000);
  });
});
