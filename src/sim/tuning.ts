// Behaviour constants that aren't content. Content (units, buildings, races,
// waves) lives in src/content/*.json; these are the rules of motion and
// engagement shared by everything.

export const STARTING_MONEY = 200;
/** A trickle so you're never stuck. Users are the real income (see economy.json). */
export const BASE_INCOME = { amount: 2, intervalTicks: 20 };
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
/** Most units one order can carry (keeps a command small on the wire). */
export const MAX_ORDER_UNITS = 200;
/** A group ordered somewhere spreads over this many pixels per unit-ish, capped. */
export const ORDER_SPREAD_PER_UNIT = 9;
export const ORDER_SPREAD_MAX = 150;
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
/** From low ground you can only see up a cliff this close to the edge. */
export const LOW_GROUND_SIGHT = 72;
/** Attacking downhill hits this much harder. */
export const HIGH_GROUND_DAMAGE = 1.25;
/** A pack heading for sensed traffic counts as arrived this close to it. */
export const SENSED_ARRIVAL = 160;
/** A roaming pack reconsiders where it's going this often, in ticks. */
export const REROUTE_TICKS = 200;
