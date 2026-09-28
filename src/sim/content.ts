// Content is data. Races, buildings, units, waves and the damage table all
// load from JSON today and are shaped so they can later come from WordPress
// (chubes.net posts) at build time without touching the simulation.

import unitsJson from "../content/units.json";
import buildingsJson from "../content/buildings.json";
import racesJson from "../content/races.json";
import wavesJson from "../content/waves.json";
import damageJson from "../content/damage.json";
import economyJson from "../content/economy.json";

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
}

export type DamageTable = Record<AttackType, Record<ArmorType, number>>;

export interface Content {
  units: Record<string, UnitDef>;
  buildings: Record<string, BuildingDef>;
  races: Record<string, RaceDef>;
  waves: WavesDef;
  damage: DamageTable;
  economy: EconomyDef;
}

export function loadDefaultContent(): Content {
  const content: Content = {
    units: unitsJson as Record<string, UnitDef>,
    buildings: buildingsJson as Record<string, BuildingDef>,
    races: racesJson as Record<string, RaceDef>,
    waves: wavesJson as WavesDef,
    damage: damageJson as DamageTable,
    economy: economyJson as EconomyDef,
  };
  validateContent(content);
  return content;
}

/** Fail loudly on broken references so bad content never reaches a match. */
export function validateContent(content: Content): void {
  const errors: string[] = [];

  for (const [id, building] of Object.entries(content.buildings)) {
    if (building.spawn && !content.units[building.spawn.unit]) {
      errors.push(`building ${id} spawns unknown unit ${building.spawn.unit}`);
    }
  }
  for (const [id, race] of Object.entries(content.races)) {
    const core = content.buildings[race.core];
    if (!core) errors.push(`race ${id} has unknown core ${race.core}`);
    else if (core.buildable) errors.push(`race ${id} core ${race.core} must not be buildable`);
    else if (core.footprint !== 2) errors.push(`race ${id} core ${race.core} must have a 2x2 footprint`);
    if (race.builder && !content.units[race.builder]) errors.push(`race ${id} has unknown builder ${race.builder}`);
    for (const buildingId of race.buildings) {
      const building = content.buildings[buildingId];
      if (!building) errors.push(`race ${id} lists unknown building ${buildingId}`);
      else if (!building.buildable) errors.push(`race ${id} lists unbuildable ${buildingId}`);
    }
  }
  for (const entry of content.waves.roster) {
    if (!content.units[entry.unit]) errors.push(`wave roster uses unknown unit ${entry.unit}`);
    if (entry.cost <= 0) errors.push(`wave roster unit ${entry.unit} must cost more than 0`);
  }
  if (!content.units[content.waves.bosses.unit]) errors.push(`wave boss is unknown unit ${content.waves.bosses.unit}`);
  if (!content.waves.roster.some((entry) => entry.fromWave <= 1)) errors.push("wave roster needs a unit from wave 1");
  if (errors.length > 0) {
    throw new Error(`Invalid content:\n- ${errors.join("\n- ")}`);
  }
}
