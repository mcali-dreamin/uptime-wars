import type { MatchMode } from "./teams";
import type { Controller } from "./content";
import type { Terrain } from "./terrain";

/** Index into world.teams. */
export type TeamId = number;

export interface Point {
  x: number;
  y: number;
}

export interface Team {
  id: TeamId;
  /** The builder unit before the core is founded, else -1. */
  builderId: number;
  /** Global rally point for every spawner without its own, set from the core. */
  rally: Point | null;
  raceId: string;
  controller: Controller;
  /** $: earned from users, spent on everything. */
  money: number;
  incomeTimer: number;
  coreId: number;
  /** Users currently served. Integer. */
  users: number;
  /** Compute overload in permille (0 = within capacity), refreshed once a second. */
  overload: number;
  /** A spawner of this team was held back by the compute cap this tick. */
  capped?: boolean;
  peakUsers: number;
  /** Fractions carried between seconds so nothing is lost to rounding. */
  revenueCarry: number;
  churnCarry: number;
  /** Researched level per upgrade id (absent = 0). */
  upgrades: Record<string, number>;
  /** What the core is researching right now, if anything. */
  research: { upgrade: string; remaining: number } | null;
  /** What the upgrade center is researching right now, if anything. */
  labResearch: { upgrade: string; remaining: number } | null;
  /**
   * The tick this team went offline (every core, or the builder before one),
   * else null. An offline team is out: its commands are ignored, but its
   * allies play on. This is also its uptime.
   */
  downTick: number | null;
  /** The hero unit this player picked (races with heroes), else null. */
  heroId: string | null;
  /** That hero's state, once the core is online. */
  hero: HeroState | null;
}

export interface HeroState {
  /** The hero unit, or -1 while it's dead or not yet spawned. */
  unitId: number;
  level: number;
  /** Total XP earned. */
  xp: number;
  /** Max hp at level 1 as spawned (race and upgrades included); levels add to it. */
  baseHp: number;
  /** Rank learned in each ability (absent = not learned). */
  ranks: Record<string, number>;
  /** Ticks until each ability can be cast again (absent = ready). */
  cooldowns: Record<string, number>;
  /** When a dead hero comes back, else null. */
  respawnAt: number | null;
  /** An enemy the player told the hero to attack. */
  focusId: number | null;
  /** A cast the hero is walking into range to make. */
  cast: { ability: string; x: number; y: number; targetId: number | null } | null;
  /** Decoys and summons, and when they vanish. */
  temps: { id: number; until: number }[];
  /** A buff ability running: extra damage fraction for every unit, until a tick. */
  buff: { amount: number; until: number } | null;
  /** A shield ability running: buildings near its point take less damage until a tick. */
  shield?: { x: number; y: number; radius: number; permille: number; until: number } | null;
  /** Function runs are free until this tick (a discount ability). */
  freeRunsUntil?: number;
}

interface EntityBase {
  id: number;
  team: TeamId;
  defId: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  armor: number;
  radius: number;
  attackCooldown: number;
  targetId: number | null;
}

/**
 * - guard: holds near home, fights what comes close (player units).
 * - roam:  wanders the map with its pack and attacks whatever it sees. Creeps
 *   never know where you are; they find you by running into you.
 */
export type UnitMode = "guard" | "roam" | "builder" | "hero" | "decoy";

export interface Unit extends EntityBase {
  kind: "unit";
  mode: UnitMode;
  /** Pack this roamer wanders with, or -1. */
  packId: number;
  /** Building that spawned this unit, or -1. Counts toward its maxAlive. */
  spawnerId: number;
  /** Builder orders: where it is walking, and the core footprint to found on arrival. */
  moveTo: { x: number; y: number } | null;
  foundAt: { col: number; row: number } | null;
  /** Where a guarding unit returns to when it has nothing to fight. */
  homeX: number;
  homeY: number;
  /**
   * A player's order in progress: "move" walks home ignoring enemies,
   * "attack" walks home fighting whatever it meets. Cleared on arrival.
   */
  order: "move" | "attack" | null;
  /** Ordered by its player at least once: its spawner's rally no longer moves it. */
  commanded: boolean;
  /** Serverless units go cold at this tick (absent: they don't). */
  expiresAt?: number;
  /** The last enemy that hit it, and when: creeps turn on whatever is shooting them. */
  provokedBy?: number;
  provokedAt?: number;
  /** Taunted (Sticky Sessions): goes for this unit, whatever else is shooting, until tauntedUntil. */
  tauntedBy?: number;
  tauntedUntil?: number;
  /** Slowed (a Legal Team hit it): acts every other tick until this tick. */
  slowedUntil?: number;
  /** Disarmed (can move, can't attack) / stunned (can't act) until this tick. */
  disarmedUntil?: number;
  stunnedUntil?: number;
  /** Trait bookkeeping: hits landed (crit), revive ready at, and a split child (doesn't split again). */
  hits?: number;
  reviveAt?: number;
  forked?: boolean;
  /** Scanners: what they spotted and when, until they report it. */
  spotted?: { tick: number; x: number; y: number; team: TeamId };
  /** Scanners: already reported, nothing more to do. */
  reported?: boolean;
}

