// What the UI calls a player: "Player 2", or "Computer 2" for a computer
// player, so you can tell at a glance who's a person. Numbered by team, the
// same number as their start spot.

import type { Content, TeamId, World } from "../sim";

export function playerName(world: World, team: TeamId): string {
  return `${world.teams[team]?.ai ? "Computer" : "Player"} ${team + 1}`;
}

/** Several players, joined: "Player 2 & Computer 3". */
export function playerNames(world: World, teams: TeamId[]): string {
  return teams.map((team) => playerName(world, team)).join(" & ");
}

/** A computer's difficulty name ("Hard"), or null for a person. */
export function difficultyName(
  content: Content,
  world: World,
  team: TeamId,
): string | null {
  const ai = world.teams[team]?.ai;
  return ai ? (content.difficulties[ai.difficulty]?.name ?? null) : null;
}
