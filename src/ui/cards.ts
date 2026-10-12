// Text about buildings, units, and terrain, derived from content so it never
// drifts from the numbers the simulation actually uses.
//
// Two sizes: a compact card for the on-screen panel (a name and a line or
// two of numbers) and full detail for the Guide.

import { TICK_RATE, levelOf, nextLevel, type Content, type Team } from "../sim";

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
  if (def.income) does.push(`+$${def.income.amount} / ${seconds(def.income.intervalTicks)}`);
  if (def.compute) does.push(`+${def.compute} compute`);
  if (def.onWell) does.push("on a data well");
  if (def.userCapacity) does.push(`+${def.userCapacity} users`);
  if (def.buildRadius) does.push(`network ${def.buildRadius}`);
  const lines = [does.join(" · ") || `${def.hp} HP`];
  if (def.buildable) lines.push(`$${Math.round(def.cost * race.modifiers.costMultiplier)}`);
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
  if (def.income) stats.push(`+$${def.income.amount} every ${seconds(def.income.intervalTicks)}`);
  if (def.compute) stats.push(`Supplies ${def.compute} compute: room for ${def.compute} more users, or about ${Math.floor(def.compute / content.economy.compute.perUnit)} more units`);
  if (def.onWell) stats.push("Only on a data well inside your network. Wells sit out past your core's reach: extend your network to claim one");
  if (def.userCapacity) {
    const perSecond = def.userCapacity * content.economy.revenuePerUserPerSecond;
    stats.push(`Serves up to ${def.userCapacity} users (up to +$${+perSecond.toFixed(1)}/s when full, if you have the compute to serve them)`);
  }
  if (def.buildRadius) stats.push(`Extends your network: you can build within ${def.buildRadius} tiles of it`);
  stats.push(`${def.hp} HP, ${def.armor} armor (${def.armorType})`);
  if (def.buildable) {
    stats.push(`Costs $${Math.round(def.cost * race.modifiers.costMultiplier)}, builds in ${seconds(def.buildTicks)}`);
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
  { title: "Data well", description: "Glowing blue crystals.", stats: ["Build a Data Pump on one for 100 compute", "Two are always a short hop from your start; the rest are scattered across the web", "Walkable, but nothing else can be built on it"] },
  { title: "Height", description: "Three levels: deep web (darkest), surface web, backbone (lightest).", stats: ["Units below can't see up a cliff unless they're right at its foot", "Attacking downhill deals 25% more damage", "Towers follow the same rules"] },
  { title: "Cliff", description: "Near-black band with a bright lip on the drop side.", stats: ["Impassable", "Can't build", "You can see and shoot across it"] },
  { title: "Ramp", description: "Striped gap in a cliff.", stats: ["The only way up or down", "Hold the ramp, hold the plateau"] },
];

const STAT_TEXT: Record<string, string> = {
  unitHp: "unit HP",
  unitDamage: "unit damage",
  towerRange: "tower range",
  spawnSpeed: "spawn speed",
  userCapacity: "user capacity",
  revenue: "revenue per user",
};

export function upgradeCard(content: Content, team: Team, upgrade: string): InfoCard {
  const def = content.upgrades[upgrade]!;
  const level = levelOf(team, upgrade);
  const effect = `+${Math.round(def.perLevel * 100)}% ${STAT_TEXT[def.stat]} per level`;
  if (level >= def.maxLevel) return { title: def.name, lines: [effect, "Fully researched"] };
  const next = nextLevel(content, team, upgrade);
  return { title: `${def.name} ${next.level}`, lines: [effect, `$${next.cost} · ${seconds(next.ticks)}`] };
}

export function upgradeDetail(content: Content, upgrade: string): GuideEntry {
  const def = content.upgrades[upgrade]!;
  const costs = Array.from({ length: def.maxLevel }, (_, i) => `${def.cost * (i + 1)}`).join(" / ");
  return {
    title: def.name,
    description: def.description,
    stats: [`+${Math.round(def.perLevel * 100)}% ${STAT_TEXT[def.stat]} per level, ${def.maxLevel} levels`, `Costs $${costs}`],
  };
}