export interface Building extends EntityBase {
  kind: "building";
  col: number;
  row: number;
  footprint: number;
  /** Ticks of construction left. 0 means operational. */
  buildRemaining: number;
  /** This spawner's own rally point; overrides the team's global one. */
  rally: Point | null;
  spawnTimer: number;
  /** A function's scale-up cooldown, in ticks (its standing squad uses spawnTimer). */
  scaleTimer?: number;
  incomeTimer: number;
  /** The last tick anything hit it (for self-repair). */
  lastHitTick: number;
  /** Jammed by a DDoS until this tick: no shooting, spawning, or running. */
  jammedUntil?: number;
}

export type Entity = Unit | Building;

export interface BuildCommand {
  type: "build";
  tick: number;
  team: TeamId;
  building: string;
  col: number;
  row: number;
}

/** Walk the builder (before the core) or the hero (after) to a point. */
export interface MoveCommand {
  type: "move";
  tick: number;
  team: TeamId;
  x: number;
  y: number;
}

/** Walk the builder to a 2x2 footprint and found the core there. */
export interface FoundCommand {
  type: "found";
  tick: number;
  team: TeamId;
  col: number;
  row: number;
}

/**
 * Set where a spawner's units gather. Targeting the core sets the team's
 * global rally point instead, used by every spawner without its own.
 */
export interface RallyCommand {
  type: "rally";
  tick: number;
  team: TeamId;
  buildingId: number;
  x: number;
  y: number;
}

/**
 * Send some of your units somewhere. `attack`: fight whatever they meet on
 * the way (attack-move); otherwise walk there ignoring enemies. They hold the
 * spot afterwards.
 */
export interface OrderCommand {
  type: "order";
  tick: number;
  team: TeamId;
  unitIds: number[];
  x: number;
  y: number;
  attack: boolean;
}

/** Start researching the next level of an upgrade at the core. */
export interface ResearchCommand {
  type: "research";
  tick: number;
  team: TeamId;
  upgrade: string;
}

/** Send the hero after one enemy. */
export interface AttackCommand {
  type: "attack";
  tick: number;
  team: TeamId;
  targetId: number;
}

/** Spend a skill point on an ability. */
export interface LearnCommand {
  type: "learn";
  tick: number;
  team: TeamId;
  ability: string;
}

/** Cast a hero ability at a point (point), an enemy (enemy), or the hero (self). */
export interface CastCommand {
  type: "cast";
  tick: number;
  team: TeamId;
  ability: string;
  x: number;
  y: number;
  targetId: number | null;
}

/** Invoke a serverless function now (if it's ready and you can pay). */
export interface InvokeCommand {
  type: "invoke";
  tick: number;
  team: TeamId;
  buildingId: number;
}

/** Copy one of your finished buildings for less (races with a fork mechanic). */
export interface ForkCommand {
  type: "fork";
  tick: number;
  team: TeamId;
  sourceId: number;
  col: number;
  row: number;
}

export type Command = ForkCommand | BuildCommand | MoveCommand | FoundCommand | RallyCommand | OrderCommand | ResearchCommand | AttackCommand | CastCommand | LearnCommand | InvokeCommand;

export interface WaveSpawn {
  tick: number;
  unit: string;
  packId: number;
  /** Wave number (1-based), which sets how tough the creep is. */
  wave: number;
  /** Where it enters (default: the nest), and a base it marches on (default: it wanders). */
  at?: Point;
  target?: Point;
}

