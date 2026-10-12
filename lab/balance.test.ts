// Balance lab: scripted bases for every playable race, many seeds, full
// matches. Heavy (minutes of CPU), so it's not part of `npm test`; run it on
// the Homeboy lab:
//
//   homeboy runner exec homeboy-lab --sync-workspace . --hydrate-deps -- npm run balance
//
// Env: BALANCE_SEEDS (count, default 12), BALANCE_MINUTES (cap, default 20).
// Prints one JSON line per race, prefixed BALANCE.

import { it } from "vitest";
import { createWorld, queueCommand, step, TICK_RATE } from "../src/sim";
import { content, planBuildOrder } from "../tests/fixtures";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SEEDS = Array.from({ length: Number(env.BALANCE_SEEDS ?? 12) }, (_, i) => [1, 7, 42, 1234, 99, 5, 2026, 31337, 8, 77, 3, 11][i] ?? i * 7919 + 13);
const MINUTES = Number(env.BALANCE_MINUTES ?? 20);

/** What each race builds, in order, as soon as it can afford it. */
const BUILDS: Record<string, string[]> = {
  "open-source": ["server-rack", "server-rack", "firewall", "solar-array", "web-app", "server-rack", "firewall", "solar-array", "web-app", "gpu-cluster", "web-app", "server-rack"],
  hyperscaler: ["hyperscale-rack", "hyperscale-rack", "cdn-edge", "power-plant", "web-app", "hyperscale-rack", "cdn-edge", "web-app", "gpu-cluster", "web-app", "hyperscale-rack"],
  serverless: ["function", "function", "inference-endpoint", "web-app", "function", "inference-endpoint", "web-app", "function", "web-app", "function"],
  "walled-garden": ["flagship-store", "app-review", "private-cloud", "web-app", "flagship-store", "app-review", "web-app", "app-review", "web-app", "flagship-store"],
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

for (const [race, build] of Object.entries(BUILDS)) {
  it(`balance: ${race}`, () => {
    if (!content.races[race]) return;
    const survived: number[] = [];
    const events: Record<string, number> = {};
    for (const seed of SEEDS) {
      const setup = { seed, races: [race, "botnet"], startWithCore: true };
      const world = createWorld(content, setup);
      const spots = planBuildOrder(content, setup, build.map((b) => [0, b] as [number, string]));
      let next = 0;
      while (world.tick < MINUTES * 60 * TICK_RATE && !world.outcome) {
        const want = spots[next];
        if (want && world.teams[0]!.money >= content.buildings[want.building]!.cost) {
          queueCommand(world, { ...want, tick: world.tick });
          next += 1;
        }
        step(world, content);
        for (const e of world.events) if (e.type === "reported" || e.type === "invoked" || e.type === "fortified") events[e.type] = (events[e.type] ?? 0) + 1;
      }
      survived.push(world.outcome ? world.tick / TICK_RATE / 60 : MINUTES);
    }
    const perMatch = Object.fromEntries(Object.entries(events).map(([k, v]) => [k, +(v / SEEDS.length).toFixed(1)]));
    console.log(`BALANCE ${JSON.stringify({ race, seeds: SEEDS.length, medianMinutes: +median(survived).toFixed(1), min: +Math.min(...survived).toFixed(1), max: +Math.max(...survived).toFixed(1), perMatch })}`);
  }, 3_600_000);
}
