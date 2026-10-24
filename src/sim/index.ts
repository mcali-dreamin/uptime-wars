export * from "./content";
export * from "./map";
export * from "./types";
export * from "./terrain";
export { flowField, nextStep, hasClearPath, hasLineOfSight, UNREACHABLE } from "./nav";
export { canSee, heightOf } from "./combat";
export { createWorld, step } from "./world";
export { allied, allyBlocker, hasOffered, hostile, hordeTeam, humanTeams, neutralTeam, rulesFor, rulesLabel, unallyBlocker, type Diplomacy, type MatchMode, type MatchRules } from "./teams";
export type { MatchSetup } from "./world";
export { queueCommand } from "./commands";
export { canPlace, canFound, baseCost, buildCost, owned, isOccupied, isCore, inNetwork, networkProviders, teamCores, finishedCores, homeCore, rallyFor } from "./placement";
export { threatPermille, planWave, playerScale, previewWave, trickleBudget, waveInterval, type WavePreview } from "./waves";
export { STARTING_MONEY, BASE_INCOME, EXPANSION_CLEARANCE, MAX_ORDER_UNITS, RESEARCH_QUEUE } from "./tuning";
export { computeBalance, spotCost, spotState, incomeRate, unitUpkeep, trafficRadius, userCapacity } from "./economy";
export { canResearch, levelOf, multiplier, nextLevel, nextQueued, projectedTier, queueOf, queuedCount } from "./upgrades";
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
export { FARM_COUNT, farmSpots, farmsDown, farmsStanding, fortressGates, fortressSpots, nestShielded } from "./fortress";
export { campSpots, type CampSpot } from "./neutrals";
export { invokeBlocker, invokeCost } from "./functions";
export { forkBlocker, forkCost, regionShield } from "./mechanics";
export { isJammed } from "./roles";
export { coreReachBonus, reachOf } from "./placement";
export { earnedPerks, mechanicsAtTier, modifiersAtTier, raceMechanics, raceModifiers, tierAllowance, tierBlocker, tierDef, tierOf, tierUpgrade } from "./tiers";
export { traitsFor } from "./traits";
export { bonus, centerOf, slotOf, upgradeName, upgradesAt } from "./upgrades";
export { buildingMaxHp } from "./entities";
export { MAX_ITEMS, atShop, itemTotals, rollDrop, sellValue, shopBlocker, shopRadius } from "./items";
export { buildingRank, nextRank, rankBlocker, rankCost, rankGroup, rankedUpkeep, ranksOf, refitting, unitRank } from "./ranks";
export { infectionSites, liveNodes } from "./spread";
export { difficultyOf, revenueFactor } from "./ai";
export { decommissionBlocker, decommissionRefund, dismissable } from "./decommission";
export { transferOwnership, isSite } from "./ownership";
export { sitesHeld } from "./sites";
