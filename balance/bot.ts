// A scripted player for balance runs (not part of the game, not run in CI).
//
// It plays every race with the same sensible basics, plus one habit each
// race needs, and plays its hero: learns abilities as they unlock and casts
// them when they'd help. It is not a good player; it is a *consistent* one,
// so a gap between races is about the races, not the bot.
//
//   npm run balance      (writes balance-results/*.json, then prints a table)

import {
  TICK_RATE,
  canPlace,
  canResearch,
  createWorld,
  hostile,
  queueCommand,
  step,
  tierOf,
  tierUpgrade,
  userCapacity,
  rankBlocker,
  type Building,
  type Command,
  type Content,
  type Entity,
  type Team,
  type Unit,
  type World,
} from "../src/sim";
import { castBlocker, learnBlocker } from "../src/sim/heroes";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Order = DistributiveOmit<Command, "tick" | "team">;

export interface BotOptions {
  minutes: number;
  /** Play the hero (learn and cast). Off = the hero only auto-fights. */
  hero: boolean;
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

const DECIDE_EVERY = 20;
/** Buildings the bot never builds on its own: walls and network need a plan it doesn't have. */
const SKIP = new Set(["core", "mesh-node", "edge-pop", "garden-wall"]);

export function playMatch(content: Content, race: string, seed: number, heroId: string, options: BotOptions): BotResult {
  const world = createWorld(content, { seed, races: [race, "botnet"], heroes: [heroId], startWithCore: true });
  const team = world.teams[0]!;
  const tier = tierUpgrade(content)!;
  const rotation = content.races[race]!.buildings.filter((b) => !SKIP.has(b));
  let next = 0;
  let casts = 0;
  const limit = TICK_RATE * 60 * options.minutes;
  const issue = (command: Order) =>
    queueCommand(world, { ...command, tick: world.tick, team: 0 } as Command);

  while (world.tick < limit && !world.outcome) {
    step(world, content);
    if (world.tick % DECIDE_EVERY !== 0) continue;
    if (options.hero) casts += playHero(world, content, team, issue);
    if (world.tick % (DECIDE_EVERY * 2) !== 0) continue;

    // Grow the core whenever it's affordable with a little to spare; research the rest once rich.
    const nextTier = 400 * (tierOf(content, team) + 1);
    if (canResearch(content, team, tier) === null && team.money >= nextTier + 60) {
      issue({ type: "research", upgrade: tier });
      continue;
    }
    if (!team.research && team.money > 900) {
      const upgrade = Object.keys(content.upgrades).find((u) => u !== tier && canResearch(content, team, u) === null);
      if (upgrade) issue({ type: "research", upgrade });
    }
    // Saving for the next tier: don't spend below what it costs.
    const saving = canResearch(content, team, tier) === "not enough $" ? nextTier : 0;
    // Once comfortable, rank a spawner up: at the compute cap better units beat more of them.
    if (!saving && team.money > 700) {
      const rankable = world.entities.find((e): e is Building => e.kind === "building" && rankBlocker(content, world, 0, e as Building) === null);
      if (rankable) {
        issue({ type: "rank", buildingId: rankable.id });
        continue;
      }
    }

    const core = world.entities.find((e) => e.id === team.coreId) as { col: number; row: number } | undefined;
    if (!core) continue;
    for (let tries = 0; tries < rotation.length; tries += 1) {
      const b = rotation[(next + tries) % rotation.length]!;
      if (!habitAllows(world, content, team, b)) continue;
      if (saving && team.money - content.buildings[b]!.cost < saving * 0.5) break;
      const spot = findSpot(world, content, b, core);
      if (spot) {
        issue({ type: "build", building: b, col: spot.col, row: spot.row });
        next = (next + tries + 1) % rotation.length;
        break;
      }
      if (canPlace(world, content, 0, b, core.col + 3, core.row) === "not enough $") break;
    }
  }
  const survived = (world.outcome?.tick ?? world.tick) / TICK_RATE;
  return {
    race,
    hero: heroId,
    seed,
    survived,
    survivedAll: !world.outcome,
    tier: tierOf(content, team),
    casts,
    heroLevel: team.hero?.level ?? 0,
  };
}

/**
 * The one habit per race the naive bot lacked. Serverless: functions bill
 * per run, so don't sprawl them before the core can afford a tier (2 per
 * tier, plus 2).
 */
function habitAllows(world: World, content: Content, team: Team, building: string): boolean {
  const def = content.buildings[building]!;
  if (def.invoke) {
    const have = world.entities.filter((e) => e.kind === "building" && e.team === team.id && content.buildings[e.defId]!.invoke && e.hp > 0).length;
    return have < 2 + 2 * tierOf(content, team);
  }
  return true;
}

function findSpot(world: World, content: Content, building: string, core: { col: number; row: number }) {
  for (let d = 2; d <= 10; d += 1) {
    for (const [dc, dr] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d], [d, 1], [-d, 1], [1, d], [1, -d]] as const) {
      if (canPlace(world, content, 0, building, core.col + dc, core.row + dr) === null) return { col: core.col + dc, row: core.row + dr };
    }
  }
  return null;
}

