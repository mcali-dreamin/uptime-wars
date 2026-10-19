// Taking things back: decommission your buildings, dismiss your units (issue #132).

import { describe, expect, it } from "vitest";
import { buildCost, computeBalance, createWorld, hashWorld, queueCommand, simulate, step, type Building, type Command, type Unit, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { removal } from "../src/game/selection";
import type { Session } from "../src/game/session";
import { content, SETUP, firstSpot } from "./fixtures";

const run = (world: World, ticks: number) => {
  for (let i = 0; i < ticks; i += 1) step(world, content);
};
const rejections = (world: World) => world.events.flatMap((e) => (e.type === "rejected" ? [e.reason] : []));

function withRack(): { world: World; rack: Building } {
  const world = createWorld(content, SETUP);
  world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
  world.teams[0]!.money = 10_000;
  queueCommand(world, firstSpot("server-rack"));
  step(world, content);
  const rack = world.entities.find((e): e is Building => e.kind === "building" && e.team === 0 && e.defId === "server-rack")!;
  return { world, rack };
}

const decommission = (world: World, ids: number[], team = 0): Command => ({ type: "decommission", tick: world.tick, team, buildingIds: ids });

describe("decommission", () => {
  it("a building still deploying gives back everything you paid", () => {
    const { world, rack } = withRack();
    expect(rack.buildRemaining).toBeGreaterThan(0);
    const paid = rack.paid!;
    expect(paid).toBeGreaterThan(0);
    const before = world.teams[0]!.money;
    queueCommand(world, decommission(world, [rack.id]));
    step(world, content);
    expect(rejections(world)).toEqual([]);
    expect(world.teams[0]!.money - before).toBeGreaterThanOrEqual(paid);
    expect(world.entities.some((e) => e.id === rack.id)).toBe(false);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "decommissioned", team: 0, buildings: 1, refund: paid }));
  });

  it("a finished building gives back the configured share", () => {
    const { world, rack } = withRack();
    run(world, rack.buildRemaining + 2);
    expect(rack.buildRemaining).toBe(0);
    queueCommand(world, decommission(world, [rack.id]));
    step(world, content);
    const event = world.events.find((e) => e.type === "decommissioned");
    expect(event?.type === "decommissioned" && event.refund).toBe(Math.floor((rack.paid! * content.economy.decommissionRefundPermille) / 1000));
  });

  it("the next one of that kind costs less again", () => {
    const { world, rack } = withRack();
    const second = buildCost(world, content, 0, "server-rack");
    queueCommand(world, decommission(world, [rack.id]));
    step(world, content);
    expect(buildCost(world, content, 0, "server-rack")).toBeLessThan(second);
  });

  it("never a core, never someone else's building", () => {
    const { world, rack } = withRack();
    const core = world.teams[0]!.coreId;
    const nest = world.teams[1]!.coreId;
    queueCommand(world, decommission(world, [core]));
    queueCommand(world, decommission(world, [nest]));
    queueCommand(world, decommission(world, [rack.id], 1));
    step(world, content);
    expect(rejections(world)).toEqual(["can't decommission a core", "not your building", "no such player"]);
    expect(world.entities.some((e) => e.id === core)).toBe(true);
    expect(world.entities.some((e) => e.id === rack.id)).toBe(true);
  });

  it("a group with a core in it still takes the rest down", () => {
    const { world, rack } = withRack();
    queueCommand(world, decommission(world, [world.teams[0]!.coreId, rack.id]));
    step(world, content);
    expect(rejections(world)).toEqual([]);
    expect(world.entities.some((e) => e.id === rack.id)).toBe(false);
    expect(world.entities.some((e) => e.id === world.teams[0]!.coreId)).toBe(true);
  });

  it("the units a torn-down spawner made fight on", () => {
    const { world, rack } = withRack();
    run(world, rack.buildRemaining + 400);
    const squad = world.entities.filter((e): e is Unit => e.kind === "unit" && e.spawnerId === rack.id);
    expect(squad.length).toBeGreaterThan(0);
    queueCommand(world, decommission(world, [rack.id]));
    run(world, 50);
    expect(squad.every((u) => u.hp > 0 && world.entities.includes(u))).toBe(true);
  });
});

describe("construction", () => {
  it("a building that falls while it's still deploying stays down", () => {
    const { world, rack } = withRack();
    expect(rack.buildRemaining).toBeGreaterThan(0);
    rack.hp = 0;
    step(world, content);
    expect(world.entities.some((e) => e.id === rack.id)).toBe(false);
  });
});

describe("dismiss", () => {
  function withUnits(n: number) {
    const world = createWorld(content, SETUP);
    world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
    const core = world.entities.find((e): e is Building => e.id === world.teams[0]!.coreId)!;
    const ctx = makeContext(world, content);
    const units = Array.from({ length: n }, (_, i) => spawnUnit(ctx, 0, "process", core, core.x + i * 10 - 20, core.y + 60, "guard"));
    return { world, units };
  }

  it("sends units away and frees their compute at once", () => {
    const { world, units } = withUnits(4);
    const team = world.teams[0]!;
    const before = computeBalance(world, content, team).demand;
    const money = team.money;
    queueCommand(world, { type: "dismiss", tick: world.tick, team: 0, unitIds: units.map((u) => u.id) });
    step(world, content);
    expect(rejections(world)).toEqual([]);
    expect(world.entities.some((e) => units.includes(e as Unit))).toBe(false);
    expect(computeBalance(world, content, team).demand).toBeLessThan(before);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "decommissioned", units: 4, refund: 0 }));
    expect(team.money).toBeGreaterThanOrEqual(money);
  });

  it("never the deploy agent, the hero, or an enemy", () => {
    const world = createWorld(content, { ...SETUP, startWithCore: false });
    const builder = world.teams[0]!.builderId;
    const creep = world.entities.find((e) => e.kind === "unit" && e.team !== 0);
    queueCommand(world, { type: "dismiss", tick: world.tick, team: 0, unitIds: [builder, creep?.id ?? -1] });
    step(world, content);
    expect(rejections(world)).toEqual(["no units"]);
    expect(world.entities.some((e) => e.id === builder)).toBe(true);
  });
});

describe("Delete on a selection", () => {
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

  it("decommissions a building with its refund in the label, and nothing for the core", () => {
    const { world, rack } = withRack();
    const session = fakeSession(world);
    const plan = removal(session, { kind: "entity", id: rack.id });
    expect(plan?.orders).toEqual([{ type: "decommission", buildingIds: [rack.id] }]);
    expect(plan?.label).toContain(`+$${rack.paid}`);
    expect(removal(session, { kind: "entity", id: world.teams[0]!.coreId })).toBeNull();
  });
});

describe("replays", () => {
  it("a decommission replays exactly", () => {
    const { rack } = withRack();
    const log: Command[] = [firstSpot("server-rack"), { type: "decommission", tick: 30, team: 0, buildingIds: [rack.id] }];
    const a = simulate(content, SETUP, log, 300);
    const b = simulate(content, SETUP, log, 300);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(a.entities.some((e) => e.id === rack.id)).toBe(false);
  });
});
