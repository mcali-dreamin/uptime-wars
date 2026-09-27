// Human-readable descriptions, derived from content so they never drift from
// the numbers the simulation actually uses.

import { TICK_RATE, TILE_BLOCKED, TILE_OPEN, TILE_RESOURCE, TILE_SLOW, type Content } from "./sim";

export interface InfoCard {
  title: string;
  subtitle: string;
  lines: string[];
}

const seconds = (ticks: number) => `${+(ticks / TICK_RATE).toFixed(1)}s`;

export function buildingCard(content: Content, raceId: string, buildingId: string): InfoCard {
  const def = content.buildings[buildingId]!;
  const race = content.races[raceId]!;
  const lines: string[] = [];

  if (def.spawn) {
    const unit = content.units[def.spawn.unit]!;
    const interval = Math.round(def.spawn.intervalTicks * race.modifiers.spawnIntervalMultiplier);
    const bonus = race.modifiers.spawnIntervalMultiplier < 1 ? ` (${race.name} bonus)` : "";
    lines.push(`Spawns ${def.spawn.count}× ${unit.name} every ${seconds(interval)}${bonus}, up to ${def.spawn.maxAlive} alive`);
    lines.push(`  ${unit.name}: ${unitSummary(unit)}`);
    lines.push("  Units guard this building, or gather at its rally point (select it, then right-click).");
  }
  if (def.attack) {
    const a = def.attack;
    lines.push(`Shoots creeps: ${a.damage} ${a.attackType} damage every ${seconds(a.cooldownTicks)}, range ${a.range}`);
  }
  if (def.income) {
    lines.push(`+${def.income.amount} compute every ${seconds(def.income.intervalTicks)}`);
  }
  lines.push(`${def.hp} HP, ${def.armor} armor (${def.armorType})`);
  if (def.buildable) {
    lines.push(`Cost ${Math.round(def.cost * race.modifiers.costMultiplier)} compute · builds in ${seconds(def.buildTicks)}`);
  }
  return { title: def.name, subtitle: def.description, lines };
}

export function unitCard(content: Content, unitId: string, hp: number): InfoCard {
  const unit = content.units[unitId]!;
  return { title: unit.name, subtitle: unit.description, lines: [unitSummary(unit), `${Math.ceil(hp)} / ${unit.hp} HP`] };
}

function unitSummary(unit: Content["units"][string]): string {
  const dps = (unit.damage / (unit.cooldownTicks / TICK_RATE)).toFixed(1);
  const reach = unit.range > 60 ? `ranged (${unit.range})` : "melee";
  return `${unit.hp} HP, ${reach}, ${unit.damage} ${unit.attackType} dmg (${dps}/s)`;
}

export function terrainCard(tile: number): InfoCard | null {
  switch (tile) {
    case TILE_BLOCKED:
      return { title: "Dead link", subtitle: "Impassable.", lines: ["Nothing walks through it. You can't build on it. Blocks line of sight."] };
    case TILE_SLOW:
      return { title: "Data swamp", subtitle: "Bogged down.", lines: ["Units move at half speed. You can't build on it."] };
    case TILE_RESOURCE:
      return { title: "Data well", subtitle: "Open data, free for the taking.", lines: ["Economy hooks in soon. You can't build on it yet."] };
    case TILE_OPEN:
      return null;
    default:
      return null;
  }
}