/** Learn what's learnable (ultimates first), cast what would help. Returns casts made. */
function playHero(world: World, content: Content, team: Team, issue: (c: Order) => unknown): number {
  const state = team.hero;
  const heroDef = team.heroId ? content.heroes.heroes[team.heroId] : undefined;
  if (!state || !heroDef) return 0;
  const owned = [...heroDef.abilities].sort((a, b) => content.heroes.abilities[b]!.unlockLevel - content.heroes.abilities[a]!.unlockLevel);
  for (const id of owned) if (learnBlocker(content, team, id) === null) return issue({ type: "learn", ability: id }), 0;
  if (state.cast) return 0;
  const hero = world.entities.find((e) => e.id === state.unitId) as Unit | undefined;
  if (!hero || hero.hp <= 0) return 0;

  const enemies = world.entities.filter((e) => e.hp > 0 && e.kind === "unit" && hostile(world, e.team, team.id) && e.mode !== "decoy");
  const near = (p: Entity | { x: number; y: number }, r: number) => enemies.filter((e) => Math.hypot(e.x - p.x, e.y - p.y) <= r);
  const nearest = (r: number) => near(hero, r).sort((a, b) => Math.hypot(a.x - hero.x, a.y - hero.y) - Math.hypot(b.x - hero.x, b.y - hero.y))[0];
  const own = world.entities.filter((e) => e.team === team.id && e.hp > 0);

  for (const id of owned) {
    if (castBlocker(world, content, team, id) !== null) continue;
    const a = content.heroes.abilities[id]!;
    const r = a.radius ?? 200;
    let cast: { x: number; y: number; targetId: number | null } | null = null;
    switch (a.effect) {
      case "strike": {
        const t = nearest(a.range + 60);
        if (t) cast = { x: t.x, y: t.y, targetId: t.id };
        break;
      }
      case "blast":
      case "stun": {
        if (a.target === "self") {
          if (near(hero, r).length >= 2) cast = { x: hero.x, y: hero.y, targetId: null };
        } else {
          const t = nearest(a.range);
          if (t && near(t, r).length >= 2) cast = { x: t.x, y: t.y, targetId: null };
        }
        break;
      }
      case "heal":
        if (hero.hp < hero.maxHp * 0.7 || own.some((e) => e.hp < e.maxHp * 0.7 && Math.hypot(e.x - hero.x, e.y - hero.y) <= r)) cast = { x: hero.x, y: hero.y, targetId: null };
        break;
      case "decoy": {
        const t = nearest(300);
        if (t) cast = { x: t.x, y: t.y, targetId: null };
        break;
      }
      case "summon":
      case "buff":
      case "shield":
      case "trigger":
      case "discount":
        if (near(hero, 500).length >= 3) cast = { x: hero.x, y: hero.y, targetId: null };
        break;
      case "build":
        if (own.some((e) => e.kind === "building" && (e.buildRemaining > 0 || e.hp < e.maxHp * 0.6) && Math.hypot(e.x - hero.x, e.y - hero.y) <= r)) cast = { x: hero.x, y: hero.y, targetId: null };
        break;
      case "funds":
        cast = { x: hero.x, y: hero.y, targetId: null };
        break;
      case "users":
        if (team.users < userCapacity(world, content, team)) cast = { x: hero.x, y: hero.y, targetId: null };
        break;
    }
    if (cast) {
      issue({ type: "cast", ability: id, ...cast });
      return 1;
    }
  }
  return 0;
}
