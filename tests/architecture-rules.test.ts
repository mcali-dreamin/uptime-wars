// The layers only point one way. Breaking this is how a codebase stops
// scaling, so it fails the build:
//
//   sim     -> nothing outside sim (and the content JSON). No DOM, no renderer.
//   game    -> sim
//   render  -> sim
//   ui      -> game, sim
//   audio   -> sim (sounds and music, decided from sim events)
//   input.ts, main.ts -> anything (they wire it together)
//
// The simulation must also stay runnable headless (server-side replay,
// lockstep peers), so it can't touch browser globals.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

const LAYERS: Record<string, string[]> = {
  sim: ["sim", "content"],
  game: ["game", "sim"],
  render: ["render", "sim"],
  ui: ["ui", "game", "sim"],
  audio: ["audio", "sim"],
};
const BROWSER_GLOBALS = /\b(window|document|localStorage|location|navigator|requestAnimationFrame)\b/;
const PACKAGES: Record<string, string[]> = { sim: [], game: [], ui: [], audio: [], render: ["pixi.js", "three"] };

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Resolve a relative import from src/<from> to its top-level folder under src. */
function layerOf(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts[0] ?? "";
}

describe("architecture rules", () => {
  const files = Object.entries(SOURCES).map(([path, source]) => [path.replace("../src/", ""), source] as const);

  for (const [file, source] of files) {
    const layer = file.split("/")[0]!;
    const allowed = LAYERS[layer];
    if (!allowed) continue;
    it(`${file} only imports from ${allowed.join(", ")}`, () => {
      const imports = [...stripComments(source).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      // A package's subpaths (three/addons/...) count as the package.
      const allowedPackage = (specifier: string) =>
        PACKAGES[layer]!.some((name) => specifier === name || specifier.startsWith(`${name}/`));
      const violations = imports.filter((specifier) =>
        specifier.startsWith(".") ? !allowed.includes(layerOf(file, specifier)) : !allowedPackage(specifier),
      );
      expect(violations).toEqual([]);
    });
  }

  for (const [file, source] of files.filter(([f]) => f.startsWith("sim/"))) {
    it(`${file} doesn't touch browser globals`, () => {
      expect(stripComments(source).split("\n").filter((line) => BROWSER_GLOBALS.test(line))).toEqual([]);
    });
  }
});
