// What the player has selected, and what a click on the map means because of
// it. Every "what does clicking here do?" question is answered in this file,
// so the input code, the cursor, the hint line, and the info panel agree.

import { TILE, buildCost, type Building, canFound, canPlace, decommissionBlocker, decommissionRefund, dismissable, finishedCores, forkBlocker, hostile, isCore, isSite, MAX_ORDER_UNITS, tierBlocker, type Content, type Entity, type Point, type Unit, type GroundItem } from "../sim";
import { heroOf } from "../sim/heroes";
import type { Order, Session } from "./session";

/** A click this close to a ground item (px) means "pick it up". */
const DROP_CLICK_REACH = 32;

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
   * Several of your buildings (shift-click, double-click, or a box with no
   * units in it): spawners and functions, but also firewalls, racks, towers,
   * the upgrade center. Right-click sets one rally point for every rallied
   * building among them; `armed` makes the next left-click do it.
   */
  | { kind: "buildings"; ids: number[]; armed?: boolean }
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
  if (selection.kind === "buildings") return buildingGroup(session, selection).some((b) => isRallied(session, b)) ? "Set rally" : null;
  if (selection.kind === "army") {
    if (armyUnits(session, selection).length === 0) return armyHero(session, selection) ? "Move here" : null;
    return selection.armed === "move" ? "Move here" : "Attack-move here";
  }
  const entity = selectedEntity(session, selection);
  if (!entity) return null;
  if (entity.kind === "unit") return entity.mode === "builder" || entity.mode === "hero" ? "Move here" : null;
  if (isCore(session.content, session.team, entity)) return "Set rally";
  const def = session.content.buildings[entity.defId]!;
  return def.spawn || def.invoke ? "Set rally" : null;
}

/**
 * A ground item under a world point, closest first, if the player can see it.
 * Right-clicking one with the hero selected orders it picked up.
 */
export function groundItemAt(session: Session, point: Point, visible: (p: Point) => boolean = () => true): GroundItem | undefined {
  let best: GroundItem | undefined;
  let bestD = Infinity;
  for (const drop of session.world.groundItems) {
    if (!visible({ x: drop.x, y: drop.y })) continue;
    const dx = point.x - drop.x;
    const dy = point.y - drop.y;
    const d = dx * dx + dy * dy;
    if (d > DROP_CLICK_REACH * DROP_CLICK_REACH) continue;
    if (d < bestD) {
      best = drop;
      bestD = d;
    }
  }
  return best;
}

/**
 * The orders for right-clicking (or, for the deploy agent, clicking) the
 * ground at `point`: one, or a rally for each building in a group. With the
 * hero in the selection, a ground item under the point is picked up instead
 * of a plain move (the soldiers still attack-move there). Empty if none.
 */
export function groundOrders(session: Session, selection: Selection, point: Point, queue = false, visible: (p: Point) => boolean = () => true): Order[] {
  if (selection.kind === "buildings") return buildingGroup(session, selection).filter((b) => isRallied(session, b)).map((b) => ({ type: "rally", buildingId: b.id, x: point.x, y: point.y }));
  if (selection.kind === "army") {
    const orders = soldierOrders(session, selection, point, queue);
    // The hero marches with the group. It has no attack-move and no waypoint
    // queue, so it always gets a plain move to the same point — a shift-queued
    // order included (it just walks there right away, no queueing). A ground
    // item under the click is worth the detour: it goes and takes it.
    if (armyHero(session, selection)) {
      const drop = groundItemAt(session, point, visible);
      orders.push(drop ? { type: "pickUp", itemId: drop.id } : { type: "move", x: point.x, y: point.y });
    }
    return orders;
  }
  const order = groundOrder(session, selection, point, queue, visible);
  return order ? [order] : [];
}

/**
 * The `order` commands for an army's soldiers alone — no hero move. An army
 * with the hero in it moves it with groundOrders; right-clicking an enemy
 * sends these plus an `attack` for the hero instead.
 */
