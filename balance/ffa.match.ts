// Computer vs computer free-for-alls (not part of the game, not run in CI):
// does a computer player actually win games, does the harder one win more,
// can every race win?
//
//   FFA="hard:serverless,normal:hyperscaler" FFA_SEEDS=1,42 FFA_HORDE=1 npm run balance:ffa
//
// Writes balance-results/ffa/results.json (its own folder: npm run balance reports the rest) and prints one line per match.

// @ts-expect-error: Node built-ins; the project ships no Node types (runs under vitest).
import { mkdirSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { TICK_RATE, createWorld, loadDefaultContent, step } from "../src/sim";

declare const process: { env: Record<string, string | undefined> };

const content = loadDefaultContent();
const SEEDS = (process.env.FFA_SEEDS ?? "1,42,99,2026").split(",").map(Number);
const MINUTES = Number(process.env.FFA_MINUTES ?? 40);
const HORDE = process.env.FFA_HORDE !== "0";
const SETUPS = (process.env.FFA ?? "normal:open-source,normal:hyperscaler,normal:serverless,normal:walled-garden").split(";");

const fmt = (ticks: number) => `${Math.floor(ticks / TICK_RATE / 60)}:${String(Math.floor((ticks / TICK_RATE) % 60)).padStart(2, "0")}`;

it("ffa", () => {
  const results: unknown[] = [];
  for (const setup of SETUPS) {
    const slots = setup.split(",").map((s) => s.split(":") as [string, string]);
    for (const seed of SEEDS) {
      const world = createWorld(content, {
        seed,
        mode: "ffa",
        races: [...slots.map(([, race]) => race), ...(HORDE ? ["botnet"] : [])],
        ai: slots.map(([difficulty]) => difficulty),
      });
      const limit = MINUTES * 60 * TICK_RATE;
      while (world.tick < limit && !world.outcome) step(world, content);
      const players = slots.map(([difficulty, race], id) => ({ difficulty, race, out: world.teams[id]!.downTick }));
      const winners = world.outcome?.winners ?? [];
      const line = players
        .map((p, id) => `${p.difficulty}:${p.race}${winners.includes(id) ? " WON" : p.out === null ? " up" : ` out ${fmt(p.out)}`}`)
        .join(" | ");
      console.log(`seed ${seed} ${world.outcome ? fmt(world.outcome.tick) : `${MINUTES}:00+`}  ${line}`);
      results.push({ setup, seed, ticks: world.outcome?.tick ?? world.tick, winners, players });
      mkdirSync("balance-results/ffa", { recursive: true });
      writeFileSync("balance-results/ffa/results.json", JSON.stringify(results, null, 1));
    }
  }
});
