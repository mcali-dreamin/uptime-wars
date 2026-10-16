// Content is data. Races, buildings, units, waves and the rest all
// load from JSON today and are shaped so they can later come from WordPress
// (chubes.net posts) at build time without touching the simulation.

export interface UnitDef {
  name: string;
  description: string;
  hp: number;
  /** Flat reduction to every hit taken. */
  armor: number;
  damage: number;
  /** Pixels, measured edge to edge. */
  range: number;
  cooldownTicks: number;
  /** Pixels per tick. */
  speed: number;
  /** Pixels. How far this unit looks for something to fight. */
  aggro: number;
  /** Compute paid to whoever kills it. */
  bounty: number;
  /** Radius in pixels. */
  size: number;
  /** Compute this unit uses while alive (default: economy.compute.perUnit). */
  upkeep?: number;
  /** A creep's job beyond hitting things (see CreepRole). */
  role?: CreepRole;
  /** How far this unit reveals the fog for its owner, in pixels. */
  sight?: number;
  /** Mends allied units and buildings within `radius` px by `perSecond` hp each second (itself included). */
  heal?: { perSecond: number; radius: number };
  /** Multiplies its damage against buildings. */
  siege?: number;
  /** Enemy units it hits act at half speed for this many ticks. */
  slowTicks?: number;
}

/**
 * What a creep does besides hit things:
 * - scanner: spots your buildings and, if it lives `reportTicks` after
 *   spotting them, sends every horde pack within `reportRadius` marching on
 *   them. It doesn't attack.
 * - phisher: only goes for buildings that serve users (and cores), ignores
 *   everything else, and drives users away `churnMultiplier` times as fast.
 * - miner: each hit on a building also drains `drain` $ from its owner.
 * - jammer: each hit on a building jams it for `jamTicks`: towers don't
 *   shoot, spawners don't spawn, functions don't run.
 * - siege: goes for buildings, and hits them `buildingMultiplier` times as hard.
 */
export type CreepRole =
  | { kind: "scanner"; reportTicks: number; reportRadius: number }
  | { kind: "phisher"; churnMultiplier: number }
  | { kind: "miner"; drain: number }
  | { kind: "jammer"; jamTicks: number }
  | { kind: "siege"; buildingMultiplier: number };

export interface BuildingAttack {
  damage: number;
  range: number;
  cooldownTicks: number;
}

export interface BuildingDef {
  name: string;
  description: string;
  cost: number;
  buildTicks: number;
  hp: number;
  /** Flat reduction to every hit taken. */
  armor: number;
  /** Tiles per side. */
  footprint: number;
  buildable: boolean;
  /** How far this building reveals the fog for its owner, in pixels. */
  sight?: number;
  /** Spawns `count` units every interval, keeping at most `maxAlive` of its own alive. */
  spawn?: { unit: string; intervalTicks: number; count: number; maxAlive: number };
  attack?: BuildingAttack;
  /** $ paid out on a timer. */
  income?: { amount: number; intervalTicks: number };
  /**
   * Serverless: no standing army. Each invocation costs `cost` $ and
   * spins up `count` units that live `ttlTicks`, then go cold. Fires on its own
   * when an enemy comes within `triggerRange` (an event), or when you invoke
   * it; then not again for `cooldownTicks`.
   */
  invoke?: { unit: string; count: number; cost: number; ttlTicks: number; cooldownTicks: number; triggerRange: number };
  /** Compute this building supplies once finished: what keeps users and units running. */
  compute?: number;
  /** Blocks movement for everyone, like terrain (walls). Not line of sight: you can shoot over it. */
  blocks?: boolean;
  /** A blocking building its owner's units (and allies') pass through: a gate. */
  gate?: boolean;
  /** Users this building can serve. Your total capacity caps your user count. */
  userCapacity?: number;
  /** Each one you already own makes the next cost this much more, permille (default economy.costGrowthPermille). */
  costGrowthPermille?: number;
  /** Needs this core tier (index into economy.tiers; 0 = from the start). */
  tier?: number;
  /** At most this many per player, by core tier (counting ones under construction). */
  limitPerTier?: number[];
  /**
   * At the top core tier the limit turns soft: you may build past it, and
   * each one past it costs this much more again (permille of the base cost),
   * on top of costGrowthPermille. So late $ can still buy compute.
   */
  pastLimitGrowthPermille?: number;
  /** Tiles around this building (once finished) where you may build. */
  buildRadius?: number;
}