export function soldierOrders(session: Session, selection: Selection, point: Point, queue = false): Order[] {
  if (selection.kind !== "army") return [];
  // A command holds at most MAX_ORDER_UNITS units: a bigger army goes out
  // as several orders on the same tick, each spread for the whole group.
  const units = armyUnits(session, selection);
  const orders: Order[] = [];
  for (let i = 0; i < units.length; i += MAX_ORDER_UNITS) {
    orders.push({
      type: "order",
      unitIds: units.slice(i, i + MAX_ORDER_UNITS).map((u) => u.id),
      x: point.x,
      y: point.y,
      attack: selection.armed !== "move",
      ...(queue ? { queue: true } : {}),
      ...(units.length > MAX_ORDER_UNITS ? { group: units.length } : {}),
    });
  }
  return orders;
}

/**
 * The order for right-clicking (or, for the deploy agent, clicking) the ground
 * at `point`. Only the first part of a split group order: use groundOrders to send it.
 */
export function groundOrder(session: Session, selection: Selection, point: Point, queue = false, visible: (p: Point) => boolean = () => true): Order | null {
  if (selection.kind === "buildings" || selection.kind === "army") return groundOrders(session, selection, point, queue, visible)[0] ?? null;
  const entity = selectedEntity(session, selection);
  if (!entity || !groundOrderLabel(session, selection)) return null;
  if (entity.kind === "unit") {
    // The deploy agent walks by an order on its id: "move" means the hero
    // once a core is up, and this works before it and mid-match alike.
    if (entity.mode === "builder") return { type: "order", unitIds: [entity.id], x: point.x, y: point.y, attack: false };
    // The hero over a ground item: it goes and takes it (no passive pickup).
    if (entity.mode === "hero") {
      const drop = groundItemAt(session, point, visible);
      if (drop) return { type: "pickUp", itemId: drop.id };
    }
    return { type: "move", x: point.x, y: point.y };
  }
  return { type: "rally", buildingId: entity.id, x: point.x, y: point.y };
}

/**
 * Does a plain left-click on empty ground also issue the ground order? For the
 * deploy agent always; for anything else once it's armed (T or the panel button).
 */
export function leftClickOrders(session: Session, selection: Selection): boolean {
  if (selection.kind === "buildings") return selection.armed === true && groundOrderLabel(session, selection) !== null;
  if (selection.kind === "army") return selection.armed !== undefined && (armyUnits(session, selection).length > 0 || armyHero(session, selection) !== undefined);
  const entity = selectedEntity(session, selection);
  if (!entity || !groundOrderLabel(session, selection)) return false;
  return (selection.kind === "entity" && selection.armed === true) || (entity.kind === "unit" && entity.mode === "builder");
}

/** The selection with its ground order armed, or null if it has none to arm. */
export function armed(session: Session, selection: Selection, how: "attack" | "move" = "attack"): Selection | null {
  if (selection.kind === "buildings") return how === "attack" && groundOrderLabel(session, selection) !== null ? { kind: "buildings", ids: selection.ids, armed: true } : null;
  if (selection.kind === "army") return armyUnits(session, selection).length > 0 || armyHero(session, selection) !== undefined ? { kind: "army", ids: selection.ids, armed: how } : null;
  if (how === "move" || selection.kind !== "entity" || !groundOrderLabel(session, selection)) return null;
  return { kind: "entity", id: selection.id, armed: true };
}

export function selectedEntity(session: Session, selection: Selection): Entity | undefined {
  if (selection.kind !== "entity") return undefined;
  const entity = session.entity(selection.id);
  // A site can be looked at whoever holds it (the card shows who and what it gives); it takes no orders.
  return entity && (entity.team === session.local || isSite(session.content, entity)) ? entity : undefined;
}

/** A site under a world point, whoever holds it. */
export function siteAt(session: Session, point: Point): Building | undefined {
  for (const entity of session.world.entities) {
    if (entity.kind !== "building" || entity.hp <= 0 || !isSite(session.content, entity)) continue;
    const half = (entity.footprint * TILE) / 2;
    if (Math.abs(point.x - entity.x) <= half && Math.abs(point.y - entity.y) <= half) return entity;
  }
  return undefined;
}

