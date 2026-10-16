// Balance runs (not part of the game, not run in CI): a computer player
// (src/sim/ai) plays a race alone against the horde, the same way on every
// race, so a gap between races is about the races, not the player.
//
//   npm run balance      (writes balance-results/*.json, then prints a table)
//
// BALANCE_DIFFICULTY picks its skill (default normal).

import { TICK_RATE, createWorld, step, tierOf, type Content } from "../src/sim";

export interface BotOptions {
  minutes: number;
  /** Play the hero (learn and cast). Off = the hero only auto-fights. */
  hero: boolean;
  difficulty?: string;
}

export interface BotResult {
  race: string;
  hero: string;
  seed: number;
  /** Seconds the core stayed up (capped at the run length). */
  survived: number;
  survivedAll: boolean;
  tier: number;
  casts: number;
  heroLevel: number;
}

export function playMatch(
  content: Content,
  race: string,
  seed: number,
  heroId: string,
  options: BotOptions,
): BotResult {
  const difficulty = options.difficulty ?? "normal";
  const level = content.difficulties[difficulty]!;
  // No hero play: the same player with its hero left to auto-fight.
  const played = options.hero
    ? content
    : {
        ...content,
        difficulties: {
          ...content.difficulties,
          [difficulty]: { ...level, playsHero: false },
        },
      };
  const world = createWorld(played, {
    seed,
    races: [race, "botnet"],
    heroes: [heroId],
    startWithCore: true,
    ai: [difficulty],
  });
  const team = world.teams[0]!;
  const limit = TICK_RATE * 60 * options.minutes;
  while (world.tick < limit && !world.outcome) step(world, played);
  return {
    race,
    hero: heroId,
    seed,
    survived: (world.outcome?.tick ?? world.tick) / TICK_RATE,
    survivedAll: !world.outcome,
    tier: tierOf(content, team),
    casts: team.ai!.casts,
    heroLevel: team.hero?.level ?? 0,
  };
}
