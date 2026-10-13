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

/** Why a team's tier keeps it from building this, or null. */
export function tierBlocker(content: Content, team: Team, buildingId: string, have: number): string | null {
  const def = content.buildings[buildingId]!;
  const tier = tierOf(content, team);
  if ((def.tier ?? 0) > tier) return `needs ${content.economy.tiers[def.tier!]!.name}`;
  if (def.limitPerTier) {
    const limit = def.limitPerTier[Math.min(tier, def.limitPerTier.length - 1)]!;
    if (have >= limit) return `only ${limit} at ${content.economy.tiers[tier]!.name}`;
  }
  return null;
}

/** The perks a team has earned so far (tiers 1..its tier), in order. */
export function earnedPerks(content: Content, team: Team) {
  const perks = content.races[team.raceId]?.tierPerks ?? [];
  return perks.slice(1, tierOf(content, team) + 1).filter((p): p is NonNullable<typeof p> => p !== null && p !== undefined);
}

/** The race's mechanics with every earned tier perk applied. */
export function raceMechanics(content: Content, team: Team): NonNullable<RaceDef["mechanics"]> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(content.races[team.raceId]?.mechanics ?? {})) merged[k] = { ...(v as object) };
  for (const perk of earnedPerks(content, team)) {
    for (const [k, v] of Object.entries(perk.mechanics ?? {})) merged[k] = { ...(merged[k] ?? {}), ...(v as object) };
  }
  return merged as NonNullable<RaceDef["mechanics"]>;
}

/** The race's modifiers with every earned tier perk applied. */
export function raceModifiers(content: Content, team: Team): RaceDef["modifiers"] {
  let modifiers = { ...content.races[team.raceId]!.modifiers };
  for (const perk of earnedPerks(content, team)) modifiers = { ...modifiers, ...perk.modifiers };
  return modifiers;
}
