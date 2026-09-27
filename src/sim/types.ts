import type { ArmorType, Controller } from "./content";

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

export interface Unit extends EntityBase {
  kind: "unit";
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
}

export interface WaveState {
  /** Index of the next wave to start. */
  nextIndex: number;
  nextWaveTick: number;
  /** Units scheduled to enter, sorted by tick. */
  pending: WaveSpawn[];
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
  | { type: "wave"; index: number; name: string }
  | { type: "rejected"; command: Command; reason: string };

export interface World {
  tick: number;
  seed: number;
  rngState: number;
  nextId: number;
  teams: [Team, Team];
  /** Always kept in ascending id order: iteration order is part of determinism. */
  entities: Entity[];
  commands: Command[];
  waves: WaveState;
  outcome: Outcome | null;
  events: SimEvent[];
}
