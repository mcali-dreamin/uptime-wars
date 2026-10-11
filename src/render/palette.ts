// Colours shared by every world view, so 2D and 3D read the same.

import { TILE_BLOCKED, TILE_CLIFF, TILE_SLOW, type TeamId, type World } from "../sim";

/** Player n's colour (co-op: up to four), and the horde's. */
export const PLAYER_COLORS = [0x4ade80, 0x60a5fa, 0xc084fc, 0xfb923c] as const;
export const HORDE_COLOR = 0xf87171;

export function teamColor(world: World, team: TeamId): number {
  return world.teams[team]?.controller === "human" ? PLAYER_COLORS[team % PLAYER_COLORS.length]! : HORDE_COLOR;
}
/** Selection, rally flags, order pings, range previews. */
export const HIGHLIGHT = 0xfacc15;
export const VALID = 0x4ade80;
export const INVALID = 0xf87171;

export const FLOOR = [0x0a0f14, 0x17222d, 0x253545] as const;
export const SWAMP = [0x0f2530, 0x14303b, 0x1a3a46] as const;
export const DEAD_LINK = 0x3b4a5c;
export const DEAD_LINK_EDGE = 0x7d8fa3;
export const CLIFF = 0x070a0e;
export const CLIFF_LIP = 0x9fb3c8;
export const RAMP_STRIPE = 0x2f4254;
export const WELL = 0x38bdf8;

export function tileColor(tile: number, height: number): number {
  switch (tile) {
    case TILE_BLOCKED:
      return DEAD_LINK;
    case TILE_CLIFF:
      return CLIFF;
    case TILE_SLOW:
      return SWAMP[height]!;
    default:
      return FLOOR[height]!;
  }
}
