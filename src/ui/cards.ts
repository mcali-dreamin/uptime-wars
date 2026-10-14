// Text about buildings, units, and terrain, derived from content so it never
// drifts from the numbers the simulation actually uses.
//
// Two sizes: a compact card for the on-screen panel (a name and a line or
// two of numbers) and full detail for the Guide.

import { upgradeName, TICK_RATE, levelOf, nextLevel, type Content, type SpawnerRank, type Team } from "../sim";

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
  if (def.invoke) {
    const unit = content.units[def.invoke.unit]!;
    does.push(`+${def.invoke.count}× ${unit.name} burst · $${def.invoke.cost} / scale-up`);
  }
  if (def.attack) does.push(`tower · ${def.attack.damage} dmg · range ${def.attack.range}`);
  if (def.income) does.push(`+$${def.income.amount} / ${seconds(def.income.intervalTicks)}`);
  if (def.compute) does.push(`+${def.compute} compute`);
  if (def.userCapacity) does.push(`+${def.userCapacity} users`);
  if (def.buildRadius) does.push(`network ${def.buildRadius}`);
  if (def.limitPerTier) does.push(`max ${def.limitPerTier.join(" / ")} by core tier`);
  const lines = [does.join(" · ") || `${def.hp} HP`];
  if (def.buildable) lines.push(`$${Math.round(def.cost * race.modifiers.costMultiplier)}${def.tier ? ` · needs ${content.economy.tiers[def.tier]!.name}` : ""}`);
  return { title: def.name, lines };
}

