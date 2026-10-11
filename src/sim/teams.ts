// Who's on whose side. Every human team plays together against the horde
// (co-op): humans never target each other, and the match ends for everyone
// at once.

import type { Team, TeamId, World } from "./types";

/** Whether two teams fight. Teams with the same controller are allies. */
export function hostile(world: World, a: TeamId, b: TeamId): boolean {
  return a !== b && world.teams[a]!.controller !== world.teams[b]!.controller;
}

/** The human teams, in team order. */
export function humanTeams(world: World): Team[] {
  return world.teams.filter((team) => team.controller === "human");
}

/** The team the wave director drives, if any. */
export function hordeTeam(world: World): Team | undefined {
  return world.teams.find((team) => team.controller === "wave-director");
}