export type Controller = "human" | "wave-director";

export type RaceLook = "scrappy" | "monolith" | "ephemeral" | "garden";
export const RACE_LOOKS: readonly RaceLook[] = ["scrappy", "monolith", "ephemeral", "garden"];

/**
 * One spawner rank. Units it spawns from then on get these (permille of the
 * plain unit; armor is flat). The standing squad (maxAlive) and a function's
 * burst change by `maxAlive` / `burst` (never below 1).
 */
/** What a rank does to a unit: permille of the plain unit's hp and damage, flat armor. */
export interface UnitRank {
  name: string;
  hpPermille: number;
  damagePermille: number;
  armor: number;
  /** Bounty and hero XP multiplier when it's killed (default 1). */
  worth?: number;
}

export interface SpawnerRank extends UnitRank {
  /** Core tier it needs. */
  tier: number;
  /** Price, permille of the building's base cost. */
  costPermille: number;
  /** Refit time; the building doesn't spawn or run meanwhile. */
  ticks: number;
  hpPermille: number;
  damagePermille: number;
  armor: number;
  upkeepPermille: number;
  maxAlive?: number;
  burst?: number;
}

/** What a tier perk changes; its text is generated from these (see ui/text.ts). */
export interface TierPerk {
  name: string;
  mechanics?: { [K in keyof NonNullable<RaceDef["mechanics"]>]?: Partial<NonNullable<NonNullable<RaceDef["mechanics"]>[K]>> };
  modifiers?: Partial<RaceDef["modifiers"]>;
}

export interface RaceDef {
  name: string;
  specialty: string;
  controller: Controller;
  /** Unbuildable building this race depends on; losing it loses the match. */
  core: string;
  /**
   * Unit the race starts with instead of a core. It walks the map and founds
   * the core wherever the player chooses. Races without one start with their
   * core in place.
   */
  builder?: string;
  /**
   * How the race's hardware looks, whatever it builds (render-only): "scrappy"
   * is cobbled-together copper and mismatched panels, "monolith" is glass,
   * chrome, and clean white light; "ephemeral" is wireframe that only turns
   * solid while it's running. Every playable race needs one.
   */
  look?: RaceLook;
  /** Hero units this race can field (see HeroesDef); the player picks one. */
  heroes?: string[];
  buildings: string[];
  /**
   * What makes the race play differently, beyond its numbers. All optional.
   * - fork: copy one of your finished buildings (not the core) for a share
   *   of its price and build time (permille).
   * - repair: your buildings mend themselves, `permillePerSecond` of max hp,
   *   once they haven't been hit for `quietTicks`.
   * - region: a building takes `perNeighborPermille` less damage for each
   *   other finished building of yours within `radiusTiles`, up to `maxPermille`.
   */
  mechanics?: {
    fork?: { costPermille: number; buildPermille: number };
    repair?: { permillePerSecond: number; quietTicks: number };
    region?: { radiusTiles: number; perNeighborPermille: number; maxPermille: number };
    /** Users leave at this share of the usual rate when your buildings are hit (permille). */
    loyalty?: { churnPermille: number };
    /** Melee attackers hitting one of `buildings` take `damage` back per blow. */
    thorns?: { damage: number; buildings: string[] };
  };
  /**
   * Fixed perks per core tier (index = tier; 0 is unused). Each overrides
   * parts of `mechanics` (field by field within a mechanic) and `modifiers`
   * from that tier on, on top of the tiers below it.
   */
  tierPerks?: (TierPerk | null)[];
  /** The race's upgrade center: the building that researches its army upgrades and traits. */
  center?: string;
  /**
   * Ranks any of its spawners (and functions) can be upgraded to, in order:
   * fewer, stronger units for more compute each. See ranks.ts.
   */
  spawnerRanks?: SpawnerRank[];
  modifiers: {
    spawnIntervalMultiplier: number;
    costMultiplier: number;
    unitHpMultiplier: number;
    /** Extra $ at the start of the match. */
    startingMoneyBonus: number;
    /** Extra tiles of reach on every core (default 0). Tier perks can change it. */
    buildRadiusBonus?: number;
    /** Function (invoke) cooldowns and run costs scale by these (default 1). */
    invokeCooldownMultiplier?: number;
    invokeCostMultiplier?: number;
  };
}

