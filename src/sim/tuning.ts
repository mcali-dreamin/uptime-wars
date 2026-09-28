// Behaviour constants that aren't content. Content (units, buildings, races,
// waves) lives in src/content/*.json; these are the rules of motion and
// engagement shared by everything.

export const STARTING_COMPUTE = 200;
export const BASE_INCOME = { amount: 3, intervalTicks: 20 };
/** Construction starts at this fraction of max hp and fills as it builds. */
export const CONSTRUCTION_START_HP = 0.25;
/** A unit drops a target that runs this far past its sight. */
export const LEASH_MULTIPLIER = 1.5;
/** Guards defend this far around their home (spawn spot or rally point). */
export const GUARD_RADIUS = 220;
/** Guards within this distance of home count as home. */
export const HOME_SLACK = 24;
/** Units gathering at a rally point spread over this many pixels either way. */
export const RALLY_SPREAD = 40;
/** Roamers amble rather than march. */
export const ROAM_SPEED = 0.6;
/** A pack member further than this from its leader catches up first. */
export const PACK_SPREAD = 90;
/** Buildings are big: a roamer spots one from this far, further than a unit. */
export const BUILDING_SIGHT = 700;
/** A builder heading to a founding site stops when this close to its center. */
export const FOUND_REACH = 72;
/** A builder on a plain move order stops when this close. */
export const MOVE_REACH = 6;
