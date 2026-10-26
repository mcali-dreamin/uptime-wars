// Behaviour constants that aren't content. Content (units, buildings, races,
// waves) lives in src/content/*.json; these are the rules of motion and
// engagement shared by everything.

/** Shift-queued orders a unit holds at most. */
export const MAX_WAYPOINTS = 16;
/** Entries a research queue holds at most: the one researching plus this minus 1 waiting (WC3 style). */
export const RESEARCH_QUEUE = 5;
export const STARTING_MONEY = 200;
/** A trickle so you're never stuck. Users are the real income (see economy.json). */
export const BASE_INCOME = { amount: 2, intervalTicks: 20 };
/** Construction starts at this fraction of max hp and fills as it builds. */
export const CONSTRUCTION_START_HP = 0.25;
/** A unit drops a target that runs this far past its sight. */
export const LEASH_MULTIPLIER = 1.5;
/** A creep that was hit this recently turns on whoever hit it. */
export const PROVOKED_TICKS = 40;
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

/** A pocket of ground this small (tiles) may be closed off by a building: it then counts as built over. */
export const NOTCH_TILES = 4;
/** A foundable expansion keeps this many tiles (center to center) of open water between it and any hostile building. */
export const EXPANSION_CLEARANCE = 12;

/** Neutral camps: a camp's spot is within this many tiles of its tier's distance from the nearest start (the fairness tolerance)... */
export const CAMP_TOLERANCE = 8;
/** ...keeps this many tiles between camp centers... */
export const CAMP_SPACING = 10;
/** ...and needs open, single-height ground this many tiles round its center. */
export const CAMP_OPEN_RADIUS = 3;
/** Units of a camp stand this many pixels apart round its center. */
export const CAMP_UNIT_GAP = 16;
