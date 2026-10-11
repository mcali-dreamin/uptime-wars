// Colours shared by every world view, so 2D and 3D read the same.

import { TILE_BLOCKED, TILE_CLIFF, TILE_SLOW } from "../sim";

/**
 * Team colours by team id. The player's (team 0) is chosen before each match
 * (see setTeamColor); the botnet is always red. Read it live, don't copy it.
 */
export const TEAM_COLORS: [number, number] = [0x4ade80, 0xf87171];

export function setTeamColor(team: 0 | 1, hex: number): void {
  TEAM_COLORS[team] = hex;
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
