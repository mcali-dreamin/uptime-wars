// Balance runs (not part of the game, not run in CI): a computer player
// (src/sim/ai) plays a race alone against the horde, the same way on every
// race, so a gap between races is about the races, not the player.
//
//   npm run balance      (writes balance-results/*.json, then prints a table)
//
// BALANCE_DIFFICULTY picks its skill (default normal). It is the bot's skill,
// not the horde's strength.
// BALANCE_PRESSURE (permille, default 1000) scales the horde: waves.budget.start
// and waves.hpGrowthPerWave are multiplied by pressure/1000 (content is copied,
// never mutated). Use it to tell races apart when every run survives the cap.
//
// Stress metrics in every BotResult, tracked each tick on the team's main core
// (following team.coreId after a failover): minCorePermille (lowest hp*1000/maxHp),
// secondsBelowHalf (time under 50% HP) and buildingsLost (own buildings destroyed).
// pressure and minutes are stored too, for the report.

import { TICK_RATE, createWorld, step, tierOf, type Content, type World } from "../src/sim";

export interface BotOptions {
  minutes: number;
  /** Play the hero (learn and cast). Off = the hero only auto-fights. */
  hero: boolean;
  /** Aggressive AI: attacks Botnet Farms, expands, rents Spot (measures the late game). */
  aggressive: boolean;
  difficulty?: string;
  /** Horde pressure in permille (default 1000 = unchanged). */
  pressure?: number;
  /** Test hook: called before every step. */
  beforeStep?: (world: World) => void;
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
  /** Lowest core hp*1000/maxHp seen. */
  minCorePermille: number;
  /** Seconds the core spent under 50% HP. */
  secondsBelowHalf: number;
  /** The team's own buildings destroyed. */
  buildingsLost: number;
  pressure: number;
  minutes: number;
}

/** The content a balance run plays on: pressure scales the horde. Never mutates `content`. */
export function balanceContent(content: Content, options: Pick<BotOptions, "pressure">): Content {
  const pressure = options.pressure ?? 1000;
  if (pressure === 1000) return content;
  const k = pressure / 1000;
  const waves = content.waves;
  return {
    ...content,
    waves: {
      ...waves,
      budget: { ...waves.budget, start: Math.round(waves.budget.start * k) },
      hpGrowthPerWave: waves.hpGrowthPerWave * k,
    },
  };
}

export function playMatch(
  content: Content,
  race: string,
  seed: number,
  heroId: string,
  options: BotOptions,
): BotResult {
  const difficulty = options.difficulty ?? "normal";
  content = balanceContent(content, options);
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
  let minCorePermille = 1000;
  let belowHalfTicks = 0;
  let buildingsLost = 0;
  while (world.tick < limit && !world.outcome) {
    options.beforeStep?.(world);
    step(world, played);
    peakMoney = Math.max(peakMoney, team.money);
    const core = world.entities.find((c) => c.id === team.coreId);
    if (core && core.maxHp > 0) {
      const permille = Math.floor((core.hp * 1000) / core.maxHp);
      minCorePermille = Math.min(minCorePermille, permille);
      if (permille < 500) belowHalfTicks += 1;
    }
    for (const e of world.events) {
      if (e.type === "death" && e.kind === "building" && e.team === team.id) buildingsLost += 1;
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
    minCorePermille,
    secondsBelowHalf: belowHalfTicks / TICK_RATE,
    buildingsLost,
    pressure: options.pressure ?? 1000,
    minutes: options.minutes,
  };
}
