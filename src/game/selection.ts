// What the player has selected, and what a click on the map means because of
// it. Every "what does clicking here do?" question is answered in this file,
// so the input code, the cursor, the hint line, and the info panel agree.

import { TILE, buildCost, type Building, canFound, canPlace, forkBlocker, hostile, isCore, tierBlocker, type Content, type Entity, type Point, type Unit } from "../sim";
import type { Order, Session } from "./session";

export type Selection =
  | { kind: "none" }
  /**
   * One of your units or buildings. `armed`: the next left-click on the
   * ground gives its ground order (rally, walk), for players without a
   * convenient right button.
   */
  | { kind: "entity"; id: number; armed?: boolean }
  /**
   * A group of your fighting units (one or many). Right-click sends them
   * (attack-move); `armed` makes the next left-click do it, as an
   * attack-move (T) or a plain move that ignores enemies (F).
   */
  | { kind: "army"; ids: number[]; armed?: "attack" | "move" }
  /**
   * Several of your spawners and functions (shift-click, double-click, or a
   * box with no units in it). Right-click sets one rally point for all of
   * them; `armed` makes the next left-click do it.
   */
  | { kind: "spawners"; ids: number[]; armed?: boolean }
  /** Placing a building from the build bar. */
  /** `fork`: copying that building of yours (fork mechanic) instead of buying new. */
  | { kind: "place"; building: string; fork?: number }
  /** Choosing where the core goes. */
  | { kind: "found" }
  /** Aiming a hero ability: the next click picks its point or enemy. */
  | { kind: "cast"; ability: string };

export const NOTHING: Selection = { kind: "none" };

/** What right-clicking the ground does for this selection, as a short verb, or null. */
export function groundOrderLabel(session: Session, selection: Selection): string | null {
  if (selection.kind === "spawners") return spawnerGroup(session, selection).length > 0 ? "Set rally" : null;
  if (selection.kind === "army") {
    if (armyUnits(session, selection).length === 0) return null;
    return selection.armed === "move" ? "Move here" : "Attack-move here";
  }
  const entity = selectedEntity(session, selection);
  if (!entity) return null;
  if (entity.kind === "unit") return entity.mode === "builder" || entity.mode === "hero" ? "Move here" : null;
  if (isCore(session.content, session.team, entity)) return "Set global rally";
  const def = session.content.buildings[entity.defId]!;
  return def.spawn || def.invoke ? "Set rally" : null;
}

/**
 * The orders for right-clicking (or, for the deploy agent, clicking) the
 * ground at `point`: one, or a rally for each building in a group. Empty if none.
 */
export function groundOrders(session: Session, selection: Selection, point: Point, queue = false): Order[] {
  if (selection.kind === "spawners") return spawnerGroup(session, selection).map((b) => ({ type: "rally", buildingId: b.id, x: point.x, y: point.y }));
  const order = groundOrder(session, selection, point, queue);
  return order ? [order] : [];
}

/** The order for right-clicking (or, for the deploy agent, clicking) the ground at `point`. */
export function groundOrder(session: Session, selection: Selection, point: Point, queue = false): Order | null {
  if (selection.kind === "spawners") return groundOrders(session, selection, point, queue)[0] ?? null;
  if (selection.kind === "army") {
    const units = armyUnits(session, selection);
    if (units.length === 0) return null;
    return { type: "order", unitIds: units.map((u) => u.id), x: point.x, y: point.y, attack: selection.armed !== "move", ...(queue ? { queue: true } : {}) };
  }
  const entity = selectedEntity(session, selection);
  if (!entity || !groundOrderLabel(session, selection)) return null;
  if (entity.kind === "unit") return { type: "move", x: point.x, y: point.y };
  return { type: "rally", buildingId: entity.id, x: point.x, y: point.y };
}

/**
 * Does a plain left-click on empty ground also issue the ground order? For the
 * deploy agent always; for anything else once it's armed (T or the panel button).
 */
