import { describe, expect, it } from "vitest";
import {
  createWorld,
  hashWorld,
  queueCommand,
  simulate,
  step,
} from "../src/sim";
import { content, SETUP, OPENING_ORDER, OPENING, planBuildOrder } from "./fixtures";

describe("determinism", () => {
  it("same seed and command log produce the same world", () => {
    const a = simulate(content, SETUP, OPENING, 3000);
    const b = simulate(content, SETUP, OPENING, 3000);
    expect(a.tick).toBe(b.tick);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it("a different seed diverges", () => {
    const other = { ...SETUP, seed: 99 };
    const a = simulate(content, SETUP, OPENING, 1500);
    const b = simulate(content, other, planBuildOrder(content, other, OPENING_ORDER), 1500);
    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });

  it("hash is stable when checked mid-match (replay checkpoints)", () => {
    const run = () => {
      const world = createWorld(content, SETUP);
      for (const command of OPENING) queueCommand(world, command);
      const checkpoints: string[] = [];
      for (let i = 0; i < 1500; i += 1) {
        step(world, content);
        if (world.tick % 300 === 0) checkpoints.push(hashWorld(world));
      }
      return checkpoints;
    };
    expect(run()).toEqual(run());
  });
});