/** A unit you can command: one of yours that fights (not the deploy agent). */
export function isSoldier(session: Session, entity: Entity | undefined): entity is Unit {
  return entity?.kind === "unit" && entity.team === session.local && entity.mode === "guard" && entity.hp > 0;
}

/** The living units of an army selection. The hero is not a soldier: see armyHero. */
export function armyUnits(session: Session, selection: Selection): Unit[] {
  if (selection.kind !== "army") return [];
  const wanted = new Set(selection.ids);
  return session.world.entities.filter((e): e is Unit => wanted.has(e.id) && isSoldier(session, e));
}

/**
 * The local hero when it belongs to an army selection: alive and among its
 * ids. An army may hold the hero (it moves with the group) next to its
 * soldiers, but the hero is never a soldier: it isn't dismissed, doesn't take
 * `order` commands, and a hero-only army has no attack-move.
 */
export function armyHero(session: Session, selection: Selection): Unit | undefined {
  if (selection.kind !== "army") return undefined;
  const hero = heroOf(session.world, session.team);
  return hero && selection.ids.includes(hero.id) ? hero : undefined;
}

/**
 * Select these unit ids as an army. The hero on its own becomes its entity
 * instead: its card, with its abilities, not a one-member army.
 */
export function armySelection(ids: number[], heroId?: number): Selection {
  if (ids.length === 0) return NOTHING;
  if (heroId !== undefined && ids.length === 1 && ids[0] === heroId) return { kind: "entity", id: heroId };
  return { kind: "army", ids };
}

/** A building of yours that takes a rally point of its own: a spawner or a function (not the core). */
export function isRallied(session: Session, entity: Entity | undefined): boolean {
  if (!entity || entity.kind !== "building" || entity.team !== session.local || entity.hp <= 0) return false;
  if (isCore(session.content, session.team, entity)) return false;
  const def = session.content.buildings[entity.defId]!;
  return Boolean(def.spawn || def.invoke);
}

/** A building of yours a click can group: finished or under construction, the core excepted (there is only one). */
export function groupable(session: Session, entity: Entity | undefined): boolean {
  return (
    entity?.kind === "building" && entity.team === session.local && entity.hp > 0 && !isCore(session.content, session.team, entity)
  );
}

/** The standing buildings of a building group. */
export function buildingGroup(session: Session, selection: Selection): Building[] {
  if (selection.kind !== "buildings") return [];
  const wanted = new Set(selection.ids);
  return session.world.entities.filter((e): e is Building => wanted.has(e.id) && e.kind === "building" && e.team === session.local && e.hp > 0);
}

/**
 * Select these buildings: none is nothing, one is that building (its full
 * card), more is a group.
 */
export function buildingSelection(ids: number[]): Selection {
  if (ids.length === 0) return NOTHING;
  if (ids.length === 1) return { kind: "entity", id: ids[0]! };
  return { kind: "buildings", ids };
}

/**
 * Shift-click on one of your buildings: add it to the selected building (or
 * group), or take it out if it's already in. Null if shift-click doesn't
 * group here (no building group selected, or it isn't one of yours).
 */
export function toggleBuilding(session: Session, selection: Selection, building: Entity): Selection | null {
  if (!groupable(session, building)) return null;
  const current =
    selection.kind === "buildings"
      ? selection.ids
      : selection.kind === "entity" && groupable(session, session.entity(selection.id))
        ? [selection.id]
        : null;
  if (!current) return null;
  return buildingSelection(current.includes(building.id) ? current.filter((id) => id !== building.id) : [...current, building.id]);
}

/**
 * Shift-click on one of your fighting units or your hero: add it to the
 * selected army (or take it out). A single unit selected counts as the group
 * of one; the hero alone collapses to its entity. Null if shift-click doesn't
 * group here (no army or unit of yours selected, or it isn't one that groups).
 */
