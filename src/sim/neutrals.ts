// Neutral camps: guarded squads of "legacy hardware" at seeded spots, like
// creep camps in Warcraft 3. They belong to the neutral team (hostile to
// everyone, never plays), hold their ground in guard mode, and never attack
// first: hit one and the whole camp answers whoever did it, as far as the
// leash (GUARD_RADIUS) around home, then goes home. They mend while nothing
// hostile is near, so a camp can't be chipped down over several trips, and a
// cleared camp stays cleared. Bounty and hero XP use the usual kill paths.
//
// Where camps stand is a pure function of the terrain (so of the seed): every
// peer agrees and nothing about it needs to be stored.

import { canSee, nearestEnemy } from "./combat";
import type { TickContext } from "./context";
import type { NeutralsDef } from "./content";
import { spawnUnit } from "./entities";
import { fortressSpots, farmSpots } from "./fortress";
import { TICK_RATE, TILE } from "./map";
import { distance } from "./movement";
import { hostile, neutralTeam } from "./teams";
import { hasSite, spawnSite } from "./sites";
import type { Terrain, TilePoint } from "./terrain";
import { TILE_OPEN } from "./terrain/tiles";
import { CAMP_OPEN_RADIUS, CAMP_SPACING, CAMP_TOLERANCE, CAMP_UNIT_GAP, EXPANSION_CLEARANCE, GUARD_RADIUS } from "./tuning";
import type { Entity, Unit, World } from "./types";

export interface CampSpot extends TilePoint {
  /** Tier name, from the distance to the nearest start (see neutrals.json). */
  tier: string;
  /** The start this camp is placed for (always its nearest). */
  start: number;
}

/** Where the units of a camp stand, in units of CAMP_UNIT_GAP from its center. */
const FORMATION = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const;

/**
 * Camp centers (tiles), tier by tier, start by start. Each start gets
 * `count` camps of every tier at about that tier's distance from it
 * (within CAMP_TOLERANCE), so every start has the same camps at the same
 * range. Spots are open single-height ground, at least EXPANSION_CLEARANCE
 * from every start, the nest and its fortress, and CAMP_SPACING apart.
 */
export function campSpots(terrain: Terrain, neutrals: NeutralsDef): CampSpot[] {
  const { cols, rows, nest, starts } = terrain;
  const centers: TilePoint[] = starts.map((s) => ({ col: s.col + 1, row: s.row + 1 }));
  const avoid: TilePoint[] = [...centers, { col: nest.col + 1, row: nest.row + 1 }, ...fortressSpots(terrain), ...farmSpots(terrain)];
  const d2 = (a: TilePoint, b: TilePoint) => (a.col - b.col) * (a.col - b.col) + (a.row - b.row) * (a.row - b.row);
  const open = (p: TilePoint) => {
    const height = terrain.heights[p.row * cols + p.col];
    for (let r = p.row - CAMP_OPEN_RADIUS; r <= p.row + CAMP_OPEN_RADIUS; r += 1) {
      for (let c = p.col - CAMP_OPEN_RADIUS; c <= p.col + CAMP_OPEN_RADIUS; c += 1) {
        if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
        const i = r * cols + c;
        if (terrain.tiles[i] !== TILE_OPEN || terrain.heights[i] !== height) return false;
      }
    }
    return true;
  };
  const spots: CampSpot[] = [];
  for (const [tier, def] of Object.entries(neutrals.tiers)) {
    for (let start = 0; start < centers.length; start += 1) {
      const from = centers[start]!;
      const reach = def.fromStart + CAMP_TOLERANCE;
      for (let k = 0; k < def.count; k += 1) {
        let best: TilePoint | null = null;
        let bestOff = Infinity;
        for (let row = from.row - reach; row <= from.row + reach; row += 1) {
          for (let col = from.col - reach; col <= from.col + reach; col += 1) {
            if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
            const p = { col, row };
            const off = Math.abs(Math.sqrt(d2(p, from)) - def.fromStart);
            if (off > CAMP_TOLERANCE || off >= bestOff) continue;
            // Nearest to its own start, so the tier means what it says.
            if (centers.some((c, i) => i !== start && d2(p, c) < d2(p, from))) continue;
            if (avoid.some((a) => d2(p, a) < EXPANSION_CLEARANCE * EXPANSION_CLEARANCE)) continue;
            if (spots.some((s) => d2(p, s) < CAMP_SPACING * CAMP_SPACING)) continue;
            if (!open(p)) continue;
            best = p;
            bestOff = off;
          }
        }
        if (best) spots.push({ ...best, tier, start });
      }
    }
  }
  return spots;
}

/** Eight directions around a center (unit length, roughly), for standing guards around a site. */
const AROUND = [[1, 0], [0, 1], [-1, 0], [0, -1], [0.7, 0.7], [-0.7, 0.7], [-0.7, -0.7], [0.7, -0.7]] as const;
/** How far past a site's edge guards stand (px). */
const SITE_MARGIN = 36;

