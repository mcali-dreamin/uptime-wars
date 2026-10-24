// Spawner ranks: upgrade one spawner in place so it fields fewer, stronger
// units. Compute caps the army, so past a point another spawner only
// reinforces faster; a rank makes every unit worth more per compute. The
// choice with each $ is: another spawner, or a better one?
//
// Ranks are per race (races.json -> spawnerRanks): each race upgrades its own
// way. A building's rank applies to the units it spawns from then on; the
// ones already out keep theirs. While it's refitting, it doesn't spawn or run.

import type { Content, SpawnerRank, UnitRank } from "./content/schema";
import type { TickContext } from "./context";
import { lagging } from "./economy";
import { baseCost } from "./placement";
import { tierOf } from "./tiers";
import type { Building, Team, Unit, World } from "./types";

/** The race's ranks (index 0 is rank 1, the first upgrade). Empty: it can't rank up. */
export function ranksOf(content: Content, team: Team | undefined): SpawnerRank[] {
  return (team && content.races[team.raceId]!.spawnerRanks) || [];
}

/** The rank a unit was spawned at, or null for a plain one. Creeps rank by waves.json -> ranks. */
export function unitRank(content: Content, world: World, unit: Unit): UnitRank | null {
  if (!unit.rank) return null;
  const team = world.teams[unit.team];
  if (team?.controller === "wave-director") return content.waves.ranks?.levels[unit.rank - 1] ?? null;
  return ranksOf(content, team)[unit.rank - 1] ?? null;
}

/** Bounty and XP multiplier for killing this unit. */
export function rankWorth(content: Content, world: World, unit: Unit): number {
  return unitRank(content, world, unit)?.worth ?? 1;
}

/** The rank a building is at, or null at rank 0. */
export function buildingRank(content: Content, world: World, building: Building): SpawnerRank | null {
  if (!building.rank) return null;
  return ranksOf(content, world.teams[building.team])[building.rank - 1] ?? null;
}

/** The next rank this building can go to, or null if it's at the top (or can't rank). */
export function nextRank(content: Content, world: World, building: Building): SpawnerRank | null {
  const def = content.buildings[building.defId]!;
  if (!def.spawn && !def.invoke) return null;
  return ranksOf(content, world.teams[building.team])[building.rank ?? 0] ?? null;
}

/** What the next rank costs, or null if there isn't one. */
export function rankCost(content: Content, world: World, building: Building): number | null {
  const next = nextRank(content, world, building);
  if (!next) return null;
  const team = world.teams[building.team]!;
  return Math.round((baseCost(content, team.raceId, building.defId) * next.costPermille) / 1000);
}

/** Why this building can't rank up right now, or null if it can. */
export function rankBlocker(content: Content, world: World, teamId: number, building: Building | undefined): string | null {
  if (!building || building.kind !== "building" || building.team !== teamId || building.hp <= 0) return "not your building";
  const next = nextRank(content, world, building);
  if (!next) return building.rank ? "top rank" : "can't upgrade";
  if (building.buildRemaining > 0) return "still building";
  if (refitting(building)) return "already upgrading";
  const team = world.teams[teamId]!;
  if (team.downTick !== null) return "offline";
  if (tierOf(content, team) < next.tier) return `needs ${content.economy.tiers[next.tier]?.name ?? `tier ${next.tier}`}`;
  if (team.money < rankCost(content, world, building)!) return "not enough $";
  return null;
}

/**
 * Ranking up a group: which of these buildings can rank up now, the ones that
 * could but don't fit what's left of the team's $ after the ones before them
 * (`short`), and what the affordable ones cost together. In the given order,
 * the way the commands will land.
 */
export function rankGroup(content: Content, world: World, teamId: number, buildings: readonly Building[]): { ids: number[]; cost: number; short: number } {
  const team = world.teams[teamId];
  const plan = { ids: [] as number[], cost: 0, short: 0 };
  if (!team) return plan;
  for (const building of buildings) {
    const blocker = rankBlocker(content, world, teamId, building);
    if (blocker !== null && blocker !== "not enough $") continue;
    const price = rankCost(content, world, building)!;
    if (plan.cost + price > team.money) plan.short += 1;
    else {
      plan.ids.push(building.id);
      plan.cost += price;
    }
  }
  return plan;
}

/** Pay and start the refit. Call only when rankBlocker is null. */
export function startRank(content: Content, world: World, building: Building): void {
  const team = world.teams[building.team]!;
  team.money -= rankCost(content, world, building)!;
  building.refitRemaining = nextRank(content, world, building)!.ticks;
}

export function refitting(building: Building): boolean {
  return (building.refitRemaining ?? 0) > 0;
}

/** Count refits down (slowed by overload, like research); finish them. */
export function tickRefits(ctx: TickContext): void {
  const { world } = ctx;
  for (const entity of world.entities) {
    if (entity.kind !== "building" || entity.hp <= 0 || !refitting(entity)) continue;
    if (lagging(world, entity.team)) continue;
    entity.refitRemaining! -= 1;
    if (entity.refitRemaining! > 0) continue;
    delete entity.refitRemaining;
    entity.rank = (entity.rank ?? 0) + 1;
    world.events.push({ type: "ranked", id: entity.id, team: entity.team, rank: entity.rank, x: entity.x, y: entity.y });
  }
}

/** Stamp a freshly spawned unit with its spawner's rank: tougher, harder-hitting, armored. */
export function applyRank(content: Content, world: World, unit: Unit, building: Building): void {
  const rank = buildingRank(content, world, building);
  if (rank) stampRank(unit, building.rank!, rank);
}

/** Give a fresh unit rank `level` (1-based): its hp and armor now, its damage through rankDamage. */
export function stampRank(unit: Unit, level: number, rank: UnitRank): void {
  unit.rank = level;
  unit.maxHp = Math.round((unit.maxHp * rank.hpPermille) / 1000);
  unit.hp = unit.maxHp;
  unit.armor += rank.armor;
}

/** Damage multiplier for a unit's rank (1 when plain). */
export function rankDamage(content: Content, world: World, unit: Unit): number {
  const rank = unitRank(content, world, unit);
  return rank ? rank.damagePermille / 1000 : 1;
}

/** Compute a unit at this rank uses, from its plain upkeep. Integer. */
export function rankedUpkeep(base: number, rank: UnitRank | null): number {
  return rank && "upkeepPermille" in rank ? Math.round((base * (rank as SpawnerRank).upkeepPermille) / 1000) : base;
}

/** A spawner's standing squad at its rank (never below 1). */
export function rankedMaxAlive(content: Content, world: World, building: Building, base: number): number {
  return Math.max(1, base + (buildingRank(content, world, building)?.maxAlive ?? 0));
}

/** A function's burst size at its rank (never below 1). */
export function rankedBurst(content: Content, world: World, building: Building, base: number): number {
  return Math.max(1, base + (buildingRank(content, world, building)?.burst ?? 0));
}
