// Who's on whose side. Matches are composed from a few rules (MatchRules)
// rather than picked from a list of modes:
//
// - sides:        a starting side per player; the same side is allied.
//                 Everyone on one side is co-op, everyone alone is FFA,
//                 and 2v2 or 3v1 come free.
// - diplomacy:    "open" lets players ally and unally during the match
//                 (ally/unally commands); "locked" keeps the starting sides.
// - nestMustFall: with the botnet in, a side has to take the nest down to
//                 win. Off, the botnet is pressure, not an objective.
// - the botnet itself is in or out by whether the races include it.
//
// The horde is always everyone's enemy. Alliances are mutual and live in
// world.allies, one bitmask per team, so hostile() stays a bit test.

import type { Team, TeamId, World } from "./types";

/** The old presets. Each expands into rules (see rulesFor). */
export type MatchMode = "coop" | "ffa";

export type Diplomacy = "open" | "locked";

export interface MatchRules {
  /** Starting side per player (team order). Same number = allied. */
  sides: number[];
  diplomacy: Diplomacy;
  /** With the botnet in: a side must take the nest down to win. */
  nestMustFall: boolean;
}

/** The rules a preset stands for, for `players` players. */
export function rulesFor(mode: MatchMode, players: number): MatchRules {
  return mode === "ffa"
    ? { sides: Array.from({ length: players }, (_, i) => i), diplomacy: "locked", nestMustFall: false }
    : { sides: Array.from({ length: players }, () => 0), diplomacy: "locked", nestMustFall: true };
}

/** A short name for a set of rules: the preset it matches, or "custom". */
export function rulesLabel(world: World): "coop" | "ffa" | "custom" {
  const { sides, diplomacy, nestMustFall } = world.rules;
  if (diplomacy !== "locked") return "custom";
  if (sides.every((s) => s === sides[0]) && nestMustFall && hordeTeam(world)) return "coop";
  if (new Set(sides).size === sides.length && !nestMustFall && sides.length > 1) return "ffa";
  return "custom";
}

/** Each team's starting allies, as bitmasks (a team is always its own ally). */
export function startingAllies(teams: readonly Team[], rules: MatchRules): number[] {
  return teams.map((team) => {
    let mask = 1 << team.id;
    if (team.controller !== "human") return mask;
    for (const other of teams) {
      if (other.controller === "human" && rules.sides[other.id] === rules.sides[team.id]) mask |= 1 << other.id;
    }
    return mask;
  });
}

/** Whether two teams fight. */
export function hostile(world: World, a: TeamId, b: TeamId): boolean {
  return ((world.allies[a]! >> b) & 1) === 0;
}

/** Whether two teams are allied (a team counts as its own ally). */
export function allied(world: World, a: TeamId, b: TeamId): boolean {
  return !hostile(world, a, b);
}

/** The human teams, in team order. */
export function humanTeams(world: World): Team[] {
  return world.teams.filter((team) => team.controller === "human");
}

/** The team the wave director drives, if any. */
export function hordeTeam(world: World): Team | undefined {
  return world.teams.find((team) => team.controller === "wave-director");
}

/** Why a player can't propose (or accept) an alliance with `other` now, or null. */
export function allyBlocker(world: World, team: TeamId, other: TeamId): string | null {
  if (world.rules.diplomacy !== "open") return "alliances are locked";
  const a = world.teams[team];
  const b = world.teams[other];
  if (!a || !b || a === b || b.controller !== "human") return "not a player";
  if (a.downTick !== null || b.downTick !== null) return "offline";
  if (allied(world, team, other)) return "already allied";
  return null;
}

/** Why a player can't break an alliance with `other` now, or null. */
export function unallyBlocker(world: World, team: TeamId, other: TeamId): string | null {
  if (world.rules.diplomacy !== "open") return "alliances are locked";
  const a = world.teams[team];
  const b = world.teams[other];
  if (!a || !b || a === b || b.controller !== "human") return "not a player";
  if (a.downTick !== null || b.downTick !== null) return "offline";
  if (!allied(world, team, other) && !hasOffered(world, team, other)) return "not allied";
  return null;
}

/** Whether `team` has offered `other` an alliance that isn't answered yet. */
export function hasOffered(world: World, team: TeamId, other: TeamId): boolean {
  return ((world.offers[team]! >> other) & 1) === 1;
}

/**
 * Offer an alliance, or accept one already offered. Mutual: it forms only
 * once both have asked. Returns whether it formed.
 */
export function offerAlliance(world: World, team: TeamId, other: TeamId): boolean {
  if (hasOffered(world, other, team)) {
    world.offers[other]! &= ~(1 << team);
    world.offers[team]! &= ~(1 << other);
    world.allies[team]! |= 1 << other;
    world.allies[other]! |= 1 << team;
    return true;
  }
  world.offers[team]! |= 1 << other;
  return false;
}

/** Break an alliance (or withdraw an offer). One-sided and immediate. */
export function breakAlliance(world: World, team: TeamId, other: TeamId): void {
  world.offers[team]! &= ~(1 << other);
  world.allies[team]! &= ~(1 << other);
  world.allies[other]! &= ~(1 << team);
}
