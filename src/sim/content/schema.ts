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
  /** How far this unit reveals the fog for its owner, in pixels. */
  sight?: number;
}

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
  /** Users this building can serve. Your total capacity caps your user count. */
  userCapacity?: number;
  /** Only buildable on a data well: every footprint tile must be one. */
  onWell?: boolean;
  /** Tiles around this building (once finished) where you may build. */
  buildRadius?: number;
}

export type Controller = "human" | "wave-director";

export type RaceLook = "scrappy" | "monolith" | "ephemeral";
export const RACE_LOOKS: readonly RaceLook[] = ["scrappy", "monolith", "ephemeral"];

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
  modifiers: {
    spawnIntervalMultiplier: number;
    costMultiplier: number;
    unitHpMultiplier: number;
    /** Extra $ at the start of the match. */
    startingMoneyBonus: number;
  };
}

/**
 * Endless waves, generated rather than listed. Wave n gets a point budget
 * that grows every wave and spends it on whatever the roster has unlocked by
 * then; bosses join on a cadence; every creep gets tougher as waves go on.
 */
export interface WavesDef {
  /** First wave comes this long after your core goes online... */
  firstWaveTicks: number;
  /** ...or this long after the match starts, whichever is sooner. */
  graceTicks: number;
  spawnSpacingTicks: number;
  /** Each wave is shuffled and cut into packs of this many units. */
  packSize: { min: number; max: number };
  /** Gap between waves: starts at startTicks, shrinks each wave, never below minTicks. */
  interval: { startTicks: number; minTicks: number; shrinkPerWave: number };
  /** Points to spend on wave n: start * growth^(n-1). */
  budget: { start: number; growth: number };
  /** Creep HP multiplier grows by this much per wave. */
  hpGrowthPerWave: number;
  /** Never let more than this many creeps be alive; overflow waits its turn. */
  maxAlive: number;
  roster: { unit: string; cost: number; fromWave: number; weight: number }[];
  /** One more boss every `every` waves from `fromWave` on. */
  bosses: { unit: string; fromWave: number; every: number };
  /**
   * The nest's fortress: `building` guards its gateways. Every `rebuildEvery`
   * waves the ones you knocked down come back, with hp grown by
   * `hpGrowthPerWave` per wave.
   */
  fortress: { building: string; rebuildEvery: number; hpGrowthPerWave: number };
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
}

export type UpgradeStat = "unitHp" | "unitDamage" | "towerRange" | "spawnSpeed" | "userCapacity" | "revenue";

/**
 * Researched at the core, one at a time. Level n costs cost * n and takes
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
  effect: "blast" | "decoy" | "heal" | "strike" | "summon" | "buff";
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
