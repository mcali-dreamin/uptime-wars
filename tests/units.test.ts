import { describe, expect, it } from "vitest";
import {
  createWorld,
  queueCommand,
  TILE,
  tileAt,
  TILE_BLOCKED,
  step,
  type Building,
} from "../src/sim";
import { content, SETUP, OPENING, firstSpot, planBuildOrder } from "./fixtures";

describe("auto-spawn", () => {
  it("a finished server rack forks processes on its (race-modified) timer", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    const def = content.buildings["server-rack"]!;
    const interval = Math.round(def.spawn!.intervalTicks * content.races["open-source"]!.modifiers.spawnIntervalMultiplier);
    // Placed on step 0, built after buildTicks steps, then fires on the
    // interval-th step after that.
    const stepsBeforeSpawn = def.buildTicks + interval - 1;

    while (world.tick < stepsBeforeSpawn) step(world, content);
    const processes = () => world.entities.filter((e) => e.kind === "unit" && e.defId === "process").length;
    expect(processes()).toBe(0);
    step(world, content);
    expect(processes()).toBe(def.spawn!.count);
  });

  it("guards stay near where they spawned when nothing is around", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    while (world.tick < 400) step(world, content);
    const guards = world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard");
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) {
      if (guard.kind !== "unit") continue;
      const dx = guard.x - guard.homeX;
      const dy = guard.y - guard.homeY;
      expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThan(40);
    }
  });
});

describe("rally points", () => {
  /** A walkable point roughly `tiles` away from the core, found deterministically. */
  function openPointNear(world: ReturnType<typeof createWorld>, tiles: number) {
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    for (let r = tiles; r < tiles + 10; r += 1) {
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]] as const) {
        const x = core.x + dx * TILE;
        const y = core.y + dy * TILE;
        if (tileAt(world.terrain, Math.floor(x / TILE), Math.floor(y / TILE)) === 0) return { x, y };
      }
    }
    throw new Error("no open point");
  }

  function worldWithRack() {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard")) step(world, content);
    const rack = world.entities.find((e) => e.kind === "building" && e.defId === "server-rack")!;
    return { world, rack, coreId: world.teams[0]!.coreId };
  }

  const guards = (world: ReturnType<typeof createWorld>) =>
    world.entities.filter((e): e is Extract<typeof e, { kind: "unit" }> => e.kind === "unit" && e.team === 0 && e.mode === "guard");

  it("a spawner's rally point sends its existing units and new ones there", () => {
    const { world, rack } = worldWithRack();
    const point = openPointNear(world, 8);
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: rack.id, x: point.x, y: point.y });
    const until = world.tick + 900;
    while (world.tick < until) step(world, content);
    const units = guards(world);
    expect(units.length).toBeGreaterThan(2);
    for (const unit of units) {
      expect(Math.hypot(unit.homeX - point.x, unit.homeY - point.y)).toBeLessThanOrEqual(60);
      expect(Math.hypot(unit.x - point.x, unit.y - point.y)).toBeLessThan(120);
    }
  });

  it("the core sets its rally; a spawner's own rally overrides it", () => {
    const { world, rack, coreId } = worldWithRack();
    const core = () => world.entities.find((e): e is Building => e.id === coreId)!;
    const globalPoint = openPointNear(world, 6);
    const ownPoint = openPointNear(world, 12);
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: coreId, x: globalPoint.x, y: globalPoint.y });
    step(world, content);
    expect(core().rally).toEqual(globalPoint);
    for (const unit of guards(world)) expect(Math.hypot(unit.homeX - globalPoint.x, unit.homeY - globalPoint.y)).toBeLessThanOrEqual(60);

    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: rack.id, x: ownPoint.x, y: ownPoint.y });
    step(world, content);
    for (const unit of guards(world)) expect(Math.hypot(unit.homeX - ownPoint.x, unit.homeY - ownPoint.y)).toBeLessThanOrEqual(60);

    // Moving the core's rally no longer affects a spawner that has its own.
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: coreId, x: globalPoint.x + TILE, y: globalPoint.y });
    step(world, content);
    for (const unit of guards(world)) expect(Math.hypot(unit.homeX - ownPoint.x, unit.homeY - ownPoint.y)).toBeLessThanOrEqual(60);
  });

  it("rejects rallies on non-spawners, enemy buildings, and walls", () => {
    const world = createWorld(content, SETUP);
    const wall = planBuildOrder(content, SETUP, [[0, "firewall"]])[0]!;
    queueCommand(world, wall);
    step(world, content);
    const firewall = world.entities.find((e) => e.kind === "building" && e.defId === "firewall")!;
    const open = openPointNear(world, 5);
    const reasons: string[] = [];
    for (const command of [
      { buildingId: firewall.id, x: open.x, y: open.y },
      { buildingId: world.teams[1]!.coreId, x: open.x, y: open.y },
      { buildingId: world.teams[0]!.coreId, x: 1, y: 1 },
    ]) {
      queueCommand(world, { type: "rally", tick: world.tick, team: 0, ...command });
      step(world, content);
      for (const e of world.events) if (e.type === "rejected") reasons.push(e.reason);
    }
    expect(reasons).toEqual(["doesn't spawn units", "not your building", "can't rally there"]);
  });
});

