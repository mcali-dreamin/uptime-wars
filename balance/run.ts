// Shared by the per-race balance runs: play every hero of a race on a few
// maps and write the results to balance-results/<race>.json.

// @ts-expect-error: Node built-ins; the project ships no Node types (balance runs under vitest).
import { mkdirSync, writeFileSync } from "node:fs";

declare const process: { env: Record<string, string | undefined> };
import { loadDefaultContent } from "../src/sim";
import { playMatch, type BotResult } from "./bot";

export const SEEDS = (process.env.BALANCE_SEEDS ?? "1,42,99,2026").split(",").map(Number);
export const MINUTES = Number(process.env.BALANCE_MINUTES ?? 35);

export function runRace(race: string): BotResult[] {
  const content = loadDefaultContent();
  const results: BotResult[] = [];
  const heroes = content.races[race]!.heroes ?? [];
  const hero = process.env.BALANCE_NO_HERO ? false : true;
  for (const heroId of heroes) {
    for (const seed of SEEDS) {
      results.push(playMatch(content, race, seed, heroId, { minutes: MINUTES, hero }));
      mkdirSync("balance-results", { recursive: true });
      writeFileSync(`balance-results/${race}.json`, JSON.stringify(results, null, 1));
    }
  }
  return results;
}
