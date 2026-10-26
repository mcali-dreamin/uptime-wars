// Colours shared by every world view, so 2D and 3D read the same.

import { TILE_BLOCKED, TILE_CLIFF, type TeamId, type World } from "../sim";

/** Player n's default colour (co-op: up to four), and the horde's (always red). */
export const PLAYER_COLORS = [0x4ade80, 0x60a5fa, 0xc084fc, 0xfb923c] as const;
export const HORDE_COLOR = 0xf87171;
/** Camp guards (the neutral team): muted amber, apart from every player and the horde. */
export const NEUTRAL_COLOR = 0xb08d57;

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

export const FLOOR = [0x0a0f14, 0x17222d, 0x253545] as const;
export const DEAD_LINK = 0x3b4a5c;
export const DEAD_LINK_EDGE = 0x7d8fa3;
export const CLIFF = 0x070a0e;
export const CLIFF_LIP = 0x9fb3c8;
export const RAMP_STRIPE = 0x2f4254;

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
