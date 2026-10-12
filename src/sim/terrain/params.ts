// Map generation tuning.

export const BLOCK_THRESHOLD = 0.64;
export const START_CLEAR_RADIUS = 5;
export const NEST_CLEAR_RADIUS = 3;
/** The nest's fortress: a backbone plateau this many tiles in radius... */
export const FORTRESS_RADIUS = 9;
/** ...ringed by a surface-web moat this wide, so its rim is always a cliff... */
export const MOAT_WIDTH = 3;
/** ...with at least this many ramps up onto it, spread around the rim. */
export const FORTRESS_GATES = 3;
export const GATE_SPACING = 9;
export const ROAM_POINT_COUNT = 64;
export const ROAM_POINT_SPACING = 24;
/** The start is at least this fraction of the center-to-corner distance from the nest. */
export const START_MIN_FROM_NEST = 0.6;
/** Every map has this many starts, so a map is the same whoever plays it. */
export const MAX_PLAYERS = 4;
/** A campus per start, this many tiles from it (min, max). */
export const CAMPUS_RANGE = [13, 19] as const;
/** Metros: this many, this many tiles from the nest's center (min, max). */
export const METRO_COUNT = 4;
export const METRO_RANGE = [22, 40] as const;
/** No two hubs closer than this, and no hub this close to any start. */
export const HUB_SPACING = 14;
export const HUB_START_GAP = 10;
/** Ground cleared and flattened round each hub. */
export const HUB_CLEAR_RADIUS = 3;
/** Starts are at least this fraction of the center-to-corner distance apart (relaxed if the map can't fit them). */
export const START_SPACING = 0.75;
/** Height noise thresholds: above HIGH is backbone, above MID is surface web. */
export const HEIGHT_MID = 0.47;
export const HEIGHT_HIGH = 0.61;
/** Height features are this many times larger than wall features. */
export const HEIGHT_SCALE = 0.45;
/** Beyond the ramps connectivity needs, add this many more, spread out. */
export const EXTRA_RAMPS = 110;
export const RAMP_SPACING = 10;
