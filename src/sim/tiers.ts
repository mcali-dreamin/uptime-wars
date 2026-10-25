// Core tech tiers, WC3 town hall style: Core -> Data Center -> Region.
// The tier is the level of the "tier" upgrade, researched at the core like
// any other (one research at a time), so it rides the same command, timer
// and determinism as the rest. What a tier does is data: economy.tiers.

import type { Content, RaceDef } from "./content";
import type { Team } from "./types";

/** The id of the upgrade whose level is the core tier, if the content has one. */
export function tierUpgrade(content: Content): string | undefined {
  return Object.keys(content.upgrades).find((id) => content.upgrades[id]!.stat === "tier");
}

/** A team's core tier: 0 until it upgrades. */
export function tierOf(content: Content, team: Team | undefined): number {
  const id = tierUpgrade(content);
  return team && id ? (team.upgrades[id] ?? 0) : 0;
}

/** What a team's current tier gives. */
export function tierDef(content: Content, team: Team | undefined) {
  const tiers = content.economy.tiers;
  return tiers[Math.min(tierOf(content, team), tiers.length - 1)]!;
}

/** At the last core tier: nothing left to grow into. */
export function atTopTier(content: Content, team: Team): boolean {
  return tierOf(content, team) >= content.economy.tiers.length - 1;
}

/**
 * The per-tier limit at a team's cores: the main core's allowance L, plus
 * half of it rounded up for every other live, finished core (see
 * finishedCores). Expanding is how the caps grow past one base.
 */
export function tierAllowance(limit: number, cores: number): number {
  return limit + Math.max(0, cores - 1) * Math.ceil(limit / 2);
}

/** How many of this building past its top-tier limit the next one would be (0 if within it). */
export function pastLimit(content: Content, team: Team, buildingId: string, have: number, cores: number): number {
  const def = content.buildings[buildingId]!;
  if (!def.limitPerTier || !def.pastLimitGrowthPermille || !atTopTier(content, team)) return 0;
  return Math.max(0, have + 1 - tierAllowance(def.limitPerTier[def.limitPerTier.length - 1]!, cores));
}

/** Why a team's tier keeps it from building this, or null. */
export function tierBlocker(content: Content, team: Team, buildingId: string, have: number, cores: number): string | null {
  const def = content.buildings[buildingId]!;
  const tier = tierOf(content, team);
  if ((def.tier ?? 0) > tier) return `needs ${content.economy.tiers[def.tier!]!.name}`;
  if (def.limitPerTier && !(def.pastLimitGrowthPermille && atTopTier(content, team))) {
    // The upgrade center stays one per team: research is a team queue, not a per-base one.
    const isCenter = content.races[team.raceId]?.center === buildingId;
    const limit = tierAllowance(def.limitPerTier[Math.min(tier, def.limitPerTier.length - 1)]!, isCenter ? 1 : cores);
    if (have >= limit) return `only ${limit} at ${content.economy.tiers[tier]!.name}`;
  }
  return null;
}

/** The perks a team has earned so far (tiers 1..its tier), in order. */
export function earnedPerks(content: Content, team: Team) {
  return perksUpTo(content, team.raceId, tierOf(content, team));
}

/** A race's perks for tiers 1..tier, in order. */
function perksUpTo(content: Content, raceId: string, tier: number) {
  const perks = content.races[raceId]?.tierPerks ?? [];
  return perks.slice(1, tier + 1).filter((p): p is NonNullable<typeof p> => p !== null && p !== undefined);
}

/** The race's mechanics with every earned tier perk applied. */
export function raceMechanics(content: Content, team: Team): NonNullable<RaceDef["mechanics"]> {
  return mechanicsAtTier(content, team.raceId, tierOf(content, team));
}

/** A race's mechanics at a core tier, its perks up to that tier applied. */
export function mechanicsAtTier(content: Content, raceId: string, tier: number): NonNullable<RaceDef["mechanics"]> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(content.races[raceId]?.mechanics ?? {})) merged[k] = { ...(v as object) };
  for (const perk of perksUpTo(content, raceId, tier)) {
    for (const [k, v] of Object.entries(perk.mechanics ?? {})) merged[k] = { ...(merged[k] ?? {}), ...(v as object) };
  }
  return merged as NonNullable<RaceDef["mechanics"]>;
}

/** The race's modifiers with every earned tier perk applied. */
export function raceModifiers(content: Content, team: Team): RaceDef["modifiers"] {
  return modifiersAtTier(content, team.raceId, tierOf(content, team));
}

/** A race's modifiers at a core tier, its perks up to that tier applied. */
export function modifiersAtTier(content: Content, raceId: string, tier: number): RaceDef["modifiers"] {
  let modifiers = { ...content.races[raceId]!.modifiers };
  for (const perk of perksUpTo(content, raceId, tier)) modifiers = { ...modifiers, ...perk.modifiers };
  return modifiers;
}
