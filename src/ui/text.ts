// Mechanics in words, generated from content. Content descriptions are flavor
// only; every number a player reads comes from here (or cards.ts, built on
// it), so text can't drift from what the simulation does. tests/text.test.ts
// holds that line: no quantities in descriptions, none hardcoded in the UI.

import {
  TICK_RATE,
  mechanicsAtTier,
  modifiersAtTier,
  rankedUpkeep,
  unitUpkeep,
  type AbilityDef,
  type Content,
  type CreepRole,
  type RaceDef,
  type SpawnerRank,
  type TraitDef,
  type UnitDef,
} from "../sim";
import { abilityAmount } from "../sim/heroes";

type Mechanics = NonNullable<RaceDef["mechanics"]>;
type Modifiers = RaceDef["modifiers"];

/** 400 ticks → "20s". */
export const secs = (ticks: number) => `${+(ticks / TICK_RATE).toFixed(1)}s`;
/** 400 → "40%". */
export const permille = (value: number) => `${+(value / 10).toFixed(1)}%`;
/** 0.6 → "60%". */
export const share = (value: number) => `${Math.round(value * 100)}%`;
/** 1.15 → "+15%", 0.7 → "−30%". */
export const change = (mult: number) => `${mult >= 1 ? "+" : "−"}${Math.round(Math.abs(mult - 1) * 100)}%`;
/** 2 → "2×". */
export const times = (mult: number) => `${+mult.toFixed(2)}×`;
const capital = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const names = (content: Content, ids: string[], plural = false) =>
  ids.map((id) => `${content.buildings[id]?.name ?? id}${plural ? "s" : ""}`).join(", ");

// --- unit traits --------------------------------------------------------------

/** Every trait an upgrade can give, in words. Typed so a new trait can't go without text. */
const TRAIT_TEXT: { [K in keyof TraitDef]-?: (value: NonNullable<TraitDef[K]>) => string } = {
  speed: (v) => `moves ${change(v)} faster`,
  range: (v) => `${change(v)} range`,
  crit: (v) => `every ${ordinal(v.every)} hit deals ${times(v.mult)} damage`,
  splash: (v) => `hits splash ${share(v.share)} damage within ${v.radius}px of the target`,
  chain: (v) => `shots chain to a second enemy within ${v.radius}px for ${share(v.share)} damage`,
  taunt: (v) => `creeps within ${v.radius}px drop what they're doing and attack it`,
  split: (v) => `splits into ${v.count} with ${share(v.hpShare)} HP each when it dies`,
  healMult: (v) => `heals ${times(v)} as much`,
  revive: (v) => `brings back the first ally that falls near it, at ${share(v.hpShare)} HP, once every ${secs(v.cooldownTicks)}`,
  squad: (v) => `+${v} in every squad and every burst`,
  burstMult: (v) => `bursts ${times(v)} as big`,
  disarmTicks: (v) => `hits stop the enemy attacking for ${secs(v)}`,
  stunTicks: (v) => `hits stun the enemy for ${secs(v)}`,
  holdArmor: (v) => `takes ${v} less from every hit while it holds its post`,
};

/** "Lambda: +2 in every squad and every burst". */
export function traitLine(content: Content, unitId: string, trait: TraitDef): string {
  const parts = (Object.keys(trait) as (keyof TraitDef)[]).map((key) => (TRAIT_TEXT[key] as (v: unknown) => string)(trait[key]));
  return `${content.units[unitId]!.name}: ${parts.join("; ")}`;
}

// --- what a unit does beyond hitting things ---------------------------------------

const ROLE_TEXT: { [K in CreepRole["kind"]]: (role: Extract<CreepRole, { kind: K }>) => string } = {
  scanner: (r) => `Doesn't fight. If it spots your base and lives ${secs(r.reportTicks)}, every pack within ${r.reportRadius}px marches on you`,
  phisher: (r) => `Ignores towers and goes for whatever serves users (hits back at units that hit it); every hit drives users away ${times(r.churnMultiplier)} as fast`,
  miner: (r) => `Every hit on a building drains $${r.drain} from you`,
  jammer: (r) => `Every hit jams a building for ${secs(r.jamTicks)}: no shooting, spawning or bursting`,
  siege: (r) => `Goes for buildings, and hits them ${times(r.buildingMultiplier)} as hard`,
};