export function leftClickOrders(session: Session, selection: Selection): boolean {
  if (selection.kind === "spawners") return selection.armed === true && spawnerGroup(session, selection).length > 0;
  if (selection.kind === "army") return selection.armed !== undefined && armyUnits(session, selection).length > 0;
  const entity = selectedEntity(session, selection);
  if (!entity || !groundOrderLabel(session, selection)) return false;
  return (selection.kind === "entity" && selection.armed === true) || (entity.kind === "unit" && entity.mode === "builder");
}

/** The selection with its ground order armed, or null if it has none to arm. */
export function armed(session: Session, selection: Selection, how: "attack" | "move" = "attack"): Selection | null {
  if (selection.kind === "spawners") return how === "attack" && spawnerGroup(session, selection).length > 0 ? { kind: "spawners", ids: selection.ids, armed: true } : null;
  if (selection.kind === "army") return armyUnits(session, selection).length > 0 ? { kind: "army", ids: selection.ids, armed: how } : null;
  if (how === "move" || selection.kind !== "entity" || !groundOrderLabel(session, selection)) return null;
  return { kind: "entity", id: selection.id, armed: true };
}

export function selectedEntity(session: Session, selection: Selection): Entity | undefined {
  if (selection.kind !== "entity") return undefined;
  const entity = session.entity(selection.id);
  return entity && entity.team === session.local ? entity : undefined;
}

/** A unit you can command: one of yours that fights (not the deploy agent). */
export function isSoldier(session: Session, entity: Entity | undefined): entity is Unit {
  return entity?.kind === "unit" && entity.team === session.local && entity.mode === "guard" && entity.hp > 0;
}

/** The living units of an army selection. */
export function armyUnits(session: Session, selection: Selection): Unit[] {
  if (selection.kind !== "army") return [];
  const wanted = new Set(selection.ids);
  return session.world.entities.filter((e): e is Unit => wanted.has(e.id) && isSoldier(session, e));
}

/** A building of yours that takes a rally point of its own: a spawner or a function (not the core). */
export function isRallied(session: Session, entity: Entity | undefined): boolean {
  if (!entity || entity.kind !== "building" || entity.team !== session.local || entity.hp <= 0) return false;
  if (isCore(session.content, session.team, entity)) return false;
  const def = session.content.buildings[entity.defId]!;
  return Boolean(def.spawn || def.invoke);
}

/** The standing buildings of a spawner group. */
export function spawnerGroup(session: Session, selection: Selection): Building[] {
  if (selection.kind !== "spawners") return [];
  const wanted = new Set(selection.ids);
  return session.world.entities.filter((e): e is Building => wanted.has(e.id) && isRallied(session, e));
}

/**
 * Select these spawners: none is nothing, one is that building (its full
 * card), more is a group.
 */
export function spawnerSelection(ids: number[]): Selection {
  if (ids.length === 0) return NOTHING;
  if (ids.length === 1) return { kind: "entity", id: ids[0]! };
  return { kind: "spawners", ids };
}

/**
 * Shift-click on one of your spawners: add it to the selected spawner (or
 * group), or take it out if it's already in. Null if shift-click doesn't
 * group here (nothing rallied selected, or it isn't a spawner).
 */
export function toggleSpawner(session: Session, selection: Selection, building: Entity): Selection | null {
  if (!isRallied(session, building)) return null;
  const current =
    selection.kind === "spawners"
      ? selection.ids
      : selection.kind === "entity" && isRallied(session, session.entity(selection.id))
        ? [selection.id]
        : null;
  if (!current) return null;
  return spawnerSelection(current.includes(building.id) ? current.filter((id) => id !== building.id) : [...current, building.id]);
}

/** Every unit you can command. */
export function allSoldiers(session: Session): Unit[] {
  return session.world.entities.filter((e): e is Unit => isSoldier(session, e));
}

