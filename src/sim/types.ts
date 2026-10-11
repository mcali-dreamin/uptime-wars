import type { ArmorType, Controller } from "./content";
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
  compute: number;
  incomeTimer: number;
  coreId: number;
  /** Users currently served. Integer. */
  users: number;
  peakUsers: number;
  /** Fractions carried between seconds so nothing is lost to rounding. */
  revenueCarry: number;
  churnCarry: number;
  /** Researched level per upgrade id (absent = 0). */
  upgrades: Record<string, number>;
  /** What the core is researching right now, if anything. */
  research: { upgrade: string; remaining: number } | null;
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
  armorType: ArmorType;
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
  incomeTimer: number;
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

export type Command = BuildCommand | MoveCommand | FoundCommand | RallyCommand | ResearchCommand | AttackCommand | CastCommand | LearnCommand;

export interface WaveSpawn {
  tick: number;
  unit: string;
  packId: number;
  /** Wave number (1-based), which sets how tough the creep is. */
  wave: number;
}

export interface WaveState {
  /** Waves sent so far. The next wave is nextIndex + 1. */
  nextIndex: number;
  nextWaveTick: number;
  /** Units scheduled to enter, sorted by tick. */
  pending: WaveSpawn[];
  nextPackId: number;
  /** Pack id -> where it's heading: a roam point index, or a point it sensed. */
  packs: Record<number, number | Point>;

}

export interface Outcome {
  /** Every human team when the nest falls; the horde when every human team is down. */
  winners: TeamId[];
  reason: "nest-offline" | "all-offline";
  tick: number;
}

/** Transient, render-only. Not part of the simulation state or its hash. */
export type SimEvent =
  | { type: "shot"; from: number; to: number; x1: number; y1: number; x2: number; y2: number; team: TeamId }
  | { type: "death"; id: number; x: number; y: number; team: TeamId }
  | { type: "wave"; wave: number; name: string; packs: number; units: number; boss: boolean }
  | { type: "founded"; x: number; y: number }
  | { type: "failover"; team: TeamId; x: number; y: number }
  /** A team went offline while its allies play on. */
  | { type: "offline"; team: TeamId }
  | { type: "cast"; team: TeamId; ability: string; x: number; y: number; radius: number; targetId: number | null }
  | { type: "hero-level"; team: TeamId; level: number }
  | { type: "hero-down"; team: TeamId; respawnAt: number }
  | { type: "hero-up"; team: TeamId; x: number; y: number }
  | { type: "researched"; team: TeamId; upgrade: string; level: number }
  | { type: "rejected"; command: Command; reason: string };

/**
 * Route caches. Every field is a pure function of the terrain and a goal
 * tile, so peers that fill them at different times still agree. Excluded
 * from the world hash.
 */
export interface Navigation {
  /** Flow field toward a goal tile, keyed by tile index. Filled on demand by walkTo. */
  goals: Map<number, Int32Array>;
}

export interface World {
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
}
