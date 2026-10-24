// Low Latency: the upgrade center's movement-speed upgrade. Every unit of the
// team walks faster per level; nobody else does.

import { describe, expect, it } from "vitest";
import { createWorld, multiplier, type Unit, type World } from "../src/sim";
import { effectiveDef } from "../src/sim/traits";
import { content } from "./fixtures";

const UPGRADE = "low-latency";
const world = (): World => createWorld(content, { seed: 1234, races: ["open-source", "botnet"], startWithCore: true });
const speedOf = (w: World, team: number, defId: string) => {
  const unit = { defId } as Unit;
  return effectiveDef(content, w.teams[team], unit, content.units[defId]!).speed;
};

describe("unit speed upgrade", () => {
  it("is researched at every race's upgrade center, three levels gated by core tier", () => {
    const def = content.upgrades[UPGRADE]!;
    expect(def.stat).toBe("unitSpeed");
    expect(def.at).toBe("center");
    expect(def.races).toBeUndefined();
    expect(def.maxLevel).toBe(3);
    expect(def.tiers).toEqual([0, 1, 2]);
  });

  it("speeds up the team's units by perLevel per level, and only that team's", () => {
    const w = world();
    const defId = Object.keys(content.units).find((id) => content.units[id]!.speed > 0)!;
    const base = speedOf(w, 0, defId);
    expect(base).toBe(content.units[defId]!.speed);
    w.teams[0]!.upgrades[UPGRADE] = 2;
    const per = content.upgrades[UPGRADE]!.perLevel;
    expect(multiplier(content, w.teams[0], "unitSpeed")).toBeCloseTo(1 + 2 * per);
    expect(speedOf(w, 0, defId)).toBeCloseTo(base * (1 + 2 * per));
    expect(speedOf(w, 1, defId)).toBe(content.units[defId]!.speed);
  });

  it("with nothing researched the def is untouched (same object), so old replays don't move", () => {
    const w = world();
    const defId = Object.keys(content.units)[0]!;
    expect(effectiveDef(content, w.teams[0], { defId } as Unit, content.units[defId]!)).toBe(content.units[defId]!);
  });
});