/**
 * The horde's pressure has two parts.
 *
 * - Background traffic (`trickle`): a small pack leaves the nest every
 *   `everyTicks`, spending `start + perMinute * minutes` points (minutes since
 *   it began). Always something out there.
 * - Incidents (the numbered, named "waves"): big surges on a timer. Incident n
 *   gets a point budget that grows every incident and spends it on whatever
 *   the roster has unlocked by then; bosses only come with incidents; every
 *   creep gets tougher as incidents go on.
 *
 * Both scale with the players still online, x(1 + k * (n - 1)): the trickle
 * strongly (it spreads out over everyone), incidents gently (each one lands
 * on whichever base it finds first).
 * "Wave" in the fields below means incident.
 */
export interface WavesDef {
  /** Background traffic starts this long after your core goes online... */
  firstWaveTicks: number;
  /** ...the first incident this long after it... */
  firstIncidentTicks: number;
  /**
   * The botnet notices a big base: incidents scale by sqrt(worth / referenceWorth),
   * at least 1 and at most maxScale, where worth is what the players online
   * have built (at base price) plus the $ they're sitting on, averaged.
   */
  threat?: { referenceWorth: number; maxScale: number };
  /**
   * The first incident is the opening fight: a small one (`budget` points)
   * that comes out of the fog `entryDistance` px from each player's core,
   * toward the nest, and marches straight in. So the countdown means something.
   */
  opening?: { budget: number; entryDistance: number };
  /** ...or each this long after the match starts (plus the gap between the two), whichever is sooner. */
  graceTicks: number;
  trickle: { everyTicks: number; start: number; perMinute: number; maxPack: number };
  players: { trickle: number; incident: number };
  spawnSpacingTicks: number;
  /** Each wave is shuffled and cut into packs of this many units. */
  packSize: { min: number; max: number };
  /** Gap between waves: starts at startTicks, shrinks each wave, never below minTicks. */
  interval: { startTicks: number; minTicks: number; shrinkPerWave: number };
  /**
   * Points to spend on wave n: start * growth^(n-1), and from wave `lateFrom`
   * on each wave grows by `lateGrowth` instead (late waves come ranked rather
   * than bigger: see `ranks`).
   */
  budget: { start: number; growth: number; lateFrom?: number; lateGrowth?: number };
  /** Creep HP multiplier grows by this much per wave. */
  hpGrowthPerWave: number;
  /** Never let more than this much creep worth be alive (a plain creep is 1, a ranked one its rank's worth); overflow waits its turn. */
  maxAlive: number;
  /**
   * Late incidents get tougher, not bigger. A wave rolled with more than
   * `maxUnits` creeps keeps one in 2^r of them at rank r (the smallest r that
   * fits, up to the last level); each level should be worth twice the one
   * before, so the wave's strength is unchanged. Past the last level the
   * excess is dropped.
   */
  ranks?: { maxUnits: number; levels: UnitRank[] };
  roster: { unit: string; cost: number; fromWave: number; weight: number }[];
  /** One more boss every `every` waves from `fromWave` on. */
  bosses: { unit: string; fromWave: number; every: number };
  /**
   * The nest's fortress: `building` guards its gateways. Every `rebuildEvery`
   * waves the ones you knocked down come back, with hp grown by
   * `hpGrowthPerWave` per wave.
   */
  /**
   * The botnet spreads. From incident `fromWave`, every `everyWaves` incidents,
   * the nest sends `infectors` (with `escort` creeps) out to a site on the map,
   * where each builds a `building` (an infected node). Finished nodes are new
   * sources: `sharePermille` of incident packs come out of them instead of the
   * nest. At most `max` nodes; sites are at least `minFromStart` tiles from
   * every start.
   */
  spread: {
    unit: string;
    building: string;
    fromWave: number;
    everyWaves: number;
    infectors: number;
    escort: number;
    max: number;
    minFromStart: number;
    sharePermille: number;
  };
  fortress: {
    building: string;
    rebuildEvery: number;
    hpGrowthPerWave: number;
    /**
     * Botnet Farms: the fortress's barracks. They garrison it, and each one
     * destroyed sends a retaliation wave of `retaliationPermille` of the
     * current wave at whoever destroyed it, then shrinks every later wave's
     * budget by `weakenPermille`. Fallen farms come back every `rebuildEvery`
     * waves.
     */
    farms: { building: string; rebuildEvery: number; retaliationPermille: number; weakenPermille: number };
  };
  names: string[];
}

