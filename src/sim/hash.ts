import type { World } from "./types";

/**
 * FNV-1a over the serialized simulation state. Two peers (or a peer and a
 * verifying server) that agree on this hash at a tick are in sync.
 * Render-only events and seed-derived terrain/navigation are excluded.
 */
export function hashWorld(world: World): string {
  const { events: _events, terrain: _terrain, nav: _nav, log: _log, ...state } = world;
  return fnv1a(JSON.stringify(state));
}

/** Hash of the generated terrain, for checking map generation agrees. */
export function hashTerrain(world: World): string {
  const { tiles, ...rest } = world.terrain;
  return fnv1a(JSON.stringify(rest) + Array.from(tiles).join(""));
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
