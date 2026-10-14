import { describe, expect, it } from "vitest";
import { createWorld, hashWorld, queueCommand, step, type Unit, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { ControlGroups } from "../src/game/groups";
import { content, SETUP } from "./fixtures";

function withSquad(): { world: World; squad: Unit[] } {
  const world = createWorld(content, SETUP);
  world.waves.nextWaveTick = 1e9;
  world.waves.nextTrickleTick = 1e9;
  const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
  const ctx = makeContext(world, content);
  const squad = [0, 1, 2].map((i) => spawnUnit(ctx, 0, "process", core, core.x + 80 + i * 20, core.y + 80, "guard"));
  return { world, squad };
}

/** Two open points near the core. */
function points(world: World) {
  const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
  return [
    { x: core.x + 240, y: core.y + 80 },
    { x: core.x - 240, y: core.y + 80 },
  ];
}

describe("shift-queued orders", () => {
  it("queued orders run in order, after the current one", () => {
    const { world, squad } = withSquad();
    const [a, b] = points(world);
    const ids = squad.map((u) => u.id);
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: ids, x: a!.x, y: a!.y, attack: false });
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: ids, x: b!.x, y: b!.y, attack: false, queue: true });
    step(world, content);
    expect(squad[0]!.waypoints).toHaveLength(1);
    // Heading for a first.
    expect(Math.abs(squad[0]!.homeX - a!.x)).toBeLessThan(80);
    let reachedA = false;
    for (let i = 0; i < 600; i++) {
      step(world, content);
      if (Math.hypot(squad[0]!.x - a!.x, squad[0]!.y - a!.y) < 90) reachedA = true;
      if (!squad[0]!.waypoints && Math.abs(squad[0]!.homeX - b!.x) < 80) break;
    }
    expect(reachedA).toBe(true);
    expect(squad[0]!.waypoints).toBeUndefined();
    expect(Math.abs(squad[0]!.homeX - b!.x)).toBeLessThan(80);
  });

  it("a queued order on idle units goes at once; a plain order clears the queue", () => {
    const { world, squad } = withSquad();
    const [a, b] = points(world);
    const ids = squad.map((u) => u.id);
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: ids, x: a!.x, y: a!.y, attack: false, queue: true });
    step(world, content);
    expect(squad[0]!.waypoints).toBeUndefined();
    expect(Math.abs(squad[0]!.homeX - a!.x)).toBeLessThan(80);
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: ids, x: b!.x, y: b!.y, attack: false, queue: true });
    step(world, content);
    expect(squad[0]!.waypoints).toHaveLength(1);
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: ids, x: a!.x, y: a!.y, attack: true });
    step(world, content);
    expect(squad[0]!.waypoints).toBeUndefined();
  });

  it("queued orders are deterministic", () => {
    const run = () => {
      const { world, squad } = withSquad();
      const [a, b] = points(world);
      const ids = squad.map((u) => u.id);
      queueCommand(world, { type: "order", tick: 1, team: 0, unitIds: ids, x: a!.x, y: a!.y, attack: true });
      queueCommand(world, { type: "order", tick: 2, team: 0, unitIds: ids, x: b!.x, y: b!.y, attack: false, queue: true });
      for (let i = 0; i < 400; i++) step(world, content);
      return hashWorld(world);
    };
    expect(run()).toBe(run());
  });
});

describe("control groups", () => {
  it("save, recall without the dead, double-tap, and forget when empty", () => {
    const groups = new ControlGroups();
    expect(groups.assign(1, { kind: "army", ids: [5, 6, 7] })).toBe(true);
    expect(groups.assign(2, { kind: "none" })).toBe(false);
    const alive = (id: number) => id !== 6;
    expect(groups.recall(1, alive, 0)).toEqual({ selection: { kind: "army", ids: [5, 7] }, doubleTap: false });
    expect(groups.recall(1, alive, 200)?.doubleTap).toBe(true);
    expect(groups.recall(1, alive, 2000)?.doubleTap).toBe(false);
    expect(groups.recall(1, () => false, 3000)).toBeNull();
    expect(groups.has(1)).toBe(false);
    expect(groups.recall(3, alive, 0)).toBeNull();
  });
});
