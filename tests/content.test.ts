import { describe, expect, it } from "vitest";
import {
  validateContent,
  type Content,
} from "../src/sim";
import { content } from "./fixtures";

describe("content", () => {
  it.each([-1, 0.5, NaN, undefined])("rejects invalid expansion allowances (%s)", (expansions) => {
    const broken: Content = structuredClone(content);
    broken.economy.tiers[0]!.expansions = expansions as number;
    expect(() => validateContent(broken)).toThrow(/expansions must be a non-negative integer/);
  });

  it("rejects broken references", () => {
    const broken: Content = structuredClone(content);
    broken.waves.roster[0]!.unit = "missing";
    expect(() => validateContent(broken)).toThrow(/unknown unit missing/);
  });

  it("requires every race to have a 2x2 core", () => {
    const broken: Content = structuredClone(content);
    broken.races.botnet!.core = "server-rack";
    expect(() => validateContent(broken)).toThrow(/2x2 footprint/);
  });

  it("refuses a race that lists its core in the build roster", () => {
    const broken: Content = structuredClone(content);
    broken.races["open-source"]!.buildings.push(broken.races["open-source"]!.core);
    expect(() => validateContent(broken)).toThrow(/lists its core core/);
  });

  it("every human race can build the Package Registry", () => {
    for (const [id, race] of Object.entries(content.races)) {
      if (race.controller === "human") expect(race.buildings, id).toContain("package-registry");
    }
  });

  it("rejects a non-positive shop radius", () => {
    const broken: Content = structuredClone(content);
    broken.items.shopRadius = 0;
    expect(() => validateContent(broken)).toThrow(/shopRadius/);
  });
});
