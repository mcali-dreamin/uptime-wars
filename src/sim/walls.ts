// Buildings that block movement (walls). The pathfinder only knows terrain,
// so walls are written into a per-match overlay on it (terrain.built) that
// walkability reads. Whenever the set of standing walls changes, the overlay
// is rewritten and cached flow fields are dropped: they were computed for
// the old walls. Everything here is a pure function of the entities, so
// peers stay in step.

import type { Content } from "./content";
import { TILE } from "./map";
import type { Entity, World } from "./types";

/** Rewrite the overlay if the walls standing differ from last time. */
export function syncWalls(world: World, content: Content): void {
  const { terrain } = world;
  const next = new Uint8Array(terrain.tiles.length);
  let any = false;
  for (const entity of world.entities) {
    if (entity.kind !== "building" || entity.hp <= 0 || !content.buildings[entity.defId]?.blocks) continue;
    for (let r = entity.row; r < entity.row + entity.footprint; r += 1) {
      for (let c = entity.col; c < entity.col + entity.footprint; c += 1) next[r * terrain.cols + c] = 1;
    }
    any = true;
  }
  const current = terrain.built;
  if (!any && !current) return;
  if (current && same(current, next)) return;
  terrain.built = any ? next : undefined;
  world.nav.goals.clear();
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
