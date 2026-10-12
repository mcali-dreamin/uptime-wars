// Upgrades: researched at the core, one at a time, and applied as
// multipliers wherever the stat is used. With nothing researched every
// multiplier is exactly 1, so upgrades change nothing until you buy them.

import { lagging } from "./economy";
import type { TickContext } from "./context";
import type { Content, UpgradeStat } from "./content";
import type { Team } from "./types";

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

export function levelOf(team: Team, upgrade: string): number {
  return team.upgrades[upgrade] ?? 0;
}

/** Price and duration of the next level. */
export function nextLevel(content: Content, team: Team, upgrade: string) {
  const def = content.upgrades[upgrade]!;
  const level = levelOf(team, upgrade) + 1;
  return { level, cost: def.cost * level, ticks: def.researchTicks * level };
}

/** Why this research can't start, or null when it can. */
export function canResearch(content: Content, team: Team, upgrade: string): string | null {
  const def = content.upgrades[upgrade];
  if (!def) return "unknown upgrade";
  if (team.coreId === -1) return "no core";
  if (team.research) return "already researching";
  if (levelOf(team, upgrade) >= def.maxLevel) return "fully researched";
  if (team.money < nextLevel(content, team, upgrade).cost) return "not enough $";
  return null;
}

export function tickResearch(ctx: TickContext): void {
  const { world } = ctx;
  for (const team of world.teams) {
    if (!team.research) continue;
    // Research stops if the core is gone.
    if (!ctx.byId.get(team.coreId)) {
      team.research = null;
      continue;
    }
    if (lagging(world, team.id)) continue;
    team.research.remaining -= 1;
    if (team.research.remaining > 0) continue;
    const upgrade = team.research.upgrade;
    team.upgrades[upgrade] = levelOf(team, upgrade) + 1;
    team.research = null;
    world.events.push({ type: "researched", team: team.id, upgrade, level: team.upgrades[upgrade]! });
  }
}
