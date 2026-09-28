// Text about buildings, units, and terrain, derived from content so it never
// drifts from the numbers the simulation actually uses.
//
// Two sizes: a compact card for the on-screen panel (a name and a line or
// two of numbers) and full detail for the Guide.

import { TICK_RATE, type Content } from "../sim";

export interface InfoCard {
  title: string;
  lines: string[];
}

const seconds = (ticks: number) => `${+(ticks / TICK_RATE).toFixed(1)}s`;

/** One line of what a building does, plus cost. */
export function buildingCard(content: Content, raceId: string, buildingId: string): InfoCard {
  const def = content.buildings[buildingId]!;
  const race = content.races[raceId]!;
  const does: string[] = [];
  if (def.spawn) {
    const unit = content.units[def.spawn.unit]!;
    const interval = Math.round(def.spawn.intervalTicks * race.modifiers.spawnIntervalMultiplier);
    does.push(`${def.spawn.count}× ${unit.name} / ${seconds(interval)}`);
  }
  if (def.attack) does.push(`tower · ${def.attack.damage} dmg · range ${def.attack.range}`);
  if (def.income) does.push(`+${def.income.amount} compute / ${seconds(def.income.intervalTicks)}`);
  const lines = [does.join(" · ") || `${def.hp} HP`];
  if (def.buildable) lines.push(`${Math.round(def.cost * race.modifiers.costMultiplier)} compute`);
  return { title: def.name, lines };
}

export function unitCard(content: Content, unitId: string, hp: number, maxHp: number): InfoCard {
  const unit = content.units[unitId]!;
  const role = unit.damage <= 0 ? "can't attack" : unit.range > 60 ? "ranged" : "melee";
  return { title: unit.name, lines: [`${Math.ceil(hp)} / ${maxHp} HP · ${role}`] };
}

// --- guide detail -----------------------------------------------------------

export interface GuideEntry {
  title: string;
  description: string;
  stats: string[];
}

export function buildingDetail(content: Content, raceId: string, buildingId: string): GuideEntry {
  const def = content.buildings[buildingId]!;
  const race = content.races[raceId]!;
  const stats: string[] = [];
  if (def.spawn) {
    const unit = content.units[def.spawn.unit]!;
    const interval = Math.round(def.spawn.intervalTicks * race.modifiers.spawnIntervalMultiplier);
    stats.push(`Spawns ${def.spawn.count}× ${unit.name} every ${seconds(interval)}, up to ${def.spawn.maxAlive} alive`);
    stats.push(`${unit.name}: ${unitStats(unit, race.modifiers.unitHpMultiplier)}`);
  }
  if (def.attack) {
    const a = def.attack;
    stats.push(`Shoots ${a.damage} ${a.attackType} damage every ${seconds(a.cooldownTicks)}, range ${a.range}`);
  }
  if (def.income) stats.push(`+${def.income.amount} compute every ${seconds(def.income.intervalTicks)}`);
  stats.push(`${def.hp} HP, ${def.armor} armor (${def.armorType})`);
  if (def.buildable) {
    stats.push(`Costs ${Math.round(def.cost * race.modifiers.costMultiplier)} compute, builds in ${seconds(def.buildTicks)}`);
  }
  return { title: def.name, description: def.description, stats };
}

export function unitDetail(content: Content, unitId: string): GuideEntry {
  const unit = content.units[unitId]!;
  return { title: unit.name, description: unit.description, stats: [unitStats(unit)] };
}

function unitStats(unit: Content["units"][string], hpMultiplier = 1): string {
  const hp = Math.round(unit.hp * hpMultiplier);
  if (unit.damage <= 0) return `${hp} HP, can't attack`;
  const dps = (unit.damage / (unit.cooldownTicks / TICK_RATE)).toFixed(1);
  const reach = unit.range > 60 ? `ranged (${unit.range})` : "melee";
  return `${hp} HP, ${unit.armor} armor, ${reach}, ${unit.damage} ${unit.attackType} damage (${dps}/s)`;
}

export const TERRAIN_GUIDE: GuideEntry[] = [
  { title: "Open ground", description: "Walkable and buildable.", stats: [] },
  { title: "Dead link", description: "Light grey with a bright edge.", stats: ["Impassable", "Can't build", "Blocks line of sight"] },
  { title: "Data swamp", description: "Dark teal, dotted.", stats: ["Units move at half speed", "Can't build"] },
  { title: "Data well", description: "Blue diamond.", stats: ["Open data. The economy hooks in soon"] },
];