/**
 * Users: why you're online. They arrive while your core is up, grow toward
 * your capacity, pay revenue every second, and leave when your buildings
 * take damage.
 */
export interface EconomyDef {
  startingUsers: number;
  /** Each second, this fraction of the gap to capacity arrives... */
  growthPerSecond: number;
  /** ...but at least this many, while there's room. */
  minArrivalsPerSecond: number;
  /** $ per user per second. */
  revenuePerUserPerSecond: number;
  /** Each building of a kind you own makes the next one cost this much more, permille. */
  costGrowthPermille: number;
  /**
   * Compute is capacity, not money: buildings supply it, users and units use
   * it. Over capacity, the overload (the share of demand you can't serve)
   * scales the trouble: no new users, `churnPerSecond` x overload of them
   * leave each second, and your timers (attacks, spawns, research) slow by
   * the overload.
   */
  compute: { perUser: number; perUnit: number; churnPerSecond: number; maxOverload: number };
  /** One user leaves for every this much damage your buildings take. */
  damagePerUserLost: number;
  /**
   * Traffic: how far away crawlers can sense a core, in pixels. Grows with
   * your buildings and users. A roaming pack that senses a core usually
   * heads for it (pullChance); otherwise it wanders as before.
   */
  /**
   * How far crawlers sense a base, in px: base + perBuilding·buildings +
   * perUser·users + perMinute·minutes of uptime, capped at max.
   */
  traffic: { base: number; perBuilding: number; perUser: number; perMinute: number; max: number; pullChance: number };
  /**
   * Core tech tiers, researched at the core (the "tier" upgrade; its level is
   * the tier). Each tier adds `compute` to your supply, `buildRadius` tiles to
   * every core's reach, multiplies core hp by `coreHp`, and adds `traffic` px
   * to how far crawlers sense you. Buildings gate on it with `tier` and
   * `limitPerTier`.
   */
  tiers: { name: string; compute: number; buildRadius: number; coreHp: number; traffic: number }[];
}

/**
 * "tier" is the core's tech tier (see EconomyDef.tiers): no multiplier, its level is the tier.
 * "buildingArmor" / "unitArmor" add perLevel flat armor per level.
 * "trait" unlocks a unit trait (see TraitDef) for `unit`.
 */
export type UpgradeStat =
  | "unitHp"
  | "unitDamage"
  | "unitArmor"
  | "towerRange"
  | "towerDamage"
  | "buildingHp"
  | "buildingArmor"
  | "spawnSpeed"
  | "userCapacity"
  | "revenue"
  | "tier"
  | "trait"
  | "buildRadius";

/**
 * A unit trait, unlocked by a "trait" upgrade. All optional; they stack.
 * - speed / range: multipliers.
 * - crit: every `every`-th hit does `mult` damage.
 * - splash / chain: each hit also deals `share` of its damage to every
 *   enemy (splash) or the nearest other enemy (chain) within `radius` of the target.
 * - taunt: once a second, creeps within `radius` switch to attacking it.
 * - split: on death it splits into `count` of itself at `hpShare` hp (once).
 * - healMult: multiplies its heal.
 * - revive: the first ally that falls in its heal radius comes back at
 *   `hpShare` hp; then it waits `cooldownTicks`.
 * - squad: its function / spawner keeps (and bursts) this many more.
 * - burstMult: its function bursts this many times as many.
 * - disarmTicks / stunTicks: an enemy unit it hits can't attack / can't act.
 * - holdArmor: extra armor while it holds its post (home, no order).
 */
export interface TraitDef {
  speed?: number;
  range?: number;
  crit?: { every: number; mult: number };
  splash?: { share: number; radius: number };
  chain?: { share: number; radius: number };
  taunt?: { radius: number };
  split?: { count: number; hpShare: number };
  healMult?: number;
  revive?: { cooldownTicks: number; hpShare: number };
  squad?: number;
  burstMult?: number;
  disarmTicks?: number;
  stunTicks?: number;
  holdArmor?: number;
}