/** Put every camp's guards on the map (match start). A camp with a site gets it at its center and its guards around it. */
export function spawnCamps(ctx: TickContext): void {
  const { world, content } = ctx;
  const team = neutralTeam(world);
  if (!team) return;
  campSpots(world.terrain, content.neutrals).forEach((spot, campId) => {
    const cx = (spot.col + 0.5) * TILE;
    const cy = (spot.row + 0.5) * TILE;
    const site = hasSite(content.neutrals.sites, spot) ? spawnSite(ctx, spot, campId) : null;
    content.neutrals.tiers[spot.tier]!.units.forEach((unitId, i) => {
      let x: number;
      let y: number;
      if (site) {
        // Around the footprint, a second ring for a big camp; inside the leash.
        const [dx, dy] = AROUND[i % AROUND.length]!;
        const ring = site.radius * 1.4 + SITE_MARGIN + Math.floor(i / AROUND.length) * 2 * CAMP_UNIT_GAP;
        x = cx + dx * ring;
        y = cy + dy * ring;
      } else {
        const [dx, dy] = FORMATION[i % FORMATION.length]!;
        x = cx + dx * CAMP_UNIT_GAP;
        y = cy + dy * CAMP_UNIT_GAP;
      }
      const unit = spawnUnit(ctx, team.id, unitId, { x: cx, y: cy }, x, y, "guard");
      // Home is the camp center, whatever ground the unit was nudged onto.
      unit.homeX = cx;
      unit.homeY = cy;
      unit.campId = campId;
    });
  });
}

/** Has this camp unit been hit lately (by it or by a camp-mate)? */
function alerted(ctx: TickContext, unit: Unit): boolean {
  return unit.provokedAt !== undefined && ctx.world.tick - unit.provokedAt <= ctx.content.neutrals.alertTicks;
}

/**
 * Who a camp guard fights: only after the camp was hit, and only inside the
 * leash around home. The one who hit it first, else any unit in reach (a
 * building is a target only if it is the one shooting).
 */
export function neutralTarget(ctx: TickContext, unit: Unit, def: { aggro: number }): Entity | null {
  if (!alerted(ctx, unit)) return null;
  const home = { x: unit.homeX, y: unit.homeY };
  const inLeash = (e: Entity) => distance(e, home) <= GUARD_RADIUS;
  const provoker = unit.provokedBy === undefined ? undefined : ctx.byId.get(unit.provokedBy);
  if (provoker && provoker.hp > 0 && hostile(ctx.world, provoker.team, unit.team) && inLeash(provoker) && canSee(ctx, unit, provoker)) return provoker;
  return nearestEnemy(ctx, unit, def.aggro, (e) => e.kind === "unit" && e.mode !== "decoy" && inLeash(e));
}

/**
 * Every tick: a hit on one guard alerts the whole camp. Once a second: a
 * guard that isn't alerted and has nothing hostile within its leash of home
 * mends toward full.
 */
export function tickNeutrals(ctx: TickContext): void {
  const { world, content } = ctx;
  const team = neutralTeam(world);
  if (!team) return;
  const lead = new Map<number, Unit>();
  const guards: Unit[] = [];
  for (const e of world.entities) {
    if (e.kind !== "unit" || e.team !== team.id || e.hp <= 0 || e.campId === undefined) continue;
    guards.push(e);
    if (alerted(ctx, e) && (!lead.has(e.campId) || e.provokedAt! > lead.get(e.campId)!.provokedAt!)) lead.set(e.campId, e);
  }
  for (const unit of guards) {
    const first = lead.get(unit.campId!);
    if (first && (unit.provokedAt === undefined || unit.provokedAt < first.provokedAt!)) {
      unit.provokedBy = first.provokedBy;
      unit.provokedAt = first.provokedAt;
    }
  }
  if (world.tick % TICK_RATE !== 0) return;
  const rate = content.neutrals.regenPermillePerSecond;
  for (const unit of guards) {
    if (unit.hp >= unit.maxHp || alerted(ctx, unit) || hostileNear(world, unit)) continue;
    unit.hp = Math.min(unit.maxHp, unit.hp + Math.max(1, Math.round((unit.maxHp * rate) / 1000)));
  }
}

/** Is anything hostile to the camp alive within the leash of this guard's home? */
function hostileNear(world: World, unit: Unit): boolean {
  const home = { x: unit.homeX, y: unit.homeY };
  for (const e of world.entities) {
    if (e.hp <= 0 || !hostile(world, e.team, unit.team) || (e.kind === "unit" && e.mode === "decoy")) continue;
    if (distance(e, home) <= GUARD_RADIUS) return true;
  }
  return false;
}

/** The last guard of a camp just fell: say so (once), crediting the team that cleared it. */
export function clearedCamp(world: World, victim: Unit, by: number): void {
  if (victim.campId === undefined) return;
  if (world.entities.some((e) => e.kind === "unit" && e.campId === victim.campId && e.hp > 0)) return;
  world.events.push({ type: "campCleared", x: victim.homeX, y: victim.homeY, team: by });
}