export function unitCard(content: Content, unitId: string, hp: number, maxHp: number, rank: string | null = null): InfoCard {
  const unit = content.units[unitId]!;
  const role = unit.damage <= 0 ? "can't attack" : unit.range > 60 ? "ranged" : "melee";
  return { title: rank ? `${rank} ${unit.name}` : unit.name, lines: [`${Math.ceil(hp)} / ${maxHp} HP · ${role}`] };
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
  if (def.invoke) {
    const i = def.invoke;
    const unit = content.units[i.unit]!;
    stats.push(
      `Autoscales: when creeps within ${i.triggerRange} outnumber its squad (or you scale it up, V), bursts ${i.count}× ${unit.name} more for ${seconds(i.ttlTicks)}, then cools down for ${seconds(i.cooldownTicks)}. Each scale-up costs $${i.cost}; no $, no burst.`,
    );
    stats.push(`${unit.name}: ${unitStats(unit, race.modifiers.unitHpMultiplier)}`);
  }
  if (def.attack) {
    const a = def.attack;
    stats.push(`Shoots ${a.damage} damage every ${seconds(a.cooldownTicks)}, range ${a.range}`);
  }
  if (def.income) stats.push(`+$${def.income.amount} every ${seconds(def.income.intervalTicks)}`);
  if (def.compute) stats.push(`Supplies ${def.compute} compute: room for ${def.compute} more users, or about ${Math.floor(def.compute / content.economy.compute.perUnit)} more units`);
  if (def.userCapacity) {
    const perSecond = def.userCapacity * content.economy.revenuePerUserPerSecond;
    stats.push(`Serves up to ${def.userCapacity} users (up to +$${+perSecond.toFixed(1)}/s when full, if you have the compute to serve them)`);
  }
  if (def.buildRadius) stats.push(`Extends your network: you can build within ${def.buildRadius} tiles of it`);
  stats.push(`${def.hp} HP, ${def.armor} armor`);
  if (def.buildable) {
    const growth = def.costGrowthPermille ?? content.economy.costGrowthPermille ?? 0;
    stats.push(
      `Costs $${Math.round(def.cost * race.modifiers.costMultiplier)}${growth ? `, +${growth / 10}% for each one you already own` : ""}, builds in ${seconds(def.buildTicks)}`,
    );
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
  return `${hp} HP, ${unit.armor} armor, ${reach}, ${unit.damage} damage (${dps}/s)`;
}

export const TERRAIN_GUIDE: GuideEntry[] = [
  { title: "Open ground", description: "Walkable and buildable.", stats: [] },
  { title: "Dead link", description: "Light grey with a bright edge.", stats: ["Impassable", "Can't build", "Blocks line of sight"] },
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
  buildRadius: "core reach (tiles)",
  tier: "core tier",
  unitArmor: "unit armor",
  buildingArmor: "building armor",
  buildingHp: "building HP",
  towerDamage: "tower damage",
};

/** "+15% tower damage" or "+1 building armor" per level. */
function effectText(def: { stat: string; perLevel: number }): string {
  const flat = def.stat === "unitArmor" || def.stat === "buildingArmor" || def.stat === "buildRadius";
  return `${flat ? `+${def.perLevel}` : `+${Math.round(def.perLevel * 100)}%`} ${STAT_TEXT[def.stat]} per level`;
}

/** What reaching a core tier gives, as one line. */
function tierLine(content: Content, tier: number, raceId?: string): string {
  const t = content.economy.tiers[tier]!;
  const roster = raceId ? content.races[raceId]!.buildings : Object.keys(content.buildings);
  const unlocks = roster.filter((id) => content.buildings[id]!.tier === tier).map((id) => content.buildings[id]!.name);
  const apps = content.buildings["web-app"]?.limitPerTier?.[tier];
  return [
    apps !== undefined ? `${apps} Web Apps` : "",
    unlocks.length ? `unlocks ${unlocks.join(", ")}` : "",
    `+${t.compute} compute`,
    `+${t.buildRadius} core reach`,
    `core ${Math.round(t.coreHp * 100)}% HP`,
    `crawlers sense you ${t.traffic}px further`,
  ].filter(Boolean).join(" · ");
}

export function upgradeCard(content: Content, team: Team, upgrade: string): InfoCard {
  const def = content.upgrades[upgrade]!;
  const level = levelOf(team, upgrade);
  if (def.stat === "tier") {
    const tiers = content.economy.tiers;
    if (level >= def.maxLevel) return { title: tiers[level]!.name, lines: ["Top tier"] };
    const next = nextLevel(content, team, upgrade);
    const perk = content.races[team.raceId]?.tierPerks?.[level + 1];
    return {
      title: `Upgrade to ${tiers[level + 1]!.name}`,
      lines: [
        tierLine(content, level + 1, team.raceId),
        ...(perk ? [`Perk · ${perk.name}: ${perk.description}`] : []),
        `$${next.cost} · ${seconds(next.ticks)} · uses the core's research`,
      ],
    };
  }
  const name = upgradeName(content, team.raceId, upgrade);
  const needs = def.tiers?.[level];
  const gate = needs ? ` · needs ${content.economy.tiers[needs]!.name}` : "";
  if (def.stat === "trait") {
    const unit = content.units[def.unit!]!.name;
    if (level >= 1) return { title: name, lines: [def.description, `${unit} trait · researched`] };
    return { title: name, lines: [def.description, `${unit} trait · $${def.cost} · ${seconds(def.researchTicks)}${gate}`] };
  }
  const effect = effectText(def);
  if (level >= def.maxLevel) return { title: name, lines: [effect, "Fully researched"] };
  const next = nextLevel(content, team, upgrade);
  return { title: `${name} ${next.level}`, lines: [effect, `$${next.cost} · ${seconds(next.ticks)}${gate}`] };
}

export function upgradeDetail(content: Content, upgrade: string, raceId?: string): GuideEntry {
  const def = content.upgrades[upgrade]!;
  const where = def.at === "center" ? "Upgrade center" : "Core";
  if (def.stat === "trait") {
    const needs = def.tiers?.[0];
    return {
      title: raceId ? upgradeName(content, raceId, upgrade) : def.name,
      description: def.description,
      stats: [`${content.units[def.unit!]!.name} trait · ${where}`, `Costs $${def.cost}${needs ? ` · needs ${content.economy.tiers[needs]!.name}` : ""}`],
    };
  }
  if (def.stat === "tier") {
    const costs = Array.from({ length: def.maxLevel }, (_, i) => `${def.cost * (i + 1)}`).join(" / ");
    return {
      title: def.name,
      description: def.description,
      stats: [...content.economy.tiers.slice(1).map((t, i) => `${t.name}: ${tierLine(content, i + 1)}`), `Costs $${costs}`],
    };
  }
  const costs = Array.from({ length: def.maxLevel }, (_, i) => `${def.cost * (i + 1)}`).join(" / ");
  return {
    title: raceId ? upgradeName(content, raceId, upgrade) : def.name,
    description: def.description,
    stats: [`${effectText(def)}, ${def.maxLevel} levels · ${where}`, `Costs $${costs}`],
  };
}

/** What one spawner rank does, in a line: "+40% HP, +50% damage, +2 armor · 1.6× compute". */
export function rankEffect(rank: SpawnerRank): string {
  const pct = (permille: number) => `${permille >= 1000 ? "+" : ""}${Math.round((permille - 1000) / 10)}%`;
  const parts = [`${pct(rank.hpPermille)} HP`, `${pct(rank.damagePermille)} damage`];
  if (rank.armor) parts.push(`+${rank.armor} armor`);
  if (rank.maxAlive) parts.push(`${rank.maxAlive > 0 ? "+" : ""}${rank.maxAlive} squad`);
  if (rank.burst) parts.push(`+${rank.burst} per burst`);
  return `${parts.join(", ")} · ${rank.upkeepPermille / 1000}× compute`;
}

/** A race's spawner ranks, one line each, for the Guide. */
export function rankLines(content: Content, raceId: string): string[] {
  return (content.races[raceId]?.spawnerRanks ?? []).map(
    (rank, i) => `Spawner rank ${i + 1}, ${rank.name} (${content.economy.tiers[rank.tier]!.name}, ${rank.costPermille / 10}% of its price): ${rankEffect(rank)}`,
  );
}

/** A race's tier perks, one line each ("Data Center · Community: Forks cost 35%..."). */
export function perkLines(content: Content, raceId: string): string[] {
  const perks = content.races[raceId]?.tierPerks ?? [];
  return perks.flatMap((perk, tier) => (perk && tier > 0 ? [`${content.economy.tiers[tier]!.name} · ${perk.name}: ${perk.description}`] : []));
}
