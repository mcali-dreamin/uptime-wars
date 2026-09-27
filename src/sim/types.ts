import type { ArmorType, Controller } from "./content";
import type { Terrain } from "./terrain";

export type TeamId = 0 | 1;

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
export type UnitMode = "guard" | "roam" | "builder";

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

/** Walk the builder to a point. */
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

export type Command = BuildCommand | MoveCommand | FoundCommand | RallyCommand;

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
  /** Pack id -> index of the roam point it is heading for. */
  packs: Record<number, number>;

}

export interface Outcome {
  winner: TeamId;
  reason: "core-destroyed";
  tick: number;
}

/** Transient, render-only. Not part of the simulation state or its hash. */
export type SimEvent =
  | { type: "shot"; from: number; to: number; x1: number; y1: number; x2: number; y2: number; team: TeamId }
  | { type: "death"; id: number; x: number; y: number; team: TeamId }
  | { type: "wave"; wave: number; name: string; packs: number; units: number; boss: boolean }
  | { type: "founded"; x: number; y: number }
  | { type: "rejected"; command: Command; reason: string };

/**
 * Derived, immutable, and regenerated from the seed. Excluded from the world
 * hash: two peers with the same seed always agree on it.
 */
export interface Navigation {
  /** Flow field toward each team's current builder order, by team id. */
  builderOrder: [Int32Array | null, Int32Array | null];
  /** Flow fields toward rally points, by goal tile. Filled on demand. */
  rally: Map<number, Int32Array>;
  /**
   * Flow field toward each terrain roam point, same order. Filled lazily the
   * first time a pack heads there: pure function of the terrain, so peers
   * computing at different times still agree.
   */
  toRoam: (Int32Array | null)[];
}

export interface World {
  tick: number;
  seed: number;
  rngState: number;
  terrain: Terrain;
  nav: Navigation;
  nextId: number;
  teams: [Team, Team];
  /** Always kept in ascending id order: iteration order is part of determinism. */
  entities: Entity[];
  commands: Command[];
  waves: WaveState;
  outcome: Outcome | null;
  events: SimEvent[];
}
