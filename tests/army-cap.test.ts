// Compute is the army cap: spawners stall at it, more spawners never field more.

import { describe, expect, it } from "vitest";
import { computeBalance, createWorld, queueCommand, step } from "../src/sim";
import { content, planBuildOrder, SETUP } from "./fixtures";

function armyAfter(racks: number, ticks: number) {
  const world = createWorld(content, SETUP);
  world.teams[0]!.money = 100_000;
  world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
  const order = Array.from({ length: racks }, () => [1, "server-rack"] as [number, string]);
  for (const c of planBuildOrder(content, SETUP, order)) queueCommand(world, c);
  while (world.tick < ticks) step(world, content);
  const units = world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard").length;
  return { world, units };
}

describe("army cap", () => {
  it("the army never uses more compute than you supply", () => {
    for (const racks of [3, 12, 20]) {
      const { world } = armyAfter(racks, 3000);
      const team = world.teams[0]!;
      const { supply } = computeBalance(world, content, team);
      const upkeep = world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard").length * 2;
      expect(upkeep, `${racks} racks`).toBeLessThanOrEqual(supply);
    }
  });

  it("a bigger army costs users: units and users share compute", () => {
    const few = armyAfter(3, 4000);
    const many = armyAfter(20, 4000);
    expect(many.units).toBeGreaterThan(few.units);
    expect(many.world.teams[0]!.users).toBeLessThan(few.world.teams[0]!.users);
    // ...and it's bounded: twenty racks field well under twice what six do.
    expect(many.units).toBeLessThan(armyAfter(6, 4000).units * 2);
  });

  it("generators are limited per core tier", () => {
    for (const id of ["solar-array", "power-plant", "compute-pool", "private-cloud"]) {
      expect(content.buildings[id]!.limitPerTier, id).toBeDefined();
    }
  });
});
