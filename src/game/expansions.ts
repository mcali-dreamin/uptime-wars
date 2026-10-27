// Expansion health for the HUD: pure, so it is testable without the DOM.

import { teamCores, type Content, type World, type Team } from "../sim";

/** Below this share of max HP the weakest expansion reads as danger. */
export const EXPANSION_DANGER = 0.5;

/** HP fraction (0..1) of the weakest finished, living expansion (any core but `team.coreId`), or null with none. */
export function weakestExpansion(world: World, content: Content, team: Team): number | null {
  let weakest: number | null = null;
  for (const core of teamCores(world, content, team)) {
    if (core.id === team.coreId || core.buildRemaining !== 0 || core.hp <= 0) continue;
    const frac = Math.max(0, core.hp) / core.maxHp;
    if (weakest === null || frac < weakest) weakest = frac;
  }
  return weakest;
}
