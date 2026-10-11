// Content is data. Races, buildings, units, waves and the damage table all
// load from JSON today and are shaped so they can later come from WordPress
// (chubes.net posts) at build time without touching the simulation.

export type AttackType = "brute" | "exploit" | "social";
export type ArmorType = "container" | "legacy" | "hardened" | "core";

export interface UnitDef {
  name: string;
  description: string;
  hp: number;
  armor: number;
  armorType: ArmorType;
  attackType: AttackType;
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
  /** How far this unit reveals the fog for its owner, in pixels. */
  sight?: number;
}

export interface BuildingAttack {
  attackType: AttackType;
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
  armor: number;
  armorType: ArmorType;
  /** Tiles per side. */
  footprint: number;
  buildable: boolean;
  /** How far this building reveals the fog for its owner, in pixels. */
  sight?: number;
  /** Spawns `count` units every interval, keeping at most `maxAlive` of its own alive. */
  spawn?: { unit: string; intervalTicks: number; count: number; maxAlive: number };
  attack?: BuildingAttack;
  income?: { amount: number; intervalTicks: number };
  /** Users this building can serve. Your total capacity caps your user count. */
  userCapacity?: number;
  /** Only buildable on a data well: every footprint tile must be one. */
  onWell?: boolean;
  /** Tiles around this building (once finished) where you may build. */
  buildRadius?: number;
}

export type Controller = "human" | "wave-director";

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
  buildings: string[];
  modifiers: {
    spawnIntervalMultiplier: number;
    costMultiplier: number;
    unitHpMultiplier: number;
    /** Extra compute at the start of the match. */
    startingComputeBonus: number;
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
  /** Compute per user per second. */
  revenuePerUserPerSecond: number;
  /** One user leaves for every this much damage your buildings take. */
  damagePerUserLost: number;
  /**
   * Traffic: how far away crawlers can sense a core, in pixels. Grows with
   * your buildings and users. A roaming pack that senses a core usually
   * heads for it (pullChance); otherwise it wanders as before.
   */
  traffic: { base: number; perBuilding: number; perUser: number; max: number; pullChance: number };
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

export type DamageTable = Record<AttackType, Record<ArmorType, number>>;

export interface Content {
  units: Record<string, UnitDef>;
  buildings: Record<string, BuildingDef>;
  races: Record<string, RaceDef>;
  waves: WavesDef;
  damage: DamageTable;
  economy: EconomyDef;
  upgrades: Record<string, UpgradeDef>;
}