export interface WaveState {
  /** Waves sent so far. The next wave is nextIndex + 1. */
  nextIndex: number;
  nextWaveTick: number;
  /** When the next background-traffic pack leaves, and when the trickle began (-1: not yet). */
  nextTrickleTick: number;
  trickleSince: number;
  /** Units scheduled to enter, sorted by tick. */
  pending: WaveSpawn[];
  nextPackId: number;
  /** Pack id -> where it's heading: a roam point index, or a point it sensed. */
  packs: Record<number, number | Point>;

}

export interface Outcome {
  /**
   * Co-op: every human team when the nest falls; the horde when every human
   * team is down. FFA: the last human team with a core up.
   */
  winners: TeamId[];
  reason: "nest-offline" | "all-offline" | "last-standing";
  tick: number;
}

/** Transient, render-only. Not part of the simulation state or its hash. */
export type SimEvent =
  | { type: "shot"; from: number; to: number; x1: number; y1: number; x2: number; y2: number; team: TeamId }
  | { type: "death"; id: number; x: number; y: number; team: TeamId; kind: Entity["kind"]; defId: string }
  /** A function ran: `units` spun up. `auto`: an enemy triggered it. */
  | { type: "invoked"; buildingId: number; team: TeamId; units: number; auto: boolean }
  /** A scanner got away with it: `packs` horde packs now march on (x, y). */
  | { type: "reported"; team: TeamId; x: number; y: number; packs: number }
  /** A short-lived unit's time ran out (not a kill: no bounty). */
  | { type: "expired"; id: number; x: number; y: number; team: TeamId }
  | { type: "wave"; wave: number; name: string; packs: number; units: number; boss: boolean; entries?: { team: TeamId; x: number; y: number }[] }
  /** The botnet put fallen C2 Servers back up. */
  | { type: "fortified"; wave: number; rebuilt: number }
  /** A Botnet Farm fell: `units` creeps retaliate against (x, y), where `team` hit it from. */
  | { type: "retaliation"; team: TeamId; x: number; y: number; units: number }
  /** The botnet rebuilt fallen Botnet Farms. */
  | { type: "farms-rebuilt"; wave: number; rebuilt: number }
  | { type: "founded"; x: number; y: number }
  | { type: "failover"; team: TeamId; x: number; y: number }
  /** A team went offline while its allies play on. */
  | { type: "offline"; team: TeamId }
  | { type: "cast"; team: TeamId; ability: string; x: number; y: number; radius: number; targetId: number | null }
  | { type: "hero-level"; team: TeamId; level: number }
  | { type: "hero-down"; team: TeamId; respawnAt: number }
  | { type: "hero-up"; team: TeamId; x: number; y: number }
  | { type: "revived"; id: number; x: number; y: number; team: TeamId }
  | { type: "researched"; team: TeamId; upgrade: string; level: number }
  | { type: "rejected"; command: Command; reason: string };

/**
 * Route caches. Every field is a pure function of the terrain and a goal
 * tile, so peers that fill them at different times still agree. Excluded
 * from the world hash.
 */
export interface Navigation {
  /**
   * Flow field toward a goal tile, keyed by view * tiles + goal tile (view 0
   * is the shared one). Filled on demand by walkTo.
   */
  goals: Map<number, Int32Array>;
  /**
   * Gates: per-team views of the terrain where friendly gates are open
   * (keyed by team id; absent when there are no gates). Pure function of
   * the entities, rebuilt with the walls.
   */
  views?: Map<number, { key: number; terrain: Terrain }>;
  /** What the views were built for (gate tiles and owners). */
  gateSignature?: string;
}

export interface World {
  /** co-op (humans together vs the horde) or ffa (everyone vs everyone). */
  mode: MatchMode;
  tick: number;
  seed: number;
  rngState: number;
  terrain: Terrain;
  nav: Navigation;
  nextId: number;
  /** Human teams first (player n is team n), then the horde. */
  teams: Team[];
  /** Always kept in ascending id order: iteration order is part of determinism. */
  entities: Entity[];
  commands: Command[];
  waves: WaveState;
  outcome: Outcome | null;
  events: SimEvent[];
  /**
   * Every command that took effect, in the order it did. With the seed and
   * setup it replays the match exactly (see simulate). Like events, it isn't
   * part of the state hash.
   */
  log: Command[];
}
