export * from "./content";
export * from "./map";
export * from "./types";
export * from "./terrain";
export { flowField, nextStep, hasLineOfSight, UNREACHABLE } from "./nav";
export { createWorld, step } from "./world";
export type { MatchSetup } from "./world";
export { queueCommand } from "./commands";
export { canPlace, canFound, buildCost, isOccupied } from "./placement";
export { planWave, waveInterval } from "./waves";
export { STARTING_COMPUTE, BASE_INCOME } from "./tuning";
export { hashWorld, hashTerrain } from "./hash";

import type { Content } from "./content";
import type { Command, World } from "./types";
import { queueCommand } from "./commands";
import { createWorld, step, type MatchSetup } from "./world";

/** Run a match headless from a command log. Used by tests and replay checks. */
export function simulate(
  content: Content,
  setup: MatchSetup,
  commands: Command[],
  maxTicks: number,
): World {
  const world = createWorld(content, setup);
  for (const command of commands) queueCommand(world, command);
  while (world.tick < maxTicks && !world.outcome) step(world, content);
  return world;
}
