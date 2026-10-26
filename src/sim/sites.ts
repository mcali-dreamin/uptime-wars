// Capturable sites ("derelict datacenters"): a neutral building at the center
// of every camp in the tiers neutrals.json -> sites lists. Pure territory: it
// gives its owner income and compute through the ordinary building paths and
// does nothing else. Where they stand is where those camps stand, so it is a
// pure function of the seed.
//
// Capture (once per tick, integers only):
// - Units that count: live player-side (human-controlled) units within
//   captureRadius, heroes and deploy agents included, decoys not. Horde and
//   camp units never capture (the AI doesn't contest sites yet).
// - They are grouped by alliance. Credit goes to the team with the most units
//   present in the group, ties to the lowest id.
// - A neutral site only advances while no guard of its camp lives AND exactly
//   one alliance is present. Two alliances: paused. Nobody: progress drains
//   at the same rate. A rival arriving drains the old progress to 0 first.
// - At captureTicks the site changes hands (transferOwnership).
// - An owned site can't be captured; it must be knocked down (dealDamage),
//   which hands it back to neutral at rearmPermille of its hp. While neutral
//   it mends, like camp guards.

import type { TickContext } from "./context";
import type { SitesDef } from "./content";
import { placeBuilding } from "./entities";
import { TICK_RATE } from "./map";
import { distance } from "./movement";
import { isSite, transferOwnership } from "./ownership";
import { allied, hostile, neutralTeam } from "./teams";
import type { CampSpot } from "./neutrals";
import type { Building, TeamId, World } from "./types";

/** Does the camp at this spot get a site? */
export function hasSite(sites: SitesDef, spot: CampSpot): boolean {
  return sites.tiers.includes(spot.tier);
}

/** Put a site at a camp's center (match start). Returns it. */
export function spawnSite(ctx: TickContext, spot: CampSpot, campId: number): Building | null {
  const { world, content } = ctx;
  const team = neutralTeam(world);
  const def = content.buildings[content.neutrals.sites.building];
  if (!team || !def) return null;
  // Footprint centered on the camp's center tile.
  const half = Math.floor(def.footprint / 2);
  const site = placeBuilding(world, content, team.id, content.neutrals.sites.building, spot.col - half, spot.row - half, true);
  site.campId = campId;
  ctx.byId.set(site.id, site);
  return site;
}

/** Is any guard of this camp still alive? */
function guarded(world: World, campId: number): boolean {
  return world.entities.some((e) => e.kind === "unit" && e.campId === campId && e.hp > 0);
}

/** The team a group of present units is credited to, and whether more than one alliance is there. */
function presence(ctx: TickContext, site: Building, radius: number): { alliances: number; credit: TeamId } {
  const { world } = ctx;
  const counts = new Map<TeamId, number>();
  for (const e of world.entities) {
    if (e.kind !== "unit" || e.hp <= 0 || e.mode === "decoy") continue;
    if (world.teams[e.team]?.controller !== "human" || world.teams[e.team]!.downTick !== null) continue;
    if (distance(e, site) > radius) continue;
    counts.set(e.team, (counts.get(e.team) ?? 0) + 1);
  }
  // Teams in id order: a group is keyed by its first (lowest) member.
  const groups: { lead: TeamId; total: number; best: TeamId; bestN: number }[] = [];
  for (const id of [...counts.keys()].sort((a, b) => a - b)) {
    const n = counts.get(id)!;
    const group = groups.find((g) => allied(world, g.lead, id));
    if (!group) groups.push({ lead: id, total: n, best: id, bestN: n });
    else {
      group.total += n;
      if (n > group.bestN) {
        group.best = id;
        group.bestN = n;
      }
    }
  }
  return { alliances: groups.length, credit: groups[0]?.best ?? -1 };
}

/** Every tick: capture progress on neutral sites; once a second, neutral sites mend. */
export function tickSites(ctx: TickContext): void {
  const { world, content } = ctx;
  const neutral = neutralTeam(world);
  if (!neutral) return;
  const sites = content.neutrals.sites;
  for (const site of world.entities) {
    if (site.kind !== "building" || site.hp <= 0 || !isSite(content, site) || site.team !== neutral.id) continue;
    if (world.tick % TICK_RATE === 0 && site.hp < site.maxHp) {
      site.hp = Math.min(site.maxHp, site.hp + Math.max(1, Math.round((site.maxHp * sites.regenPermillePerSecond) / 1000)));
    }
    if (site.campId !== undefined && guarded(world, site.campId)) continue;
    const { alliances, credit } = presence(ctx, site, sites.captureRadius);
    const progress = site.captureProgress ?? 0;
    if (alliances >= 2) continue;
    if (alliances === 0) {
      drain(site, progress);
      continue;
    }
    // A rival of whoever has the progress drains it first.
    if (progress > 0 && site.captureTeam !== undefined && hostile(world, site.captureTeam, credit)) {
      drain(site, progress);
      continue;
    }
    site.captureTeam = credit;
    site.captureProgress = progress + 1;
    if (site.captureProgress >= sites.captureTicks) transferOwnership(ctx, site, credit);
  }
}

function drain(site: Building, progress: number): void {
  if (progress <= 0) {
    site.captureTeam = undefined;
    return;
  }
  site.captureProgress = progress - 1;
  if (progress - 1 <= 0) {
    site.captureProgress = undefined;
    site.captureTeam = undefined;
  }
}

/** Standing sites a team holds. */
export function sitesHeld(world: World, content: TickContext["content"], teamId: TeamId): number {
  let n = 0;
  for (const e of world.entities) if (e.team === teamId && e.hp > 0 && isSite(content, e)) n += 1;
  return n;
}

