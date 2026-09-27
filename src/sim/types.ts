import type { ArmorType, Controller } from "./content";
import type { Terrain } from "./terrain";

export type TeamId = 0 | 1;

export interface Team {
  id: TeamId;
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
export type UnitMode = "guard" | "roam";

export interface Unit extends EntityBase {
  kind: "unit";
  mode: UnitMode;
  /** Pack this roamer wanders with, or -1. */
  packId: number;
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

export type Command = BuildCommand;

export interface WaveSpawn {
  tick: number;
  unit: string;
  packId: number;
  /** Tile the pack enters the map at. */
  col: number;
  row: number;
}

export interface WaveState {
  /** Index of the next wave to start. */
  nextIndex: number;
  nextWaveTick: number;
  /** Units scheduled to enter, sorted by tick. */
  pending: WaveSpawn[];
  nextPackId: number;
  /** Pack id -> index of the roam point it is heading for. */
  packs: Record<number, number>;
  /** Set when the last wave goes out: survive until this tick to win. */
  holdUntilTick: number | null;
}

export interface Outcome {
  winner: TeamId;
  reason: "core-destroyed" | "survived";
  tick: number;
}

/** Transient, render-only. Not part of the simulation state or its hash. */
export type SimEvent =
  | { type: "shot"; from: number; to: number; x1: number; y1: number; x2: number; y2: number; team: TeamId }
  | { type: "death"; id: number; x: number; y: number; team: TeamId }
  | { type: "wave"; index: number; name: string; packs: number }
  | { type: "rejected"; command: Command; reason: string };

/**
 * Derived, immutable, and regenerated from the seed. Excluded from the world
 * hash: two peers with the same seed always agree on it.
 */
export interface Navigation {
  /** Flow field toward each team's core, indexed by team id. */
  toCore: [Int32Array, Int32Array];
  /** Flow field toward each terrain roam point, same order. */
  toRoam: Int32Array[];
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