/** A unit's special rules, one line each (empty for plain fighters). */
export function unitRuleLines(unit: UnitDef): string[] {
  const lines: string[] = [];
  if (unit.role) lines.push((ROLE_TEXT[unit.role.kind] as (r: CreepRole) => string)(unit.role));
  if (unit.heal) lines.push(`Mends allied units and buildings within ${unit.heal.radius}px, ${unit.heal.perSecond} HP a second`);
  if (unit.siege) lines.push(`${times(unit.siege)} damage to buildings`);
  if (unit.slowTicks) lines.push(`Enemies it hits act at half speed for ${secs(unit.slowTicks)}`);
  return lines;
}

// --- races ------------------------------------------------------------------------

/** A race mechanic as a sentence. */
const MECHANIC_TEXT: { [K in keyof Mechanics]-?: (content: Content, m: NonNullable<Mechanics[K]>) => string } = {
  fork: (_, m) => `Fork (X): copy a finished building for ${permille(m.costPermille)} of its price, built in ${permille(m.buildPermille)} of the time`,
  repair: (_, m) => `Buildings repair ${permille(m.permillePerSecond)} of their HP a second once nothing has hit them for ${secs(m.quietTicks)}`,
  region: (_, m) => `Regions: each of your buildings within ${m.radiusTiles} tiles cuts the damage a building takes by ${permille(m.perNeighborPermille)}, up to ${permille(m.maxPermille)}`,
  loyalty: (_, m) => `Loyal users: they leave at ${permille(m.churnPermille)} of the usual rate when you're hit`,
  thorns: (content, m) => `${names(content, m.buildings, true)} hit back: melee attackers take ${m.damage} damage per blow`,
};

/** One field of a mechanic or modifier, for "before → after" perk lines: "<label> <before> → <after> <suffix>". */
type Field = [label: string, format: (value: never) => string, suffix?: string];

const MECHANIC_FIELDS: { [K in keyof Mechanics]-?: { [F in keyof NonNullable<Mechanics[K]>]-?: Field } } = {
  fork: { costPermille: ["forks cost", permille], buildPermille: ["forks build in", permille] },
  repair: { permillePerSecond: ["repair", (v: number) => `${permille(v)}/s`], quietTicks: ["repair starts after", secs] },
  region: { radiusTiles: ["region radius", (v: number) => `${v} tiles`], perNeighborPermille: ["region shield per neighbor", permille], maxPermille: ["region shield", (v: number) => `up to ${permille(v)}`] },
  loyalty: { churnPermille: ["users leave at", permille, "of the usual rate when you're hit"] },
  thorns: { damage: ["thorns", (v: number) => `${v} per blow`], buildings: ["thorns on", (v: string[]) => v.join(", ")] },
};

const MODIFIER_FIELDS: { [K in keyof Modifiers]-?: Field } = {
  spawnIntervalMultiplier: ["spawn timers", change],
  costMultiplier: ["building prices", change],
  unitHpMultiplier: ["unit HP", change],
  startingMoneyBonus: ["", (v: number) => `+$${v} to start`],
  buildRadiusBonus: ["core reach", (v: number) => `+${v} tiles`],
  invokeCooldownMultiplier: ["burst cooldown", change],
  invokeCostMultiplier: ["burst price", change],
};

/** Modifier values that mean "no change". */
const NEUTRAL: Partial<Record<keyof Modifiers, number>> = {
  spawnIntervalMultiplier: 1,
  costMultiplier: 1,
  unitHpMultiplier: 1,
  startingMoneyBonus: 0,
  buildRadiusBonus: 0,
  invokeCooldownMultiplier: 1,
  invokeCostMultiplier: 1,
};

