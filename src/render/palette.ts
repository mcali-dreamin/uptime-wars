// Colours shared by every world view, so 2D and 3D read the same.

import { TILE_BLOCKED, TILE_CLIFF, type TeamId, type World } from "../sim";

/** Player n's default colour (co-op: up to four), and the horde's (always red). */
export const PLAYER_COLORS = [0x4ade80, 0x60a5fa, 0xc084fc, 0xfb923c] as const;
export const HORDE_COLOR = 0xf87171;
/** Camp guards (the neutral team): muted amber, apart from every player and the horde. */
export const NEUTRAL_COLOR = 0xb08d57;
/** Camp markers on the minimap, by tier: how hard a camp is at a glance (like WC3's green/orange/red). */
export const CAMP_TIER_COLORS: Record<string, number> = { near: 0xa3e635, mid: 0xf59e0b, far: 0xef4444 };

/**
 * Colours picked before the match, by team. Render-only: each browser picks
 * its own player's colour, and the sim never sees it.
 */
const chosen = new Map<TeamId, number>();

/** The local player picked a colour. An ally whose default matches it takes the local default instead. */
export function setLocalColor(team: TeamId, hex: number): void {
  chosen.clear();
  chosen.set(team, hex);
  const clash = PLAYER_COLORS.findIndex((c, i) => c === hex && i !== team % PLAYER_COLORS.length);
  if (clash >= 0) chosen.set(clash, PLAYER_COLORS[team % PLAYER_COLORS.length]!);
}

export function teamColor(world: World, team: TeamId): number {
  const controller = world.teams[team]?.controller;
  if (controller === "neutral") return NEUTRAL_COLOR;
  if (controller !== "human") return HORDE_COLOR;
  return chosen.get(team) ?? PLAYER_COLORS[team % PLAYER_COLORS.length]!;
}
/** Selection, rally flags, order pings, range previews. */
export const HIGHLIGHT = 0xfacc15;
export const VALID = 0x4ade80;
export const INVALID = 0xf87171;

// 2075, matching the 3D world (minimap and the flat ?2d view): the violet
// undercity, the graphite deck, titanium backbone; dead links are black
// ruins, cliff lips lit cyan, ramps amber.
export const FLOOR = [0x150d24, 0x1c2430, 0x394150] as const;
export const DEAD_LINK = 0x06070b;
export const DEAD_LINK_EDGE = 0x5a1a28;
export const CLIFF = 0x05070a;
export const CLIFF_LIP = 0x67c7e0;
export const RAMP_STRIPE = 0x8a5f22;

export function tileColor(tile: number, height: number): number {
  switch (tile) {
    case TILE_BLOCKED:
      return DEAD_LINK;
    case TILE_CLIFF:
      return CLIFF;
    default:
      return FLOOR[height]!;
  }
}
