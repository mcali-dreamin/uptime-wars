// Content is data. Races, buildings, units, waves and the damage table all
// load from JSON today and are shaped so they can later come from WordPress
// (chubes.net posts) at build time without touching the simulation.

import unitsJson from "../content/units.json";
import buildingsJson from "../content/buildings.json";
import racesJson from "../content/races.json";
import wavesJson from "../content/waves.json";
import damageJson from "../content/damage.json";

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
  spawn?: { unit: string; intervalTicks: number; count: number };
  attack?: BuildingAttack;
  income?: { amount: number; intervalTicks: number };
}

export type Controller = "human" | "wave-director";

export interface RaceDef {
  name: string;
  specialty: string;
  controller: Controller;
  /** Unbuildable building this race starts with; losing it loses the match. */
  core: string;
  buildings: string[];
  modifiers: {
    spawnIntervalMultiplier: number;
    costMultiplier: number;
    unitHpMultiplier: number;
  };
}

export interface WaveDef {
  name: string;
  /** Ticks after the previous wave started. */
  delayTicks: number;
  groups: { unit: string; count: number }[];
}

export interface WavesDef {
  firstWaveTicks: number;
  spawnSpacingTicks: number;
  waves: WaveDef[];
}

export type DamageTable = Record<AttackType, Record<ArmorType, number>>;

export interface Content {
  units: Record<string, UnitDef>;
  buildings: Record<string, BuildingDef>;
  races: Record<string, RaceDef>;
  waves: WavesDef;
  damage: DamageTable;
}

export function loadDefaultContent(): Content {
  const content: Content = {
    units: unitsJson as Record<string, UnitDef>,
    buildings: buildingsJson as Record<string, BuildingDef>,
    races: racesJson as Record<string, RaceDef>,
    waves: wavesJson as WavesDef,
    damage: damageJson as DamageTable,
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
    for (const buildingId of race.buildings) {
      const building = content.buildings[buildingId];
      if (!building) errors.push(`race ${id} lists unknown building ${buildingId}`);
      else if (!building.buildable) errors.push(`race ${id} lists unbuildable ${buildingId}`);
    }
  }
  content.waves.waves.forEach((wave, index) => {
    for (const group of wave.groups) {
      if (!content.units[group.unit]) {
        errors.push(`wave ${index} (${wave.name}) uses unknown unit ${group.unit}`);
      }
    }
  });
  if (errors.length > 0) {
    throw new Error(`Invalid content:\n- ${errors.join("\n- ")}`);
  }
}
