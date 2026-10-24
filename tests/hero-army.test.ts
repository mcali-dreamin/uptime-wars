// The hero joins army selections (issue #145): it moves with the group, is
// never dismissed, and an army down to just the hero collapses to its card.

import { describe, expect, it } from "vitest";
import { createWorld, queueCommand, step, type Building, type Command, type Unit, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { heroOf } from "../src/sim/heroes";
import { ControlGroups } from "../src/game/groups";
import { armyHero, armySelection, armed, groundOrderLabel, groundOrders, leftClickOrders, livingArmyIds, removal, soldierOrders, toggleUnit } from "../src/game/selection";
import type { Session } from "../src/game/session";
import { content, SETUP } from "./fixtures";

/** Just what selection.ts reads off a Session: no browser needed. */
function fakeSession(world: World): Session {
  return {
    content,
    world,
    local: 0,
    get team() {
      return world.teams[0]!;
    },
    entity: (id: number) => world.entities.find((e) => e.id === id && e.hp > 0),
  } as unknown as Session;
}

/** A world with your hero at the core and two guards next to it. */
function base() {
  const world = createWorld(content, { ...SETUP, heroes: ["maintainer", null] });
  world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
  const core = world.entities.find((e): e is Building => e.id === world.teams[0]!.coreId)!;
  const ctx = makeContext(world, content);
  const soldiers = [0, 1].map((i) => spawnUnit(ctx, 0, "process", core, core.x + 80 + i * 20, core.y + 80, "guard"));
  const hero = heroOf(world, world.teams[0]!)!;
  return { world, core, soldiers, hero, session: fakeSession(world) };
}

function armyOf(hero: Unit, soldiers: Unit[]) {
  return { kind: "army" as const, ids: [hero.id, ...soldiers.map((s) => s.id)] };
}

describe("ground orders with the hero in the army", () => {
  it("sends the soldiers their order and the hero a plain move to the same point", () => {
    const { world, core, soldiers, hero, session } = base();
    const point = { x: core.x + 240, y: core.y + 80 };
    const orders = groundOrders(session, armyOf(hero, soldiers), point);
    const group = orders.filter((o) => o.type === "order");
    expect(group).toHaveLength(1);
    expect(group[0]!.type === "order" && group[0]!.unitIds).toEqual(soldiers.map((s) => s.id));
    expect(orders.filter((o) => o.type === "move")).toEqual([{ type: "move", x: point.x, y: point.y }]);
    for (const order of orders) queueCommand(world, { ...order, tick: world.tick, team: 0 } as Command);
    step(world, content);
    expect(world.events.some((e) => e.type === "rejected")).toBe(false);
    // The soldiers took the order (attack-move) at once; the hero walks there.
    expect(soldiers[0]!.order).toBe("attack");
    expect(Math.abs(soldiers[0]!.homeX - point.x)).toBeLessThan(80);
    for (let i = 0; i < 600 && Math.hypot(hero.x - point.x, hero.y - point.y) > 20; i += 1) step(world, content);
    expect(Math.hypot(hero.x - point.x, hero.y - point.y)).toBeLessThan(20);
  });

  it("a shift-queued order queues the soldiers but still sends the hero a plain move", () => {
    const { core, soldiers, hero, session } = base();
    const point = { x: core.x + 240, y: core.y + 80 };
    const orders = groundOrders(session, armyOf(hero, soldiers), point, true);
    expect(orders.some((o) => o.type === "order" && o.queue === true)).toBe(true);
    expect(orders.filter((o) => o.type === "move")).toEqual([{ type: "move", x: point.x, y: point.y }]);
  });

  it("F-armed (plain move): the soldiers ignore enemies and the hero moves all the same", () => {
    const { core, soldiers, hero, session } = base();
    const point = { x: core.x + 240, y: core.y + 80 };
    const army = { ...armyOf(hero, soldiers), armed: "move" as const };
    const orders = groundOrders(session, army, point);
    const group = orders.find((o) => o.type === "order");
    expect(group).toMatchObject({ attack: false, unitIds: soldiers.map((s) => s.id) });
    expect(orders.filter((o) => o.type === "move")).toEqual([{ type: "move", x: point.x, y: point.y }]);
  });

  it("right-clicking an enemy sends the soldiers' orders alone; the hero attack comes from the caller", () => {
    const { core, soldiers, hero, session } = base();
    const point = { x: core.x + 240, y: core.y + 80 };
    const orders = soldierOrders(session, armyOf(hero, soldiers), point);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.type === "order" && orders[0]!.unitIds).toEqual(soldiers.map((s) => s.id));
    expect(orders.some((o) => o.type === "move")).toBe(false);
  });

  it("an army down to its hero still moves: label, orders, arming, left-click", () => {
    const { soldiers, hero, session } = base();
    for (const s of soldiers) s.hp = 0;
    const army = { kind: "army" as const, ids: [hero.id] };
    expect(armyHero(session, army)?.id).toBe(hero.id);
    expect(groundOrderLabel(session, army)).toBe("Move here");
    const point = { x: hero.x + 40, y: hero.y };
    expect(groundOrders(session, army, point)).toEqual([{ type: "move", x: point.x, y: point.y }]);
    const ready = armed(session, army);
    expect(ready).toEqual({ kind: "army", ids: [hero.id], armed: "attack" });
    expect(leftClickOrders(session, ready!)).toBe(true);
  });

  it("an army with no one left has no ground order", () => {
    const { soldiers, hero, session } = base();
    for (const s of soldiers) s.hp = 0;
    hero.hp = 0;
    const army = { kind: "army" as const, ids: [hero.id] };
    expect(groundOrderLabel(session, army)).toBeNull();
    expect(groundOrders(session, army, { x: 0, y: 0 })).toEqual([]);
    expect(armed(session, army)).toBeNull();
  });
});