/** "Spawn timers −15%", "+$75 to start": a race's modifiers that differ from the default. */
function modifierLines(modifiers: Modifiers): string[] {
  return (Object.keys(MODIFIER_FIELDS) as (keyof Modifiers)[]).flatMap((key) => {
    const value = modifiers[key];
    if (value === undefined || value === NEUTRAL[key]) return [];
    const [label, format] = MODIFIER_FIELDS[key];
    return [capital(`${label ? `${label} ` : ""}${(format as (v: unknown) => string)(value)}`)];
  });
}

/** What makes a race play its way, generated from its data (core tier 0). */
export function raceLines(content: Content, raceId: string): string[] {
  const race = content.races[raceId]!;
  const lines: string[] = [];
  const mechanics = mechanicsAtTier(content, raceId, 0);
  for (const key of Object.keys(MECHANIC_TEXT) as (keyof Mechanics)[]) {
    const m = mechanics[key];
    if (m) lines.push((MECHANIC_TEXT[key] as (c: Content, m: unknown) => string)(content, m));
  }
  const own = race.buildings.map((id) => content.buildings[id]!);
  const fn = own.find((b) => b.invoke);
  if (fn) lines.push(`Autoscales: Functions keep a warm squad and burst it bigger when creeps come near. Every burst costs $`);
  if (own.some((b) => b.blocks && b.buildable && !b.gate)) lines.push("Walls close a gap outright; Gates let your own units through");
  if (!own.some((b) => b.buildRadius && b.buildable && b !== content.buildings[race.core])) lines.push("No network nodes: builds only around its cores");
  lines.push(...modifierLines(modifiersAtTier(content, raceId, 0)));
  return lines;
}

/** A tier perk as what it changes: "Region shield up to 30% → up to 55%". */
export function perkChanges(content: Content, raceId: string, tier: number): string[] {
  const perk = content.races[raceId]?.tierPerks?.[tier];
  if (!perk) return [];
  const before = mechanicsAtTier(content, raceId, tier - 1);
  const after = mechanicsAtTier(content, raceId, tier);
  const out: string[] = [];
  for (const key of Object.keys(perk.mechanics ?? {}) as (keyof Mechanics)[]) {
    const was = before[key] as Record<string, unknown> | undefined;
    const now = after[key] as Record<string, unknown>;
    if (!was) {
      out.push((MECHANIC_TEXT[key] as (c: Content, m: unknown) => string)(content, now));
      continue;
    }
    const fields = MECHANIC_FIELDS[key] as Record<string, Field>;
    for (const field of Object.keys((perk.mechanics as Record<string, object>)[key]!)) {
      const [label, format, suffix] = fields[field]!;
      const f = format as (v: unknown) => string;
      out.push(`${label} ${f(was[field])} → ${f(now[field])}${suffix ? ` ${suffix}` : ""}`);
    }
  }
  const modsBefore = modifiersAtTier(content, raceId, tier - 1);
  const modsAfter = modifiersAtTier(content, raceId, tier);
  for (const key of Object.keys(perk.modifiers ?? {}) as (keyof Modifiers)[]) {
    const [label, format] = MODIFIER_FIELDS[key];
    const f = format as (v: unknown) => string;
    const was = modsBefore[key] ?? NEUTRAL[key];
    out.push(was === NEUTRAL[key] ? `${label} ${f(modsAfter[key])}` : `${label} ${f(was)} → ${f(modsAfter[key])}`);
  }
  return out.map(capital);
}

// --- spawner ranks ------------------------------------------------------------------

/**
 * What ranking a spawner up does to its units, in their numbers:
 * "Lambda 40 → 56 HP, 6 → 8 damage, squad 3 → 3, burst 4 → 5, 1 → 1 compute each".
 */
