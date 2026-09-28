// What the player has selected, and what a click on the map means because of
// it. Every "what does clicking here do?" question is answered in this file,
// so the input code, the cursor, the hint line, and the info panel agree.

import { TILE, buildCost, canFound, canPlace, type Content, type Entity, type Point } from "../sim";
import { HUMAN, type Order, type Session } from "./session";

export type Selection =
  | { kind: "none" }
  /** One of your units or buildings. */
  | { kind: "entity"; id: number }
  /** Placing a building from the build bar. */
  | { kind: "place"; building: string }
  /** Choosing where the core goes. */
  | { kind: "found" };

export const NOTHING: Selection = { kind: "none" };

/** What right-clicking the ground does for this selection, as a short verb, or null. */
export function groundOrderLabel(session: Session, selection: Selection): string | null {
  const entity = selectedEntity(session, selection);
  if (!entity) return null;
  if (entity.kind === "unit") return entity.mode === "builder" ? "Walk here" : null;
  if (entity.id === session.team.coreId) return "Set global rally";
  return session.content.buildings[entity.defId]!.spawn ? "Set rally" : null;
}

/** The order for right-clicking (or, for the deploy agent, clicking) the ground at `point`. */
export function groundOrder(session: Session, selection: Selection, point: Point): Order | null {
  const entity = selectedEntity(session, selection);
  if (!entity || !groundOrderLabel(session, selection)) return null;
  if (entity.kind === "unit") return { type: "move", x: point.x, y: point.y };
  return { type: "rally", buildingId: entity.id, x: point.x, y: point.y };
}

/** Does a plain left-click on empty ground also issue the ground order? Only for the deploy agent. */
export function leftClickOrders(session: Session, selection: Selection): boolean {
  const entity = selectedEntity(session, selection);
  return entity?.kind === "unit" && entity.mode === "builder";
}

export function selectedEntity(session: Session, selection: Selection): Entity | undefined {
  if (selection.kind !== "entity") return undefined;
  const entity = session.entity(selection.id);
  return entity && entity.team === HUMAN ? entity : undefined;
}

/** Your own unit or building under a world point, if any. */
export function ownEntityAt(session: Session, point: Point): Entity | undefined {
  for (const entity of session.world.entities) {
    if (entity.team !== HUMAN || entity.hp <= 0) continue;
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
    const valid = canFound(session.world, content, HUMAN, col, row) === null && explored(point);
    return { col, row, footprint: def.footprint, valid, range: def.attack?.range ?? 0, order: { type: "found", col, row } };
  }
  if (selection.kind === "place") {
    const def = content.buildings[selection.building]!;
    const col = Math.floor(point.x / TILE);
    const row = Math.floor(point.y / TILE);
    const valid = canPlace(session.world, content, HUMAN, selection.building, col, row) === null;
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

export function affordable(session: Session, building: string): boolean {
  return session.team.compute >= buildCost(session.content, session.team.raceId, building);
}
