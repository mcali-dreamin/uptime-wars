// Map generation tuning.

export const BLOCK_THRESHOLD = 0.64;
export const SLOW_THRESHOLD = 0.34;
export const START_CLEAR_RADIUS = 5;
export const NEST_CLEAR_RADIUS = 3;
export const RESOURCE_COUNT = 140;
export const ROAM_POINT_COUNT = 64;
export const ROAM_POINT_SPACING = 24;
/** The start is at least this fraction of the center-to-corner distance from the nest. */
export const START_MIN_FROM_NEST = 0.6;
/** Every map has this many starts, so a map is the same whoever plays it. */
export const MAX_PLAYERS = 4;
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