describe("creeps", () => {
  it("an incident leaves the nest in the middle as random-sized packs", () => {
    const world = createWorld(content, SETUP);
    const nest = world.entities.find((e) => e.id === world.teams[1]!.coreId)!;
    // Just the incident: no background traffic muddying the packs. Incident 2:
    // the opening one comes in at your door instead (see opening.test.ts).
    world.waves.nextTrickleTick = 1e9;
    world.waves.nextIndex = 1;
    while (world.tick <= content.waves.firstIncidentTicks + 40) step(world, content);
    // Roaming creeps only: the farms' garrison guards the fortress.
    const creeps = world.entities.filter((e) => e.kind === "unit" && e.team === 1 && e.mode === "roam");
    expect(creeps.length).toBeGreaterThan(0);
    const packs = new Map<number, number>();
    for (const creep of creeps) {
      if (creep.kind !== "unit") continue;
      packs.set(creep.packId, (packs.get(creep.packId) ?? 0) + 1);
      expect(Math.hypot(creep.x - nest.x, creep.y - nest.y)).toBeLessThan(TILE * 6);
    }
    expect(packs.size).toBeGreaterThan(1);
    for (const size of packs.values()) expect(size).toBeLessThanOrEqual(content.waves.packSize.max);
  });

  it("creeps never know where you are: they only target what they can see", () => {
    const world = createWorld(content, SETUP);
    for (const command of OPENING) queueCommand(world, command);
    while (world.tick < 3000) {
      step(world, content);
      const byId = new Map(world.entities.map((e) => [e.id, e]));
      for (const creep of world.entities) {
        if (creep.kind !== "unit" || creep.team !== 1 || creep.targetId === null) continue;
        const target = byId.get(creep.targetId);
        if (!target) continue;
        const sight = target.kind === "building" ? Math.max(content.units[creep.defId]!.aggro, 700) : content.units[creep.defId]!.aggro;
        const edge = Math.hypot(target.x - creep.x, target.y - creep.y) - target.radius - creep.radius;
        expect(edge).toBeLessThanOrEqual(sight * 1.5 + 1);
      }
    }
  });

  it("a creep on a building turns on a defender that gets in its face", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    // A defender, and the first creep out of the nest.
    while (!(world.entities.some((e) => e.kind === "unit" && e.team === 0) && world.entities.some((e) => e.kind === "unit" && e.team === 1 && e.mode === "roam"))) {
      step(world, content);
    }
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    const creep = world.entities.find((e) => e.kind === "unit" && e.team === 1 && e.mode === "roam")!;
    const defender = world.entities.find((e) => e.kind === "unit" && e.team === 0)!;
    // The creep is at the core (nearest target: the core); the defender stands
    // further off, but well inside the creep's aggro range.
    creep.x = core.x + core.radius + creep.radius + 2;
    creep.y = core.y;
    creep.targetId = core.id;
    defender.x = creep.x + 70;
    defender.y = creep.y;
    if (defender.kind === "unit") {
      defender.homeX = defender.x;
      defender.homeY = defender.y;
    }
    step(world, content);
    expect(creep.targetId).toBe(defender.id);
  });

  it("no creep is ever inside a wall", () => {
    const world = createWorld(content, SETUP);
    while (world.tick < 3000) {
      step(world, content);
      for (const e of world.entities) {
        if (e.kind !== "unit") continue;
        expect(tileAt(world.terrain, Math.floor(e.x / TILE), Math.floor(e.y / TILE))).not.toBe(TILE_BLOCKED);
      }
    }
  });
});