/** The ids a selection highlights. */
export function selectedIds(selection: Selection): number[] {
  return selection.kind === "army" || selection.kind === "spawners" ? selection.ids : selection.kind === "entity" ? [selection.id] : [];
}

/** An enemy the local player can see under a world point, if any. Units first: they're what you aim at. */
export function enemyAt(session: Session, point: Point, visible: (p: Point) => boolean): Entity | undefined {
  let best: Entity | undefined;
  let bestD = Infinity;
  for (const entity of session.world.entities) {
    if (entity.hp <= 0 || !hostile(session.world, entity.team, session.local)) continue;
    if (!visible(entity)) continue;
    const reach = entity.kind === "building" ? (entity.footprint * TILE) / 2 + 6 : entity.radius + 14;
    const dx = point.x - entity.x;
    const dy = point.y - entity.y;
    const d = dx * dx + dy * dy;
    if (d > reach * reach) continue;
    const score = d + (entity.kind === "building" ? 1e6 : 0);
    if (score < bestD) {
      best = entity;
      bestD = score;
    }
  }
  return best;
}

/** Your own unit or building under a world point, if any. */
export function ownEntityAt(session: Session, point: Point): Entity | undefined {
  for (const entity of session.world.entities) {
    if (entity.team !== session.local || entity.hp <= 0) continue;
    if (entity.kind === "building") {
      const half = (entity.footprint * TILE) / 2;
      if (Math.abs(point.x - entity.x) <= half && Math.abs(point.y - entity.y) <= half) return entity;
    } else {
      const reach = entity.radius + 8;
      const dx = point.x - entity.x;
      const dy = point.y - entity.y;
      if (dx * dx + dy * dy <= reach * reach) return entity;
    }
  }
  return undefined;
}

export interface Placement {
  col: number;
  row: number;
  footprint: number;
  valid: boolean;
  /** Attack range to preview, in pixels. */
  range: number;
  order: Order;
}

/** Where a placement selection would put its building for a pointer at `point`. */
export function placementAt(
  session: Session,
  content: Content,
  selection: Selection,
  point: Point,
  explored: (p: Point) => boolean,
): Placement | null {
  if (selection.kind === "found") {
    const def = content.buildings[session.race.core]!;
    // Center the footprint on the pointer.
    const col = Math.round(point.x / TILE) - def.footprint / 2;
    const row = Math.round(point.y / TILE) - def.footprint / 2;
    const valid = canFound(session.world, content, session.local, col, row) === null && explored(point);
    return { col, row, footprint: def.footprint, valid, range: def.attack?.range ?? 0, order: { type: "found", col, row } };
  }
  if (selection.kind === "place") {
    const def = content.buildings[selection.building]!;
    const col = Math.floor(point.x / TILE);
    const row = Math.floor(point.y / TILE);
    if (selection.fork !== undefined) {
      const source = session.entity(selection.fork);
      const valid = forkBlocker(session.world, content, session.local, source?.kind === "building" ? source : undefined, col, row) === null;
      return { col, row, footprint: def.footprint, valid, range: def.attack?.range ?? 0, order: { type: "fork", sourceId: selection.fork, col, row } };
    }
    const valid = canPlace(session.world, content, session.local, selection.building, col, row) === null;
    return {
      col,
      row,
      footprint: def.footprint,
      valid,
      range: def.attack?.range ?? 0,
      order: { type: "build", building: selection.building, col, row },
    };
  }
  return null;
}

/** Why your core tier keeps you from building this right now, or null. */
export function tierLock(session: Session, building: string): string | null {
  const have = session.world.entities.filter((e) => e.kind === "building" && e.team === session.local && e.defId === building && e.hp > 0).length;
  return tierBlocker(session.content, session.team, building, have);
}

export function affordable(session: Session, building: string): boolean {
  return session.team.money >= buildCost(session.world, session.content, session.local, building);
}
