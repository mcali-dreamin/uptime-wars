// Upgrades: researched at the core (the race and its base) or at the race's
// upgrade center (its army), one at a time at each, and applied as
// multipliers wherever the stat is used. With nothing researched every
// multiplier is exactly 1, so upgrades change nothing until you buy them.

import { lagging } from "./economy";
import type { TickContext } from "./context";
import type { Content, UpgradeStat } from "./content";
import type { Building, Team, World } from "./types";
import { buildingMaxHp } from "./entities";
import { tierOf } from "./tiers";

/** 1 + the sum of every researched level's bonus for this stat. */
export function multiplier(content: Content, team: Team | undefined, stat: UpgradeStat): number {
  if (!team) return 1;
  let bonus = 0;
  for (const [id, level] of Object.entries(team.upgrades)) {
    const def = content.upgrades[id];
    if (def && def.stat === stat) bonus += def.perLevel * level;
  }
  return 1 + bonus;
}

/** A flat stat's total (armor): the multiplier's bonus part. */
export function bonus(content: Content, team: Team | undefined, stat: UpgradeStat): number {
  return multiplier(content, team, stat) - 1;
}

export function levelOf(team: Team, upgrade: string): number {
  return team.upgrades[upgrade] ?? 0;
}

/** Price and duration of the next level. */
export function nextLevel(content: Content, team: Team, upgrade: string) {
  const def = content.upgrades[upgrade]!;
  const level = levelOf(team, upgrade) + 1;
  return { level, cost: def.cost * level, ticks: def.researchTicks * level };
}

/** Which research slot an upgrade uses. */
export type Slot = "research" | "labResearch";
export const slotOf = (content: Content, upgrade: string): Slot => (content.upgrades[upgrade]?.at === "center" ? "labResearch" : "research");

/** Upgrades this team can see at the core or at its upgrade center, in content order. */
export function upgradesAt(content: Content, team: Team, at: "core" | "center"): string[] {
  return Object.keys(content.upgrades).filter((id) => {
    const def = content.upgrades[id]!;
    return (def.at ?? "core") === at && (!def.races || def.races.includes(team.raceId));
  });
}

/** What this team's race calls an upgrade. */
export function upgradeName(content: Content, raceId: string, upgrade: string): string {
  const def = content.upgrades[upgrade]!;
  return def.names?.[raceId] ?? def.name;
}

/** The team's finished upgrade center, if it has one. */
export function centerOf(world: World, content: Content, team: Team): Building | undefined {
  const id = content.races[team.raceId]?.center;
  if (!id) return undefined;
  return world.entities.find((e): e is Building => e.kind === "building" && e.team === team.id && e.defId === id && e.hp > 0 && e.buildRemaining === 0);
}

/** Why this research can't start, or null when it can. */
export function canResearch(content: Content, team: Team, upgrade: string, world?: World): string | null {
  const def = content.upgrades[upgrade];
  if (!def) return "unknown upgrade";
  if (def.races && !def.races.includes(team.raceId)) return "not for your race";
  if (team.coreId === -1) return "no core";
  if (def.at === "center" && world && !centerOf(world, content, team)) {
    const id = content.races[team.raceId]?.center;
    return `needs a ${id ? content.buildings[id]!.name : "upgrade center"}`;
  }
  if (team[slotOf(content, upgrade)]) return "already researching";
  if (levelOf(team, upgrade) >= def.maxLevel) return "fully researched";
  const needs = def.tiers?.[levelOf(team, upgrade)];
  if (needs !== undefined && tierOf(content, team) < needs) return `needs ${content.economy.tiers[needs]!.name}`;
  if (team.money < nextLevel(content, team, upgrade).cost) return "not enough $";
  return null;
}

export function tickResearch(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const team of world.teams) {
    for (const slot of ["research", "labResearch"] as const) {
      const research = team[slot];
      if (!research) continue;
      // Research stops if the building doing it is gone.
      const home = slot === "research" ? ctx.byId.get(team.coreId) : centerOf(world, content, team);
      if (!home) {
        team[slot] = null;
        continue;
      }
      if (lagging(world, team.id)) continue;
      research.remaining -= 1;
      if (research.remaining > 0) continue;
      const upgrade = research.upgrade;
      const before = new Map<number, number>();
      for (const b of world.entities) if (b.kind === "building" && b.team === team.id) before.set(b.id, buildingMaxHp(world, content, team.id, b.defId));
      team.upgrades[upgrade] = levelOf(team, upgrade) + 1;
      // Tougher buildings (a core tier, Building HP): scale what's already standing.
      for (const b of world.entities) {
        if (b.kind !== "building" || b.team !== team.id) continue;
        const was = before.get(b.id)!;
        const now = buildingMaxHp(world, content, team.id, b.defId);
        if (now === was) continue;
        b.maxHp = Math.round((b.maxHp * now) / was);
        b.hp = Math.min(b.maxHp, (b.hp * now) / was);
      }
      team[slot] = null;
      world.events.push({ type: "researched", team: team.id, upgrade, level: team.upgrades[upgrade]! });
    }
  }
}
