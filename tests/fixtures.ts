// Shared setup for the simulation tests.

import { loadDefaultContent, type BuildCommand } from "../src/sim";
import { planBuildOrder } from "./helpers";

export { planBuildOrder };

export const content = loadDefaultContent();
// Most tests skip the builder phase; the "builder start" block covers it.
export const SETUP = { seed: 1234, races: ["open-source", "botnet"] as [string, string], startWithCore: true };

export const OPENING_ORDER: [number, string][] = [
  [1, "server-rack"],
  [1, "server-rack"],
  [200, "firewall"],
  [400, "solar-array"],
  [700, "gpu-cluster"],
  [1000, "firewall"],
  [1300, "server-rack"],
];
export const OPENING = planBuildOrder(content, SETUP, OPENING_ORDER);

export function firstSpot(building: string, tick = 0): BuildCommand {
  return planBuildOrder(content, SETUP, [[tick, building]])[0]!;
}