export function toggleUnit(session: Session, selection: Selection, unit: Entity): Selection | null {
  const hero = heroOf(session.world, session.team);
  const selected = selectedEntity(session, selection);
  const current =
    selection.kind === "army"
      ? selection.ids
      : selection.kind === "entity" && (isSoldier(session, selected) || (hero !== undefined && selected?.id === hero.id))
        ? [selection.id]
        : null;
  if (!current || (!isSoldier(session, unit) && unit.id !== hero?.id)) return null;
  const ids = current.includes(unit.id) ? current.filter((id) => id !== unit.id) : [...current, unit.id];
  return armySelection(ids, hero?.id);
}

/** Every unit you can command. */
export function allSoldiers(session: Session): Unit[] {
  return session.world.entities.filter((e): e is Unit => isSoldier(session, e));
}

/**
 * An army selection's ids still worth having selected: the living soldiers,
 * plus the hero while it lives. Empty once everyone in it is gone. An army
 * down to just the hero prunes to `[hero.id]`, which its holder (the frame
 * loop) collapses to the hero's entity.
 */
export function livingArmyIds(session: Session, selection: Selection): number[] {
  if (selection.kind !== "army") return [];
  const hero = armyHero(session, selection);
  return [...armyUnits(session, selection).map((u) => u.id), ...(hero ? [hero.id] : [])];
}

/** The ids a selection highlights. */
export function selectedIds(selection: Selection): number[] {
  return selection.kind === "army" || selection.kind === "buildings" ? selection.ids : selection.kind === "entity" ? [selection.id] : [];
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
  return tierBlocker(session.content, session.team, building, have, finishedCores(session.world, session.content, session.team));
}

export function affordable(session: Session, building: string): boolean {
  return session.team.money >= buildCost(session.world, session.content, session.local, building);
}

/** What Delete would take away for this selection: the orders, and how to say it. */
export interface Removal {
  orders: Order[];
  /** "Decommission 3 buildings · +$450" */
  label: string;
  /** Identifies what's being removed, so a second Delete confirms the same thing. */
  key: string;
}

/**
 * Delete on a selection: your buildings are decommissioned (part of their
 * cost back; never a core), your fighting units dismissed (their compute
 * freed). The hero is never taken away: it isn't a soldier, so an army with
 * one in it dismisses its soldiers only, and a hero-only army dismisses
 * nothing. Null when there's nothing of yours to take away.
 */
export function removal(session: Session, selection: Selection): Removal | null {
  const { content, world } = session;
  const chunks = (ids: number[]) => Array.from({ length: Math.ceil(ids.length / MAX_ORDER_UNITS) }, (_, i) => ids.slice(i * MAX_ORDER_UNITS, (i + 1) * MAX_ORDER_UNITS));
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  let buildings: Building[] = [];
  let units: Unit[] = [];
  if (selection.kind === "army") units = armyUnits(session, selection);
  else if (selection.kind === "buildings") buildings = buildingGroup(session, selection);
  else {
    const entity = selectedEntity(session, selection);
    if (entity?.kind === "building") buildings = [entity];
    else if (entity?.kind === "unit") units = [entity];
  }
  buildings = buildings.filter((b) => decommissionBlocker({ world, content }, session.local, b) === null);
  units = units.filter((u) => dismissable(session.local, u));
  if (buildings.length > 0) {
    const refund = buildings.reduce((sum, b) => sum + decommissionRefund(content, b), 0);
    const what = buildings.length === 1 ? content.buildings[buildings[0]!.defId]!.name : plural(buildings.length, "building");
    return {
      orders: chunks(buildings.map((b) => b.id)).map((buildingIds) => ({ type: "decommission", buildingIds })),
      label: `Decommission ${what}${refund > 0 ? ` · +$${refund}` : ""}`,
      key: `b:${buildings.map((b) => b.id).join(",")}`,
    };
  }
  if (units.length > 0) {
    const what = units.length === 1 ? content.units[units[0]!.defId]!.name : plural(units.length, "unit");
    return {
      orders: chunks(units.map((u) => u.id)).map((unitIds) => ({ type: "dismiss", unitIds })),
      label: `Dismiss ${what}`,
      key: `u:${units.map((u) => u.id).join(",")}`,
    };
  }
  return null;
}
