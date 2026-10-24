// Text about buildings, units, and terrain, derived from content so it never
// drifts from the numbers the simulation actually uses.
//
// Two sizes: a compact card for the on-screen panel (a name and a line or
// two of numbers) and full detail for the Guide.

import { upgradeName, TICK_RATE, levelOf, nextQueued, queuedCount, type Content, type SpawnerRank, type Team } from "../sim";
import { HIGH_GROUND_DAMAGE } from "../sim/tuning";
import { burstLine, perkChanges, rankChange, secs as seconds, traitLine, unitRuleLines } from "./text";

export interface InfoCard {
  title: string;
  lines: string[];
}


/** One line of what a building does, plus cost. */
export function buildingCard(content: Content, raceId: string, buildingId: string): InfoCard {
  const def = content.buildings[buildingId]!;
  const race = content.races[raceId]!;
  const does: string[] = [];
  if (def.invoke) does.push(burstLine(content, raceId, buildingId));
  else if (def.spawn) {
    const unit = content.units[def.spawn.unit]!;
    const interval = Math.round(def.spawn.intervalTicks * race.modifiers.spawnIntervalMultiplier);
    does.push(`${def.spawn.count}× ${unit.name} / ${seconds(interval)}, squad of ${def.spawn.maxAlive}`);
  }
  if (def.attack) does.push(`tower · ${def.attack.damage} dmg · range ${def.attack.range}`);
  if (def.income) does.push(`+$${def.income.amount} / ${seconds(def.income.intervalTicks)}`);
  if (def.compute) does.push(`+${def.compute} compute`);
  if (def.userCapacity) does.push(`+${def.userCapacity} users`);
  if (def.buildRadius) does.push(`network ${def.buildRadius}`);
  if (def.limitPerTier) {
    const soft = def.pastLimitGrowthPermille ? `, then +${def.pastLimitGrowthPermille / 10}% each past that` : "";
    does.push(`max ${def.limitPerTier.join(" / ")} by core tier${soft}`);
  }
  const lines = [does.join(" · ") || `${def.hp} HP`];
  if (def.buildable) lines.push(`$${Math.round(def.cost * race.modifiers.costMultiplier)}${def.tier ? ` · needs ${content.economy.tiers[def.tier]!.name}` : ""}`);
  return { title: def.name, lines };
}