describe("removal never takes the hero", () => {
  it("Delete dismisses the soldiers of an army, never the hero", () => {
    const { soldiers, hero, session } = base();
    const plan = removal(session, armyOf(hero, soldiers));
    expect(plan!.label).toBe("Dismiss 2 units");
    expect(plan!.orders).toEqual([{ type: "dismiss", unitIds: soldiers.map((s) => s.id) }]);
  });

  it("a hero-only army has nothing for Delete to take", () => {
    const { soldiers, hero, session } = base();
    for (const s of soldiers) s.hp = 0;
    expect(removal(session, { kind: "army" as const, ids: [hero.id] })).toBeNull();
  });
});

describe("the army keeps the hero while it lives", () => {
  it("prunes the dead but keeps the hero id", () => {
    const { soldiers, hero, session } = base();
    const army = armyOf(hero, soldiers);
    expect(livingArmyIds(session, army)).toEqual([...soldiers.map((s) => s.id), hero.id]);
    soldiers[0]!.hp = 0;
    expect(livingArmyIds(session, army)).toEqual([soldiers[1]!.id, hero.id]);
    // Everyone but the hero: the frame loop collapses this to the hero's entity.
    soldiers[1]!.hp = 0;
    expect(livingArmyIds(session, army)).toEqual([hero.id]);
  });

  it("a fallen hero drops out like any dead unit", () => {
    const { soldiers, hero, session } = base();
    hero.hp = 0;
    expect(livingArmyIds(session, armyOf(hero, soldiers))).toEqual(soldiers.map((s) => s.id));
    expect(armyHero(session, armyOf(hero, soldiers))).toBeUndefined();
  });
});

describe("selection shapes and shift-click", () => {
  it("a box catching only the hero selects its entity, not a one-member army", () => {
    const { soldiers, hero } = base();
    expect(armySelection([hero.id], hero.id)).toEqual({ kind: "entity", id: hero.id });
    expect(armySelection([soldiers[0]!.id], hero.id)).toEqual({ kind: "army", ids: [soldiers[0]!.id] });
  });

  it("shift-click toggles the hero and soldiers in and out of the army", () => {
    const { core, soldiers, hero, session } = base();
    const [a, b] = soldiers;
    // The hero alone selected, shift-click a soldier: an army of both.
    expect(toggleUnit(session, { kind: "entity", id: hero.id }, a!)).toEqual({ kind: "army", ids: [hero.id, a!.id] });
    // Shift-click that soldier again: back to the hero's own card.
    expect(toggleUnit(session, { kind: "army", ids: [hero.id, a!.id] }, a!)).toEqual({ kind: "entity", id: hero.id });
    // Shift-click the hero out: the soldiers stay.
    expect(toggleUnit(session, { kind: "army", ids: [hero.id, a!.id] }, hero)).toEqual({ kind: "army", ids: [a!.id] });
    // Shift-click the hero into a soldier army.
    expect(toggleUnit(session, { kind: "army", ids: [a!.id] }, hero)).toEqual({ kind: "army", ids: [a!.id, hero.id] });
    // Soldiers group among themselves as before.
    expect(toggleUnit(session, { kind: "army", ids: [a!.id] }, b!)).toEqual({ kind: "army", ids: [a!.id, b!.id] });
    // Buildings don't group here.
    expect(toggleUnit(session, { kind: "army", ids: [a!.id] }, core)).toBeNull();
    // Nothing selected doesn't group.
    expect(toggleUnit(session, { kind: "none" }, a!)).toBeNull();
  });
});

describe("control groups", () => {
  it("a group saved with the hero in it recalls with the hero", () => {
    const { soldiers, hero } = base();
    const groups = new ControlGroups();
    const ids = [hero.id, ...soldiers.map((s) => s.id)];
    expect(groups.assign(3, { kind: "army", ids })).toBe(true);
    expect(groups.recall(3, () => true, 0)!.selection).toEqual({ kind: "army", ids });
    // A dead soldier drops out; the hero stays selected.
    const dead = soldiers[0]!.id;
    expect(groups.recall(3, (id) => id !== dead, 1000)!.selection).toEqual({ kind: "army", ids: [hero.id, soldiers[1]!.id] });
  });
});
