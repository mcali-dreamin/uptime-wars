// What the player has selected, and what a click on the map means because of
// it. Every "what does clicking here do?" question is answered in this file,
// so the input code, the cursor, the hint line, and the info panel agree.

import { TILE, TILE_RESOURCE, buildCost, canFound, canPlace, hostile, isCore, tileAt, type Content, type Entity, type Point, type Unit } from "../sim";
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
  /** Placing a building from the build bar. */
  | { kind: "place"; building: string }
  /** Choosing where the core goes. */
  | { kind: "found" }
  /** Aiming a hero ability: the next click picks its point or enemy. */
  | { kind: "cast"; ability: string };

export const NOTHING: Selection = { kind: "none" };

/** What right-clicking the ground does for this selection, as a short verb, or null. */
export function groundOrderLabel(session: Session, selection: Selection): string | null {
  if (selection.kind === "army") {
    if (armyUnits(session, selection).length === 0) return null;
    return selection.armed === "move" ? "Move here" : "Attack-move here";
  }
  const entity = selectedEntity(session, selection);
  if (!entity) return null;
  if (entity.kind === "unit") return entity.mode === "builder" || entity.mode === "hero" ? "Move here" : null;
  if (isCore(session.content, session.team, entity)) return "Set global rally";
  return session.content.buildings[entity.defId]!.spawn ? "Set rally" : null;
}

/** The order for right-clicking (or, for the deploy agent, clicking) the ground at `point`. */
export function groundOrder(session: Session, selection: Selection, point: Point): Order | null {
  if (selection.kind === "army") {
    const units = armyUnits(session, selection);
    if (units.length === 0) return null;
    return { type: "order", unitIds: units.map((u) => u.id), x: point.x, y: point.y, attack: selection.armed !== "move" };
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
  if (selection.kind === "army") return selection.armed !== undefined && armyUnits(session, selection).length > 0;
  const entity = selectedEntity(session, selection);
  if (!entity || !groundOrderLabel(session, selection)) return false;
  return (selection.kind === "entity" && selection.armed === true) || (entity.kind === "unit" && entity.mode === "builder");
}

/** The selection with its ground order armed, or null if it has none to arm. */
export function armed(session: Session, selection: Selection, how: "attack" | "move" = "attack"): Selection | null {
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

/** Every unit you can command. */
export function allSoldiers(session: Session): Unit[] {
  return session.world.entities.filter((e): e is Unit => isSoldier(session, e));
}

/** The ids a selection highlights. */
export function selectedIds(selection: Selection): number[] {
  return selection.kind === "army" ? selection.ids : selection.kind === "entity" ? [selection.id] : [];
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
    let col = Math.floor(point.x / TILE);
    let row = Math.floor(point.y / TILE);
    // Pumps snap onto a well next to the pointer: wells are one tile, hard to hit.
    if (def.onWell) {
      const well = nearbyWell(session, col, row);
      if (well) ({ col, row } = well);
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

/** The data well at or right next to a tile, if any. */
function nearbyWell(session: Session, col: number, row: number): { col: number; row: number } | null {
  const { terrain } = session.world;
  if (tileAt(terrain, col, row) === TILE_RESOURCE) return { col, row };
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (tileAt(terrain, col + dc, row + dr) === TILE_RESOURCE) return { col: col + dc, row: row + dr };
    }
  }
  return null;
}

export function affordable(session: Session, building: string): boolean {
  return session.team.compute >= buildCost(session.content, session.team.raceId, building);
}
