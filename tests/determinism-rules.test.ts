// The simulation must produce the same world on every machine. These calls
// are either random, clock-dependent, or allowed to differ between JS engines,
// so they may not appear in src/sim (comments excepted).

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob<string>("../src/sim/*.ts", { query: "?raw", import: "default", eager: true });

const BANNED: [RegExp, string][] = [
  [/Math\.random\b/, "use the seeded RNG in rng.ts"],
  [/\bDate\b/, "the sim has no wall clock; use world.tick"],
  [/performance\.now\b/, "the sim has no wall clock; use world.tick"],
  [/Math\.(hypot|pow|exp|expm1|log|log1p|log2|log10|cbrt|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh)\b/, "engine-approximated; use + - * / and Math.sqrt"],
  [/\*\*/, "exponentiation is engine-approximated; multiply instead"],
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("determinism rules", () => {
  const files = Object.entries(SOURCES).map(([path, source]) => [path.split("/").pop()!, source] as const);

  it("finds the simulation sources", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const [file, source] of files) {
    it(`${file} uses only deterministic operations`, () => {
      const lines = stripComments(source).split("\n");
      const violations: string[] = [];
      lines.forEach((line, index) => {
        for (const [pattern, why] of BANNED) {
          if (pattern.test(line)) violations.push(`${file}:${index + 1} ${line.trim()}  (${why})`);
        }
      });
      expect(violations).toEqual([]);
    });
  }
});
