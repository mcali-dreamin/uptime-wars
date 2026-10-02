// Unit behaviour. Every unit has a mode, and each mode is a behaviour module:
//
// - guard:   yours. Holds its home (spawn spot or rally point) and fights
//            anything that comes near or gets in its way there.
// - roam:    creeps. Wanders the web with its pack; senses your traffic;
//            attacks whatever it sees.
// - builder: your deploy agent. Walks where it's told and becomes the core.
//
// Adding a mode (heroes, burst-spawned serverless units, ...) means a new
// file exporting a Behavior and one line in BEHAVIORS below.

import type { TickContext } from "../context";
import type { UnitDef } from "../content";
import type { Unit, UnitMode } from "../types";
import { builder } from "./builder";
import { guard } from "./guard";
import { roam } from "./roam";

/** Shared, per-tick facts that more than one unit needs. */
export interface UnitTickState {
  /** Pack id -> its leader: the lowest-id living member. */
  leaders: Map<number, Unit>;
}

export type Behavior = (ctx: TickContext, unit: Unit, def: UnitDef, state: UnitTickState) => void;

const BEHAVIORS: Record<UnitMode, Behavior> = { guard, roam, builder };

export function tickUnits(ctx: TickContext): void {
  const { world, content } = ctx;
  const state: UnitTickState = { leaders: new Map() };
  // Entities are in id order, so the first member seen is the leader.
  for (const entity of world.entities) {
    if (entity.kind === "unit" && entity.hp > 0 && entity.packId >= 0 && !state.leaders.has(entity.packId)) {
      state.leaders.set(entity.packId, entity);
    }
  }
  for (const unit of world.entities) {
    if (unit.kind !== "unit" || unit.hp <= 0) continue;
    BEHAVIORS[unit.mode](ctx, unit, content.units[unit.defId]!, state);
  }
}
