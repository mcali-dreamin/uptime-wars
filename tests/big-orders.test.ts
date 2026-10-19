// An army bigger than one command holds still moves as one (issue #131).

import { describe, expect, it } from "vitest";
import { MAX_ORDER_UNITS, TILE, TILE_OPEN, createWorld, queueCommand, step, tileAt, type Building, type Command, type Unit, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { groundOrders } from "../src/game/selection";
import type { Session } from "../src/game/session";
import { content, SETUP } from "./fixtures";

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

/** A world with `count` of your guards around the core, and open ground a few tiles off. */
function army(count: number) {
  const world = createWorld(content, SETUP);
  world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
  const core = world.entities.find((e): e is Building => e.id === world.teams[0]!.coreId)!;
  const ctx = makeContext(world, content);
  const units: Unit[] = [];
  for (let i = 0; i < count; i += 1) units.push(spawnUnit(ctx, 0, "process", core, core.x + (i % 20) * 6 - 60, core.y + 60 + Math.floor(i / 20) * 6, "guard"));
  let spot = { x: core.x, y: core.y };
  for (let r = 8; r < 16; r += 1) {
    const hit = [[r, 0], [-r, 0], [0, r], [0, -r]].find(([dc, dr]) => tileAt(world.terrain, Math.floor(core.x / TILE) + dc!, Math.floor(core.y / TILE) + dr!) === TILE_OPEN);
    if (hit) {
      spot = { x: (Math.floor(core.x / TILE) + hit[0]! + 0.5) * TILE, y: (Math.floor(core.y / TILE) + hit[1]! + 0.5) * TILE };
      break;
    }
  }
  return { world, units, spot, session: fakeSession(world) };
}

describe("big army orders", () => {
  it("a selection over the command cap goes out as several orders, and every unit takes it", () => {
    const { world, units, spot, session } = army(MAX_ORDER_UNITS + 100);
    const orders = groundOrders(session, { kind: "army", ids: units.map((u) => u.id) }, spot);
    expect(orders.length).toBe(2);
    for (const o of orders) {
      expect(o.type).toBe("order");
      if (o.type === "order") {
        expect(o.unitIds.length).toBeLessThanOrEqual(MAX_ORDER_UNITS);
        expect(o.group).toBe(units.length);
      }
    }
    for (const o of orders) queueCommand(world, { ...o, tick: world.tick, team: 0 } as Command);
    step(world, content);
    expect(world.events.some((e) => e.type === "rejected")).toBe(false);
    expect(units.every((u) => u.commanded && u.order === "attack")).toBe(true);
  });

  it("a small selection is still one order with no group size", () => {
    const { units, spot, session } = army(5);
    const orders = groundOrders(session, { kind: "army", ids: units.map((u) => u.id) }, spot);
    expect(orders.length).toBe(1);
    expect(orders[0]!.type === "order" && orders[0]!.group).toBeFalsy();
  });

  it("each part of a split order spreads for the whole group", () => {
    const spreadOf = (group: number | undefined) => {
      const { world, units, spot } = army(10);
      queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: units.map((u) => u.id), ...spot, attack: false, ...(group ? { group } : {}) });
      step(world, content);
      return Math.max(...units.map((u) => Math.max(Math.abs(u.homeX - spot.x), Math.abs(u.homeY - spot.y))));
    };
    expect(spreadOf(400)).toBeGreaterThan(spreadOf(undefined));
  });
});
