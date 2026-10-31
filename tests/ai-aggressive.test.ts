// The aggressive AI mode (issue #184): off by default (real matches unchanged);
// on, it rents Spot, trains a deploy agent, and sends its army at a Botnet Farm.

import { describe, expect, it } from "vitest";
import { TICK_RATE, createWorld, hashWorld, step, computeBalance, type Content, type World } from "../src/sim";
import { expand } from "../src/sim/ai/aggressive";
import { squadReserve } from "../src/sim/economy";
import { content as base } from "./fixtures";

const SETUP = { seed: 42, races: ["open-source", "botnet"] as [string, string], startWithCore: true, ai: ["normal"] };
const withLevel = (patch: Record<string, unknown>): Content => ({
  ...base,
  difficulties: {
    ...base.difficulties,
    normal: {
      ...base.difficulties.normal!,
      ...patch,
      attack: { ...base.difficulties.normal!.attack!, firstTicks: 30 * TICK_RATE },
    } as never,
  },
});

describe("aggressive AI", () => {
  it("does not issue trainAgent at the tier-zero expansion limit", () => {
    const world = createWorld(base, SETUP);
    const team = world.teams[0]!;
    team.money = 10_000;
    const issued: unknown[] = [];
    expand(world, base, team, base.difficulties.normal!, (command) => issued.push(command));
    expect(issued).toEqual([]);
  });

  it("no real difficulty sets it", () => {
    for (const d of Object.values(base.difficulties)) expect(d.aggressive).toBeUndefined();
  });

  it("with the field absent or false, the AI plays identically", () => {
    const hashes = [undefined, false].map((aggressive) => {
      const content = withLevel(aggressive === undefined ? {} : { aggressive });
      const world = createWorld(content, SETUP);
      while (world.tick < 90 * TICK_RATE && !world.outcome) step(world, content);
      return hashWorld(world);
    });
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("rents Spot when capped, trains an agent, and sends its army at a farm", () => {
    const content = withLevel({ aggressive: true });
    const world: World = createWorld(content, SETUP);
    const team = world.teams[0]!;
    const farm = content.waves.fortress.farms.building;
    let capped = false;
    let agent = false;
    let atFarm = false;
    const limit = 4 * 60 * TICK_RATE;
    while (world.tick < limit && !world.outcome) {
      // Money to spare, so only the AI's choices are under test.
      if (world.tick % 100 === 0) team.money = Math.max(team.money, 3000);
      step(world, content);
      const { supply, demand } = computeBalance(world, content, team);
      if (supply - demand < squadReserve(world, content, team)) capped = true;
      if (world.entities.some((e) => e.id === team.builderId && e.hp > 0)) agent = true;
      if (team.ai!.phase === "attack" && world.entities.some((e) => e.id === team.ai!.goalId && e.kind === "building" && e.defId === farm)) atFarm = true;
    }
    expect(capped).toBe(true);
    expect(team.spotRentals).toBeGreaterThan(0);
    expect(agent).toBe(true);
    expect(atFarm).toBe(true);
  });
});