export function rankChange(content: Content, raceId: string, buildingId: string, from: SpawnerRank | null, to: SpawnerRank): string {
  const def = content.buildings[buildingId]!;
  const unitId = def.spawn?.unit ?? def.invoke?.unit;
  if (!unitId) return "";
  const unit = content.units[unitId]!;
  const hpMult = modifiersAtTier(content, raceId, to.tier).unitHpMultiplier;
  const hp = (r: SpawnerRank | null) => Math.round((Math.round(unit.hp * hpMult) * (r?.hpPermille ?? 1000)) / 1000);
  const damage = (r: SpawnerRank | null) => +((unit.damage * (r?.damagePermille ?? 1000)) / 1000).toFixed(1);
  const parts = [`${hp(from)} → ${hp(to)} HP`];
  if (unit.damage > 0) parts.push(`${damage(from)} → ${damage(to)} damage`);
  const armor = (r: SpawnerRank | null) => unit.armor + (r?.armor ?? 0);
  if (armor(from) !== armor(to)) parts.push(`armor ${armor(from)} → ${armor(to)}`);
  if (def.spawn) {
    const squad = (r: SpawnerRank | null) => Math.max(1, def.spawn!.maxAlive + (r?.maxAlive ?? 0));
    if (squad(from) !== squad(to)) parts.push(`squad ${squad(from)} → ${squad(to)}`);
  }
  if (def.invoke) {
    const burst = (r: SpawnerRank | null) => Math.max(1, def.invoke!.count + (r?.burst ?? 0));
    if (burst(from) !== burst(to)) parts.push(`burst ${burst(from)} → ${burst(to)}`);
  }
  const upkeep = unitUpkeep(content, unitId);
  parts.push(`${rankedUpkeep(upkeep, from)} → ${rankedUpkeep(upkeep, to)} compute each`);
  return `${unit.name} ${parts.join(", ")}`;
}

// --- functions ------------------------------------------------------------------------

/** How a Function autoscales, in one line, with this race's numbers at core tier 0. */
export function burstLine(content: Content, raceId: string, buildingId: string): string {
  const def = content.buildings[buildingId]!;
  const fn = def.invoke!;
  const mods = modifiersAtTier(content, raceId, 0);
  const unit = content.units[fn.unit]!.name;
  const warm = def.spawn ? `${def.spawn.maxAlive} warm ${unit} · ` : "";
  const cost = Math.round(fn.cost * (mods.invokeCostMultiplier ?? 1));
  const cools = Math.round(fn.cooldownTicks * (mods.invokeCooldownMultiplier ?? 1));
  return `${warm}bursts +${fn.count} for ${secs(fn.ttlTicks)} when creeps within ${fn.triggerRange}px outnumber them (or V) · $${cost} a burst · cools ${secs(cools)} · needs free compute`;
}

// --- hero abilities ----------------------------------------------------------------------

/** What an ability does at a rank, in numbers. */
export function abilityEffect(content: Content, ability: AbilityDef, rank: number): string {
  const amount = abilityAmount(ability, Math.max(1, rank));
  const time = secs(ability.durationTicks ?? 0);
  switch (ability.effect) {
    case "blast":
      return `${Math.round(amount)} damage in a ${ability.radius}px area`;
    case "strike":
      return `${Math.round(amount)} damage to one target`;
    case "heal":
      return `Heals ${Math.round(amount)} within ${ability.radius}px`;
    case "decoy":
      return `Decoy with ${Math.round(amount)} HP for ${time}`;
    case "summon":
      return `${Math.round(amount)}× ${content.units[ability.unit!]!.name} for ${time}`;
    case "buff":
      return `Your units deal +${share(amount)} damage for ${time}`;
    case "shield":
      return `Buildings within ${ability.radius}px take ${permille(amount)} less damage for ${time}`;
    case "build":
      return `Finishes construction and mends ${Math.round(amount)} within ${ability.radius}px`;
    case "trigger":
      return `Bursts every Function within ${ability.radius}px now, free`;
    case "discount":
      return `Bursts are free for ${time}`;
    case "funds":
      return `+$${Math.round(amount)}`;
    case "stun":
      return `Freezes creeps within ${ability.radius}px for ${time}${amount ? ` · ${Math.round(amount)} damage` : ""}`;
    case "users":
      return `Up to ${Math.round(amount)} users arrive now`;
  }
}
