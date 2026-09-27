export * from "./content";
export * from "./map";
export * from "./types";
export { createWorld, queueCommand, step, isOccupied, STARTING_COMPUTE, BASE_INCOME } from "./world";
export type { MatchSetup } from "./world";
export { hashWorld } from "./hash";

import type { Content } from "./content";
import type { Command, World } from "./types";
import { createWorld, queueCommand, step, type MatchSetup } from "./world";

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
