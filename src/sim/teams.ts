// Who's on whose side.
//
// - co-op: every human team plays together against the horde. Humans never
//   target each other, and the match ends for everyone at once.
// - ffa:   free-for-all. Every team fights every other; the horde (if there
//   is one) is just one more enemy. Last core standing wins.

import type { Team, TeamId, World } from "./types";

export type MatchMode = "coop" | "ffa";

/** Whether two teams fight. */
export function hostile(world: World, a: TeamId, b: TeamId): boolean {
  if (a === b) return false;
  if (world.mode === "ffa") return true;
  return world.teams[a]!.controller !== world.teams[b]!.controller;
}

/** The human teams, in team order. */
export function humanTeams(world: World): Team[] {
  return world.teams.filter((team) => team.controller === "human");
}

/** The team the wave director drives, if any. */
export function hordeTeam(world: World): Team | undefined {
  return world.teams.find((team) => team.controller === "wave-director");
}