/**
 * Researched at the core (the race and its base) or at the race's upgrade
 * center (its army), one at a time at each. Level n costs cost * n and takes
 * researchTicks * n; each level adds perLevel to the stat's multiplier.
 */
export interface UpgradeDef {
  name: string;
  description: string;
  stat: UpgradeStat;
  perLevel: number;
  maxLevel: number;
  cost: number;
  researchTicks: number;
  /** Where it's researched (default "core"). */
  at?: "core" | "center";
  /** Only these races can research it (default: every race). */
  races?: string[];
  /** Core tier needed for each level (index = level - 1). */
  tiers?: number[];
  /** What each race calls it (same effect). */
  names?: Record<string, string>;
  /** "trait" upgrades: the unit it changes, and how. */
  unit?: string;
  trait?: TraitDef;
}

/**
 * - blast:  damage every enemy within `radius` of a point.
 * - decoy:  drop a `unit` at a point for `durationTicks`; creeps within
 *           `radius` of it attack it instead (`amount` = its hp).
 * - heal:   heal your own units and finished buildings within `radius` of the hero.
 * - strike: damage one enemy.
 * - summon: `amount` of `unit` fight beside the hero for `durationTicks`.
 * - buff:   every unit of yours hits `amount` (a fraction) harder for `durationTicks`.
 * Abilities are learned with skill points, one per hero level. Rank r needs
 * hero level unlockLevel + levelsPerRank * (r - 1); `amount` grows by
 * `perRank` for each rank past 1. Ultimates: unlockLevel 6, maxRank 1.
 */
export interface AbilityDef {
  name: string;
  description: string;
  /**
   * Fighting: blast, strike, heal, decoy, summon, buff. Race tools:
   * - shield:   your buildings within `radius` take `amount` permille less damage for `durationTicks`
   * - build:    finish construction and mend your buildings within `radius` by `amount`
   * - trigger:  run every function within `radius` now, free, ignoring cooldowns
   * - discount: function runs cost nothing for `durationTicks`
   * - funds:    +`amount` $
   * - stun:     enemy units within `radius` can't act for `durationTicks`
   * - users:    up to `amount` users arrive now (up to capacity)
   */
  effect: "blast" | "decoy" | "heal" | "strike" | "summon" | "buff" | "shield" | "build" | "trigger" | "discount" | "funds" | "stun" | "users";
  target: "point" | "enemy" | "self";
  unlockLevel: number;
  maxRank: number;
  cooldownTicks: number;
  /** How far from the hero it can be cast, in pixels. 0 for self. */
  range: number;
  radius?: number;
  amount: number;
  perRank: number;
  durationTicks?: number;
  unit?: string;
}

export interface HeroDef {
  hpPerLevel: number;
  damagePerLevel: number;
  /** Dead heroes come back at the core after respawnTicks + respawnPerLevel * (level - 1). */
  respawnTicks: number;
  respawnPerLevel: number;
  /** In hotkey order (1-4). */
  abilities: string[];
}

/**
 * Heroes: one controllable unit per player that levels up. Every kill near
 * a hero (within xpRange) gives it the creep's bounty * xpPerBounty in XP;
 * reaching level n takes xpPerLevel * n * (n - 1) / 2 XP in total.
 */
export interface HeroesDef {
  xpRange: number;
  xpPerBounty: number;
  xpPerLevel: number;
  maxLevel: number;
  skillPointsPerLevel: number;
  /** Levels between ranks of the same ability. */
  levelsPerRank: number;
  /**
   * Back at base: a hero within `radius` px of one of its team's cores heals
   * `permillePerSecond` of its max hp each second, once nothing has hit it
   * for `quietTicks`.
   */
  coreHeal?: { radius: number; permillePerSecond: number; quietTicks: number };
  /** Keyed by the hero's unit id. */
  heroes: Record<string, HeroDef>;
  abilities: Record<string, AbilityDef>;
}

export interface Content {
  units: Record<string, UnitDef>;
  buildings: Record<string, BuildingDef>;
  races: Record<string, RaceDef>;
  waves: WavesDef;
  economy: EconomyDef;
  upgrades: Record<string, UpgradeDef>;
  heroes: HeroesDef;
}
