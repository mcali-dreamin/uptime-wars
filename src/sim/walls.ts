// Buildings are solid: every standing building (or one under construction)
// blocks movement over its footprint, for its owner too. The pathfinder only
// knows terrain, so buildings are written into a per-match overlay on it
// (terrain.built) that walkability reads. Gates are the exception: they block
// everyone except their owner and allies, who walk through on a per-team view
// of the terrain with friendly gates left open. Whenever the buildings
// standing change, the overlay and views are rewritten, cached flow fields
// are dropped (they were computed for the old ones), and any unit the new
// ground leaves stranded (inside a building, or headed for a spot that's now
// inside one) is moved to the nearest place it fits. Everything here is a
// pure function of the entities, so peers stay in step.

import type { Content } from "./content";
import { TILE } from "./map";
import { bodyFits, nearestFit } from "./nav";
import { hostile } from "./teams";
import type { Terrain } from "./terrain";
import type { Entity, World } from "./types";

/** Rewrite the overlay (and gate views) if the buildings standing differ from last time. */
export function syncWalls(world: World, content: Content): void {
  const { terrain } = world;
  // Which buildings stand (and whose they are, for gates): cheap to compare
  // every tick, unlike the overlay itself.
  let key = "";
  for (const entity of world.entities) {
    if (entity.kind === "building" && entity.hp > 0) key += `${entity.id}:${entity.team},`;
  }
  if (key === world.nav.builtKey) return;
  world.nav.builtKey = key;
  const next = new Uint8Array(terrain.tiles.length);
  /** tile -> owning team + 1, for gates. */
  const gates = new Int16Array(terrain.tiles.length);
  let any = false;
  let anyGate = false;
  for (const entity of world.entities) {
    const def = content.buildings[entity.defId];
    if (entity.kind !== "building" || entity.hp <= 0 || !def) continue;
    for (let r = entity.row; r < entity.row + entity.footprint; r += 1) {
      for (let c = entity.col; c < entity.col + entity.footprint; c += 1) {
        next[r * terrain.cols + c] = 1;
        if (def.gate) gates[r * terrain.cols + c] = entity.team + 1;
      }
    }
    any = true;
    if (def.gate) anyGate = true;
  }
  const signature = anyGate ? gateSignature(gates) : "";
  const current = terrain.built;
  if (!any && !current) return;
  if (current && same(current, next) && signature === (world.nav.gateSignature ?? "")) return;
  terrain.built = any ? next : undefined;
  world.nav.gateSignature = signature;
  world.nav.goals.clear();
  world.nav.views = anyGate ? buildViews(world, terrain, next, gates) : undefined;
  settle(world);
}

/** Nobody stands in, or heads for, a building: move them to the nearest spot that fits. */
function settle(world: World): void {
  for (const unit of world.entities) {
    if (unit.kind !== "unit" || unit.hp <= 0) continue;
    const { terrain } = terrainFor(world, unit.team);
    const r = unit.radius;
    if (!bodyFits(terrain, unit.x, unit.y, r)) {
      const spot = nearestFit(terrain, unit.x, unit.y, r);
      if (spot) {
        unit.x = spot.x;
        unit.y = spot.y;
      }
    }
    if (!bodyFits(terrain, unit.homeX, unit.homeY, r)) {
      const home = nearestFit(terrain, unit.homeX, unit.homeY, r);
      if (home) {
        unit.homeX = home.x;
        unit.homeY = home.y;
      }
    }
    if (unit.moveTo && !unit.foundAt && !bodyFits(terrain, unit.moveTo.x, unit.moveTo.y, r)) {
      unit.moveTo = nearestFit(terrain, unit.moveTo.x, unit.moveTo.y, r) ?? unit.moveTo;
    }
  }
}

function gateSignature(gates: Int16Array): string {
  let s = "";
  for (let i = 0; i < gates.length; i += 1) if (gates[i]) s += `${i}:${gates[i]},`;
  return s;
}

/** One view per team that has a friendly gate: the overlay with those gates open. */
function buildViews(world: World, terrain: Terrain, built: Uint8Array, gates: Int16Array) {
  const views = new Map<number, { key: number; terrain: Terrain }>();
  for (const team of world.teams) {
    let open: Uint8Array | null = null;
    for (let i = 0; i < gates.length; i += 1) {
      const owner = gates[i]! - 1;
      if (owner < 0 || hostile(world, owner, team.id)) continue;
      open ??= built.slice();
      open[i] = 0;
    }
    if (open) views.set(team.id, { key: team.id + 1, terrain: { ...terrain, built: open } });
  }
  return views;
}

/** The terrain as a team's units see it: friendly gates open. */
export function terrainFor(world: World, team: number): { key: number; terrain: Terrain } {
  return world.nav.views?.get(team) ?? { key: 0, terrain: world.terrain };
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Is any unit's body on this footprint? A wall can't go down on top of someone. */
export function unitInTheWay(world: World, col: number, row: number, footprint: number): boolean {
  const left = col * TILE;
  const top = row * TILE;
  const size = footprint * TILE;
  return world.entities.some(
    (e: Entity) =>
      e.kind === "unit" &&
      e.hp > 0 &&
      e.x + e.radius > left &&
      e.x - e.radius < left + size &&
      e.y + e.radius > top &&
      e.y - e.radius < top + size,
  );
}
