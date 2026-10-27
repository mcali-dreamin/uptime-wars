import { describe, expect, it } from "vitest";
import { createWorld, type Building } from "../src/sim";
import { weakestExpansion } from "../src/game/expansions";
import { content, SETUP } from "./fixtures";

describe("weakestExpansion", () => {
  it("is null with only the main core, else the lowest HP share among expansions", () => {
    const world = createWorld(content, SETUP);
    const team = world.teams[0]!;
    const core = world.entities.find((e): e is Building => e.id === team.coreId)!;
    expect(weakestExpansion(world, content, team)).toBeNull();
    core.hp = 1;
    const mk = (id: number, frac: number, remaining = 0) =>
      world.entities.push({ ...core, id, hp: core.maxHp * frac, buildRemaining: remaining } as Building);
    mk(9001, 0.8);
    mk(9002, 0.43);
    mk(9003, 0.1, 50);
    expect(weakestExpansion(world, content, team)).toBeCloseTo(0.43);
  });
});
