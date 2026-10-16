// Several spawners selected at once take one rally point together.

import { describe, expect, it } from "vitest";
import { createWorld, queueCommand, step, type Building, type Command, type World } from "../src/sim";
import { placeBuilding } from "../src/sim/entities";
import { ControlGroups } from "../src/game/groups";
import { armed, groundOrders, leftClickOrders, spawnerGroup, spawnerSelection, toggleSpawner } from "../src/game/selection";
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

function base() {
  const world = createWorld(content, SETUP);
  world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
  const core = world.entities.find((e): e is Building => e.id === world.teams[0]!.coreId)!;
  const racks = [0, 1, 2].map((i) => placeBuilding(world, content, 0, i === 2 ? "gpu-cluster" : "server-rack", core.col - 6 + i * 4, core.row + 5, true));
  return { world, core, racks, session: fakeSession(world) };
}

describe("multi-select rally", () => {
  it("right-clicking the ground with several spawners selected rallies every one of them there", () => {
    const { world, core, racks, session } = base();
    const point = { x: core.x + 200, y: core.y - 120 };
    const orders = groundOrders(session, spawnerSelection(racks.map((r) => r.id)), point);
    expect(orders).toHaveLength(3);
    for (const order of orders) queueCommand(world, { ...order, tick: world.tick, team: 0 } as Command);
    step(world, content);
    for (const rack of racks) expect(rack.rally).toEqual(point);
    expect(world.events.filter((e) => e.type === "rejected")).toHaveLength(0);
  });

  it("shift-click adds a spawner to the selection and takes it back out", () => {
    const { core, racks, session } = base();
    const [a, b] = racks;
    const two = toggleSpawner(session, { kind: "entity", id: a!.id }, b!);
    expect(two).toEqual({ kind: "spawners", ids: [a!.id, b!.id] });
    // Back to one: that building on its own, with its full card.
    expect(toggleSpawner(session, two!, b!)).toEqual({ kind: "entity", id: a!.id });
    // The core isn't a spawner, and units or nothing selected don't group.
    expect(toggleSpawner(session, { kind: "entity", id: a!.id }, core)).toBeNull();
    expect(toggleSpawner(session, { kind: "none" }, b!)).toBeNull();
  });

  it("T arms it: the next left-click on the ground rallies them all", () => {
    const { racks, session } = base();
    const group = spawnerSelection(racks.map((r) => r.id));
    expect(leftClickOrders(session, group)).toBe(false);
    const ready = armed(session, group)!;
    expect(ready).toEqual({ kind: "spawners", ids: racks.map((r) => r.id), armed: true });
    expect(leftClickOrders(session, ready)).toBe(true);
    // A plain move has no meaning for buildings.
    expect(armed(session, group, "move")).toBeNull();
  });

  it("a destroyed spawner drops out of the group", () => {
    const { racks, session } = base();
    const group = spawnerSelection(racks.map((r) => r.id));
    racks[1]!.hp = 0;
    expect(spawnerGroup(session, group).map((b) => b.id)).toEqual([racks[0]!.id, racks[2]!.id]);
  });

  it("a control group keeps several spawners", () => {
    const { racks } = base();
    const groups = new ControlGroups();
    const ids = racks.map((r) => r.id);
    expect(groups.assign(4, spawnerSelection(ids))).toBe(true);
    expect(groups.recall(4, () => true, 0)!.selection).toEqual({ kind: "spawners", ids });
    expect(groups.recall(4, (id) => id === ids[0], 1000)!.selection).toEqual({ kind: "entity", id: ids[0] });
  });
});
