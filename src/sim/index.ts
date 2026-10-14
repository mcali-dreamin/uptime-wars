export * from "./content";
export * from "./map";
export * from "./types";
export * from "./terrain";
export { flowField, nextStep, hasClearPath, hasLineOfSight, UNREACHABLE } from "./nav";
export { canSee, heightOf } from "./combat";
export { createWorld, step } from "./world";
export { hostile, hordeTeam, humanTeams, type MatchMode } from "./teams";
export type { MatchSetup } from "./world";
export { queueCommand } from "./commands";
export { canPlace, canFound, baseCost, buildCost, owned, isOccupied, isCore, inNetwork, networkProviders, teamCores } from "./placement";
export { threatPermille, planWave, playerScale, previewWave, trickleBudget, waveInterval, type WavePreview } from "./waves";
export { STARTING_MONEY, BASE_INCOME } from "./tuning";
export { computeBalance, incomeRate, trafficRadius, userCapacity } from "./economy";
export { canResearch, levelOf, multiplier, nextLevel } from "./upgrades";
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
export { farmSpots, farmsDown, fortressGates, fortressSpots } from "./fortress";
export { invokeBlocker, invokeCost } from "./functions";
export { forkBlocker, forkCost, regionShield } from "./mechanics";
export { isJammed } from "./roles";
export { coreReachBonus, reachOf } from "./placement";
export { earnedPerks, raceMechanics, raceModifiers, tierBlocker, tierDef, tierOf, tierUpgrade } from "./tiers";
export { traitsFor } from "./traits";
export { bonus, centerOf, slotOf, upgradeName, upgradesAt } from "./upgrades";
export { buildingMaxHp } from "./entities";
export { infectionSites, liveNodes } from "./spread";
