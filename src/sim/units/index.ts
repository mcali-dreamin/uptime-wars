// Unit behaviour. Every unit has a mode, and each mode is a behaviour module:
//
// - guard:   yours. Holds its home (spawn spot or rally point) and fights
//            anything that comes near or gets in its way there.
// - roam:    creeps. Wanders the web with its pack; senses your traffic;
//            attacks whatever it sees.
// - builder: your deploy agent. Walks where it's told and becomes the core.
// - hero:    your hero. Does what you tell it (move, attack, cast); see heroes.ts.
// - decoy:   a honeypot a hero dropped. Doesn't move; creeps lured onto it stay.
//
// Adding a mode (heroes, burst-spawned serverless units, ...) means a new
// file exporting a Behavior and one line in BEHAVIORS below.

import type { TickContext } from "../context";
import type { UnitDef } from "../content";
import type { Unit, UnitMode } from "../types";
import { builder } from "./builder";
import { decoy } from "./decoy";
import { hero } from "./hero";
import { guard } from "./guard";
import { roam } from "./roam";
import { TICK_RATE } from "../map";
import { hostile } from "../teams";
import { effectiveDef, traitsFor } from "../traits";

/** Shared, per-tick facts that more than one unit needs. */
export interface UnitTickState {
  /** Pack id -> its leader: the lowest-id living member. */
  leaders: Map<number, Unit>;
}

export type Behavior = (ctx: TickContext, unit: Unit, def: UnitDef, state: UnitTickState) => void;

const BEHAVIORS: Record<UnitMode, Behavior> = { guard, roam, builder, hero, decoy };

/** Once a second: healers mend allied units and buildings around them. */
export function tickHealers(ctx: TickContext): void {
  const { world, content } = ctx;
  if (world.tick % TICK_RATE !== 0) return;
  for (const healer of world.entities) {
    if (healer.kind !== "unit" || healer.hp <= 0) continue;
    const heal = content.units[healer.defId]!.heal;
    if (!heal) continue;
    const amount = heal.perSecond * (traitsFor(content, world.teams[healer.team], healer.defId).healMult ?? 1);
    const r2 = heal.radius * heal.radius;
    for (const other of world.entities) {
      if (other.hp <= 0 || other.hp >= other.maxHp || hostile(world, other.team, healer.team)) continue;
      if (other.kind === "building" && other.buildRemaining > 0) continue;
      const dx = other.x - healer.x;
      const dy = other.y - healer.y;
      if (dx * dx + dy * dy <= r2) other.hp = Math.min(other.maxHp, other.hp + amount);
    }
  }
}

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
    // Stunned: does nothing. Slowed: half speed, half attack rate.
    if (unit.stunnedUntil !== undefined && world.tick < unit.stunnedUntil) continue;
    if (unit.slowedUntil !== undefined && world.tick < unit.slowedUntil && world.tick % 2 === 1) continue;
    BEHAVIORS[unit.mode](ctx, unit, effectiveDef(content, world.teams[unit.team], unit, content.units[unit.defId]!), state);
  }
}