export function unitCard(content: Content, unitId: string, hp: number, maxHp: number, rank: string | null = null): InfoCard {
  const unit = content.units[unitId]!;
  const role = unit.damage <= 0 ? "can't attack" : unit.range > 60 ? "ranged" : "melee";
  return { title: rank ? `${rank} ${unit.name}` : unit.name, lines: [`${Math.ceil(hp)} / ${maxHp} HP · ${role}`, ...unitRuleLines(unit)] };
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
  }
  if (def.invoke) stats.push(`Autoscales: ${burstLine(content, raceId, buildingId)}`);
  const unitId = def.spawn?.unit ?? def.invoke?.unit;
  if (unitId) {
    const unit = content.units[unitId]!;
    stats.push(`${unit.name}: ${unitStats(unit, race.modifiers.unitHpMultiplier)}`, ...unitRuleLines(unit));
    let from: SpawnerRank | null = null;
    for (const [i, rank] of (race.spawnerRanks ?? []).entries()) {
      stats.push(`Rank ${i + 1}, ${rank.name} (${content.economy.tiers[rank.tier]!.name}, $${Math.round((def.cost * rank.costPermille) / 1000)}): ${rankChange(content, raceId, buildingId, from, rank)}`);
      from = rank;
    }
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
  if (def.limitPerTier) {
    const soft = def.pastLimitGrowthPermille ? `, then +${def.pastLimitGrowthPermille / 10}% of its price for each one past that` : "";
    stats.push(`Up to ${def.limitPerTier.join(" / ")} by core tier (${content.economy.tiers.map((t) => t.name).join(" / ")})${soft}`);
  }
  if (def.tier) stats.push(`Needs ${content.economy.tiers[def.tier]!.name}`);
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
  return { title: unit.name, description: unit.description, stats: [unitStats(unit), ...unitRuleLines(unit)] };
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
  { title: "Height", description: "Three levels: deep web (darkest), surface web, backbone (lightest).", stats: ["Units below can't see up a cliff unless they're right at its foot", `Attacking downhill deals ${Math.round((HIGH_GROUND_DAMAGE - 1) * 100)}% more damage`, "Towers follow the same rules"] },
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

const FLAT_STATS = new Set(["unitArmor", "buildingArmor", "buildRadius"]);

/** A stat bonus at `levels` levels: "+30%" or "+2". */
function bonusAt(def: { stat: string; perLevel: number }, levels: number): string {
  const total = def.perLevel * levels;
  return FLAT_STATS.has(def.stat) ? `+${+total.toFixed(2)}` : `+${Math.round(total * 100)}%`;
}

/** "+15% tower damage" or "+1 building armor" per level. */
function effectText(def: { stat: string; perLevel: number }): string {
  return `${bonusAt(def, 1)} ${STAT_TEXT[def.stat]} per level`;
}

/** "Tower damage +15% → +30%": what the next level changes. */
function levelChange(def: { stat: string; perLevel: number }, level: number): string {
  const label = STAT_TEXT[def.stat]!;
  return `${label[0]!.toUpperCase()}${label.slice(1)} ${bonusAt(def, level)} → ${bonusAt(def, level + 1)}`;
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

/** What clicking this upgrade would queue, as a card: the level it will be, its price, and what's waiting. */
export function upgradeCard(content: Content, team: Team, upgrade: string): InfoCard {
  const def = content.upgrades[upgrade]!;
  const level = levelOf(team, upgrade);
  const next = nextQueued(content, team, upgrade);
  const queued = queuedCount(content, team, upgrade) > 0 ? " · already queued: the next level waits for it" : "";
  if (def.stat === "tier") {
    const tiers = content.economy.tiers;
    if (next.level > def.maxLevel) return { title: tiers[level]!.name, lines: ["Top tier"] };
    const perk = content.races[team.raceId]?.tierPerks?.[next.level];
    return {
      title: `Upgrade to ${tiers[next.level]!.name}`,
      lines: [
        tierLine(content, next.level, team.raceId),
        ...(perk ? [`Perk · ${perk.name}: ${perkChanges(content, team.raceId, next.level).join(", ")}`] : []),
        `$${next.cost} · ${seconds(next.ticks)} · queues at the core${queued}`,
      ],
    };
  }
  const name = upgradeName(content, team.raceId, upgrade);
  const needs = def.tiers?.[next.level - 1];
  const gate = needs ? ` · needs ${content.economy.tiers[needs]!.name}` : "";
  if (def.stat === "trait") {
    const effect = traitLine(content, def.unit!, def.trait ?? {});
    if (next.level > def.maxLevel) return { title: name, lines: [def.description, effect, "Researched"] };
    return { title: name, lines: [def.description, effect, `$${next.cost} · ${seconds(next.ticks)}${gate}${queued}`] };
  }
  if (next.level > def.maxLevel) return { title: name, lines: [def.description, `${bonusAt(def, def.maxLevel)} ${STAT_TEXT[def.stat]}`, "Fully researched"] };
  return { title: `${name} ${next.level}`, lines: [def.description, levelChange(def, next.level - 1), `$${next.cost} · ${seconds(next.ticks)}${gate}${queued}`] };
}

export function upgradeDetail(content: Content, upgrade: string, raceId?: string): GuideEntry {
  const def = content.upgrades[upgrade]!;
  const where = def.at === "center" ? "Upgrade center" : "Core";
  if (def.stat === "trait") {
    const needs = def.tiers?.[0];
    return {
      title: raceId ? upgradeName(content, raceId, upgrade) : def.name,
      description: def.description,
      stats: [traitLine(content, def.unit!, def.trait ?? {}), `${where} · costs $${def.cost}${needs ? ` · needs ${content.economy.tiers[needs]!.name}` : ""}`],
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
  if (rank.maxAlive) parts.push(`${rank.maxAlive > 0 ? "+" : "−"}${Math.abs(rank.maxAlive)} squad`);
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
  return perks.flatMap((perk, tier) => (perk && tier > 0 ? [`${content.economy.tiers[tier]!.name} · ${perk.name}: ${perkChanges(content, raceId, tier).join(", ")}`] : []));
}
