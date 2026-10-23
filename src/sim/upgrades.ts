// Upgrades: researched at the core (the race and its base) or at the race's
// upgrade center (its army), each through a queue (at most RESEARCH_QUEUE
// entries: the one researching plus the waiting ones, paid for when they were
// queued, WC3 style), and applied as multipliers wherever the stat is used.
// With nothing researched every multiplier is exactly 1, so upgrades change
// nothing until you buy them.

import { lagging } from "./economy";
import type { TickContext } from "./context";
import type { Content, UpgradeStat } from "./content";
import type { Building, QueuedResearch, Team, World } from "./types";
import { buildingMaxHp } from "./entities";
import { RESEARCH_QUEUE } from "./tuning";
import { tierOf, tierUpgrade } from "./tiers";

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

/** Price and duration of the next level, counting what's researched so far only. */
export function nextLevel(content: Content, team: Team, upgrade: string) {
  const def = content.upgrades[upgrade]!;
  const level = levelOf(team, upgrade) + 1;
  return { level, cost: def.cost * level, ticks: def.researchTicks * level };
}

/** Which research slot an upgrade uses. */
export type Slot = "research" | "labResearch";
export const slotOf = (content: Content, upgrade: string): Slot => (content.upgrades[upgrade]?.at === "center" ? "labResearch" : "research");

/** A building's waiting entries, behind whatever is researching there. */
export const waitingOf = (team: Team, slot: Slot): QueuedResearch[] =>
  slot === "research" ? team.researchQueue : team.labResearchQueue;

/** Every entry at a building's queue, in order: the one researching, then the waiting ones. */
export function queueOf(team: Team, slot: Slot): { upgrade: string; paid?: number }[] {
  const head = team[slot];
  return head ? [head, ...waitingOf(team, slot)] : [...waitingOf(team, slot)];
}

/** How many entries of this upgrade are queued at its building (the running one included). */
export function queuedCount(content: Content, team: Team, upgrade: string): number {
  return queueOf(team, slotOf(content, upgrade)).filter((e) => e.upgrade === upgrade).length;
}

/** Price and duration of what queuing this upgrade would buy: the level it will be once everything queued ahead finishes. */
export function nextQueued(content: Content, team: Team, upgrade: string) {
  const def = content.upgrades[upgrade]!;
  const level = levelOf(team, upgrade) + queuedCount(content, team, upgrade) + 1;
  return { level, cost: def.cost * level, ticks: def.researchTicks * level };
}

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

/**
 * The team's tier once everything queued anywhere has finished: the current
 * one plus every core-tier entry waiting in either queue. A projected check
 * only: an entry still waits at the head of its queue until the tier is
 * actually there (see tickResearch).
 */
export function projectedTier(content: Content, team: Team): number {
  const id = tierUpgrade(content);
  return tierOf(content, team) + (id ? queuedCount(content, team, id) : 0);
}

/**
 * Why this research can't be queued, or null when it can. Requirements are
 * checked against the projected state: the team's current levels plus
 * everything already queued at both buildings — so you may queue a tier and
 * then the upgrade that needs it. Paying is part of queueing.
 */
export function canResearch(content: Content, team: Team, upgrade: string, world?: World): string | null {
  const def = content.upgrades[upgrade];
  if (!def) return "unknown upgrade";
  if (def.races && !def.races.includes(team.raceId)) return "not for your race";
  if (team.coreId === -1) return "no core";
  if (def.at === "center" && world && !centerOf(world, content, team)) {
    const id = content.races[team.raceId]?.center;
    return `needs a ${id ? content.buildings[id]!.name : "upgrade center"}`;
  }
  if (queueOf(team, slotOf(content, upgrade)).length >= RESEARCH_QUEUE) return "queue full";
  const next = nextQueued(content, team, upgrade);
  if (next.level > def.maxLevel) return "fully researched";
  const needs = def.tiers?.[next.level - 1];
  if (needs !== undefined && projectedTier(content, team) < needs) return `needs ${content.economy.tiers[needs]!.name}`;
  if (team.money < next.cost) return "not enough $";
  return null;
}

/** What the entry now researching paid when it was queued: its level is still pending. */
export function headPaid(content: Content, team: Team, head: { upgrade: string }): number {
  return content.upgrades[head.upgrade]!.cost * (levelOf(team, head.upgrade) + 1);
}

