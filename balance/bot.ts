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
  /** Aggressive AI: attacks Botnet Farms, expands, rents Spot (measures the late game). */
  aggressive: boolean;
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
  /** Botnet Farms destroyed (rebuilt ones count again). */
  farmsBroken: number;
  /** Expansion cores founded. */
  expansions: number;
  /** Most $ held at once. */
  peakMoney: number;
  /** Spot Capacity rentals made. */
  spotRentals: number;
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
  // Overrides on the same difficulty: no hero play (the hero only auto-fights), aggressive play.
  const played =
    options.hero && !options.aggressive
      ? content
      : {
          ...content,
          difficulties: {
            ...content.difficulties,
            [difficulty]: {
              ...level,
              ...(options.hero ? {} : { playsHero: false }),
              ...(options.aggressive ? { aggressive: true } : {}),
            },
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
  const farm = content.waves.fortress.farms.building;
  let farmsBroken = 0;
  let expansions = 0;
  let peakMoney = team.money;
  while (world.tick < limit && !world.outcome) {
    step(world, played);
    peakMoney = Math.max(peakMoney, team.money);
    for (const e of world.events) {
      if (e.type === "expanded" && e.team === team.id) expansions += 1;
      else if (e.type === "death" && e.kind === "building" && e.defId === farm && e.team !== team.id) farmsBroken += 1;
    }
  }
  return {
    race,
    hero: heroId,
    seed,
    survived: (world.outcome?.tick ?? world.tick) / TICK_RATE,
    survivedAll: !world.outcome,
    tier: tierOf(content, team),
    casts: team.ai!.casts,
    heroLevel: team.hero?.level ?? 0,
    farmsBroken,
    expansions,
    peakMoney,
    spotRentals: team.spotRentals,
  };
}