/**
 * Whether a queue entry may run at all: its level within maxLevel, and the
 * core tier it needs reached. `tier` is the tier that will hold when it gets
 * its turn (the current one plus everything queued ahead of it).
 */
function unmet(content: Content, def: { maxLevel: number; tiers?: number[] }, level: number, tier: number): string | null {
  if (level > def.maxLevel) return "fully researched";
  const needs = def.tiers?.[level - 1];
  if (needs !== undefined && tier < needs) return `needs ${content.economy.tiers[needs]!.name}`;
  return null;
}

/**
 * Cancel the entry at `index` (0 is the one researching) from a building's
 * queue and refund it in full. Every later entry whose requirement no longer
 * holds in the projected state without it — a tier that was only queued, a
 * level past max — is cancelled and refunded too. Returns a rejection reason,
 * or null when it was cancelled.
 */
export function cancelQueued(content: Content, team: Team, slot: Slot, index: number): string | null {
  const head = team[slot];
  if (index < 0 || index > queueOf(team, slot).length - 1) return "nothing to cancel";
  let refund = 0;
  const waiting = waitingOf(team, slot);
  const upgrade = index === 0 ? head!.upgrade : waiting[index - 1]!.upgrade;
  if (index === 0) {
    refund += headPaid(content, team, head!);
    team[slot] = null;
  }
  // Later levels of the same upgrade go with it: each was priced and timed
  // for the level it would be, so none may move up into the cancelled one's place.
  for (let i = waiting.length - 1; i >= Math.max(0, index - 1); i -= 1) {
    if (waiting[i]!.upgrade !== upgrade) continue;
    refund += waiting[i]!.paid;
    waiting.splice(i, 1);
  }
  // Without the cancelled entry, later entries may no longer be reachable:
  // a tier removal can starve entries at either building. A head that never
  // started (it waits for its tier) falls with them; one already counting
  // never fails the gate, so it can't be caught by this. Repeat until nothing
  // else falls over.
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of ["research", "labResearch"] as const) {
      const entries = queueOf(team, s);
      const levels = new Map<string, number>();
      for (const [i, entry] of entries.entries()) {
        // The level this entry will run as: the team's level, then every
        // entry of the same upgrade queued ahead of it.
        const level = (levels.get(entry.upgrade) ?? levelOf(team, entry.upgrade)) + 1;
        levels.set(entry.upgrade, level);
        if (unmet(content, content.upgrades[entry.upgrade]!, level, projectedTier(content, team))) {
          const head = i === 0 && team[s] ? team[s] : null;
          refund += head ? headPaid(content, team, head) : entry.paid!;
          if (head) team[s] = null;
          else waitingOf(team, s).splice(i - 1, 1);
          changed = true;
          break;
        }
      }
    }
  }
  team.money += refund;
  return null;
}

export function tickResearch(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const team of world.teams) {
    for (const slot of ["research", "labResearch"] as const) {
      const waiting = waitingOf(team, slot);
      // The building doing the research is gone (every core, or no finished
      // center): the whole queue is cancelled and refunded, the entry running
      // included — dropping it without a refund was the old behavior, and
      // refunding everything is the simpler rule to reason about.
      const home = slot === "research" ? ctx.byId.get(team.coreId) : centerOf(world, content, team);
      if (!home) {
        if (team[slot]) team.money += headPaid(content, team, team[slot]!);
        for (const entry of waiting) team.money += entry.paid;
        team[slot] = null;
        waiting.length = 0;
        continue;
      }
      // A waiting entry takes an empty slot. It may still wait there: an
      // entry never starts until its requirement is actually met, so one that
      // needs a core tier sits at the head, not counting down, until the core
      // finishes that tier.
      if (!team[slot] && waiting.length > 0) {
        const entry = waiting.shift()!;
        team[slot] = { upgrade: entry.upgrade, remaining: entry.ticks };
      }
      const research = team[slot];
      if (!research) continue;
      if (lagging(world, team.id)) continue;
      if (unmet(content, content.upgrades[research.upgrade]!, levelOf(team, research.upgrade) + 1, tierOf(content, team))) continue;
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
