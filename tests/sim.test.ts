import { describe, expect, it } from "vitest";
import {
  UNREACHABLE,
  TILE_CLIFF,
  TILE_RAMP,
  canSee,
  hasLineOfSight,
  hasClearPath,
  type Entity,
  flowField,
  canFound,
  createWorld,
  hashTerrain,
  hashWorld,
  loadDefaultContent,
  queueCommand,
  simulate,
  planWave,
  levelOf,
  canPlace,
  isOccupied,
  multiplier,
  nextLevel,
  userCapacity,
  waveInterval,
  TILE,
  tileAt,
  TILE_BLOCKED,
  step,
  validateContent,
  type BuildCommand,
  type Content,
} from "../src/sim";
import { planBuildOrder } from "./helpers";
import { makeContext } from "../src/sim/context";
import { dealDamage } from "../src/sim/combat";

const content = loadDefaultContent();
// Most tests skip the builder phase; the "builder start" block covers it.
const SETUP = { seed: 1234, races: ["open-source", "botnet"] as [string, string], startWithCore: true };

const OPENING_ORDER: [number, string][] = [
  [1, "server-rack"],
  [1, "server-rack"],
  [200, "firewall"],
  [400, "solar-array"],
  [700, "gpu-cluster"],
  [1000, "firewall"],
  [1300, "server-rack"],
];
const OPENING = planBuildOrder(content, SETUP, OPENING_ORDER);

function firstSpot(building: string, tick = 0): BuildCommand {
  return planBuildOrder(content, SETUP, [[tick, building]])[0]!;
}

describe("determinism", () => {
  it("same seed and command log produce the same world", () => {
    const a = simulate(content, SETUP, OPENING, 3000);
    const b = simulate(content, SETUP, OPENING, 3000);
    expect(a.tick).toBe(b.tick);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it("a different seed diverges", () => {
    const other = { ...SETUP, seed: 99 };
    const a = simulate(content, SETUP, OPENING, 1500);
    const b = simulate(content, other, planBuildOrder(content, other, OPENING_ORDER), 1500);
    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });

  it("hash is stable when checked mid-match (replay checkpoints)", () => {
    const run = () => {
      const world = createWorld(content, SETUP);
      for (const command of OPENING) queueCommand(world, command);
      const checkpoints: string[] = [];
      for (let i = 0; i < 1500; i += 1) {
        step(world, content);
        if (world.tick % 300 === 0) checkpoints.push(hashWorld(world));
      }
      return checkpoints;
    };
    expect(run()).toEqual(run());
  });
});

describe("terrain", () => {
  const SEEDS = Array.from({ length: 12 }, (_, i) => i * 7919 + 1);

  it("the same seed always generates the same map", () => {
    for (const seed of SEEDS.slice(0, 5)) {
      const a = createWorld(content, { ...SETUP, seed });
      const b = createWorld(content, { ...SETUP, seed });
      expect(hashTerrain(a)).toBe(hashTerrain(b));
    }
  });

  it("every map is playable: nest in the middle, start far out, reachable, room to build", () => {
    for (const seed of SEEDS) {
      const world = createWorld(content, { ...SETUP, seed });
      const { terrain } = world;
      const core = world.entities.find((e) => e.id === world.teams[0].coreId)!;
      const nest = world.entities.find((e) => e.id === world.teams[1].coreId)!;
      const nestTile = Math.floor(nest.y / TILE) * terrain.cols + Math.floor(nest.x / TILE);
      // The nest is the center of the web.
      expect(Math.abs(nest.x - (terrain.cols * TILE) / 2), `seed ${seed}`).toBeLessThanOrEqual(TILE * 2);
      expect(Math.abs(nest.y - (terrain.rows * TILE) / 2), `seed ${seed}`).toBeLessThanOrEqual(TILE * 2);

      // Creeps can walk from the nest to the core.
      const toCore = flowField(terrain, [Math.floor(core.y / TILE) * terrain.cols + Math.floor(core.x / TILE)]);
      expect(toCore[nestTile], `seed ${seed}`).not.toBe(UNREACHABLE);
      // Far apart, so the enemy is off-screen.
      const dx = nest.x - core.x;
      const dy = nest.y - core.y;
      expect(Math.sqrt(dx * dx + dy * dy), `seed ${seed}`).toBeGreaterThan(4000);
      // There is room to build around the core.
      expect(planBuildOrder(content, { ...SETUP, seed }, OPENING_ORDER)).toHaveLength(OPENING_ORDER.length);
      // At least two wells near the start.
      const near = terrain.resources.filter((r) => {
        const rx = r.col - terrain.start.col;
        const ry = r.row - terrain.start.row;
        return rx * rx + ry * ry <= 15 * 15;
      });
      expect(near.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      // Plenty of places for creeps to wander between.
      expect(terrain.roamPoints.length, `seed ${seed}`).toBeGreaterThanOrEqual(12);
    }
  });
});

describe("building", () => {
  it("charges compute and places the building", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    step(world, content);
    expect(world.teams[0].compute).toBe(200 - 60);
    expect(world.entities.some((e) => e.kind === "building" && e.defId === "server-rack")).toBe(true);
  });

  it("rejects blocked terrain, far-away tiles, occupied tiles, and empty wallets", () => {
    const world = createWorld(content, SETUP);
    const { terrain } = world;
    const spot = firstSpot("server-rack");
    let blocked = { col: 0, row: 0 }; // map border is always blocked
    const far = { col: terrain.nest.col - 3, row: terrain.nest.row };
    const reject = (building: string, col: number, row: number) => {
      queueCommand(world, { type: "build", tick: world.tick, team: 0, building, col, row });
      step(world, content);
      const rejected = world.events.find((e) => e.type === "rejected");
      return rejected?.type === "rejected" ? rejected.reason : null;
    };
    blocked = { col: 0, row: terrain.start.row };
    expect(reject("server-rack", blocked.col, blocked.row)).toBe("terrain is not buildable");
    expect(reject("server-rack", far.col, far.row)).toMatch(/terrain is not buildable|outside your network/);
    expect(reject("server-rack", spot.col, spot.row)).toBeNull();
    expect(reject("firewall", spot.col, spot.row)).toBe("tile occupied");
    world.teams[0].compute = 0;
    const other = planBuildOrder(content, SETUP, [[0, "server-rack"], [0, "server-rack"]])[1]!;
    expect(reject("server-rack", other.col, other.row)).toBe("not enough compute");
  });

  it("rejects buildings outside the race roster", () => {
    const world = createWorld(content, SETUP);
    const spot = firstSpot("server-rack");
    queueCommand(world, { ...spot, building: "malware-nest" });
    step(world, content);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "rejected", reason: "not in this race's roster" }));
  });
});

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
    const guards = world.entities.filter((e) => e.kind === "unit" && e.team === 0);
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) {
      if (guard.kind !== "unit") continue;
      const dx = guard.x - guard.homeX;
      const dy = guard.y - guard.homeY;
      expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThan(40);
    }
  });
});

describe("creeps", () => {
  it("each wave leaves the nest in the middle as random-sized packs", () => {
    const world = createWorld(content, SETUP);
    const nest = world.entities.find((e) => e.id === world.teams[1].coreId)!;
    while (world.tick <= content.waves.firstWaveTicks + 40) step(world, content);
    const creeps = world.entities.filter((e) => e.kind === "unit" && e.team === 1);
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

describe("endless waves", () => {
  it("waves keep coming and there is no win by timer", () => {
    const world = createWorld(content, SETUP);
    for (const command of OPENING) queueCommand(world, command);
    while (world.waves.nextIndex < 4) step(world, content);
    expect(world.outcome).toBeNull();
    expect(world.waves.nextWaveTick).toBeGreaterThan(world.tick);
  });

  it("budgets grow, the gap between waves shrinks, units unlock, bosses arrive on cadence", () => {
    const world = createWorld(content, SETUP);
    const size = (wave: number) => planWave(world, content, wave).units.length;
    expect(size(10)).toBeGreaterThan(size(1));
    expect(waveInterval(content, 10)).toBeLessThan(waveInterval(content, 1));
    expect(waveInterval(content, 1000)).toBe(content.waves.interval.minTicks);

    const first = planWave(world, content, 1).units;
    for (const entry of content.waves.roster.filter((e) => e.fromWave > 1)) expect(first).not.toContain(entry.unit);

    const { unit, fromWave, every } = content.waves.bosses;
    expect(planWave(world, content, fromWave - 1).units).not.toContain(unit);
    expect(planWave(world, content, fromWave).units).toContain(unit);
    expect(planWave(world, content, fromWave + 1).units).not.toContain(unit);
    expect(planWave(world, content, fromWave + every).units).toContain(unit);
  });

  it("a rack keeps at most its maxAlive guards", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    while (world.tick < 2000) step(world, content);
    const guards = world.entities.filter((e) => e.kind === "unit" && e.team === 0);
    expect(guards.length).toBeLessThanOrEqual(content.buildings["server-rack"]!.spawn!.maxAlive);
    expect(guards.length).toBeGreaterThan(0);
  });
});

describe("builder start", () => {
  const BUILDER_SETUP = { seed: 1234, races: ["open-source", "botnet"] as [string, string] };

  it("you start with a deploy agent and no core, and the clock is on grace time", () => {
    const world = createWorld(content, BUILDER_SETUP);
    expect(world.teams[0].coreId).toBe(-1);
    const builder = world.entities.find((e) => e.id === world.teams[0].builderId);
    expect(builder).toMatchObject({ kind: "unit", mode: "builder", defId: "deploy-agent" });
    expect(world.waves.nextWaveTick).toBe(content.waves.graceTicks);
    // The nest still has its core.
    expect(world.teams[1].coreId).not.toBe(-1);
  });

  it("the builder walks to the chosen site, becomes the core, and starts the wave clock", () => {
    const world = createWorld(content, BUILDER_SETUP);
    const { start } = world.terrain;
    // Pick a valid site a few tiles away from where the builder stands.
    let site: { col: number; row: number } | null = null;
    for (let r = 4; r <= 10 && !site; r += 1) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
        if (canFound(world, content, 0, start.col + dc, start.row + dr) === null) {
          site = { col: start.col + dc, row: start.row + dr };
          break;
        }
      }
    }
    expect(site).not.toBeNull();
    queueCommand(world, { type: "found", tick: 0, team: 0, ...site! });
    while (world.teams[0].coreId === -1 && world.tick < 2000) step(world, content);

    const core = world.entities.find((e) => e.id === world.teams[0].coreId)!;
    expect(core).toMatchObject({ kind: "building", defId: "core", col: site!.col, row: site!.row });
    expect(world.teams[0].builderId).toBe(-1);
    expect(world.entities.some((e) => e.kind === "unit" && e.mode === "builder")).toBe(false);
    expect(world.waves.nextWaveTick).toBe(Math.min(content.waves.graceTicks, world.tick - 1 + content.waves.firstWaveTicks));
  });

  it("rejects founding on blocked terrain, and nothing can be built before the core", () => {
    const world = createWorld(content, BUILDER_SETUP);
    queueCommand(world, { type: "found", tick: 0, team: 0, col: 0, row: 0 });
    queueCommand(world, { type: "build", tick: 0, team: 0, building: "server-rack", col: world.terrain.start.col, row: world.terrain.start.row });
    step(world, content);
    const reasons = world.events.flatMap((e) => (e.type === "rejected" ? [e.reason] : []));
    // Same tick and team: applied in the order they were queued.
    expect(reasons).toEqual(["terrain is not buildable", "no core"]);
  });

  it("losing the builder before founding loses the match", () => {
    const world = createWorld(content, BUILDER_SETUP);
    const builder = world.entities.find((e) => e.id === world.teams[0].builderId)!;
    builder.hp = 0;
    step(world, content);
    expect(world.outcome).toMatchObject({ winner: 1 });
  });

  it("the first wave arrives at the end of grace time even if you never found", () => {
    const world = createWorld(content, BUILDER_SETUP);
    while (world.tick <= content.waves.graceTicks) step(world, content);
    expect(world.waves.nextIndex).toBe(1);
  });
});

describe("rally points", () => {
  /** A walkable point roughly `tiles` away from the core, found deterministically. */
  function openPointNear(world: ReturnType<typeof createWorld>, tiles: number) {
    const core = world.entities.find((e) => e.id === world.teams[0].coreId)!;
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
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 0)) step(world, content);
    const rack = world.entities.find((e) => e.kind === "building" && e.defId === "server-rack")!;
    return { world, rack, coreId: world.teams[0].coreId };
  }

  const guards = (world: ReturnType<typeof createWorld>) =>
    world.entities.filter((e): e is Extract<typeof e, { kind: "unit" }> => e.kind === "unit" && e.team === 0);

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

  it("the core sets a global rally; a spawner's own rally overrides it", () => {
    const { world, rack, coreId } = worldWithRack();
    const globalPoint = openPointNear(world, 6);
    const ownPoint = openPointNear(world, 12);
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: coreId, x: globalPoint.x, y: globalPoint.y });
    step(world, content);
    expect(world.teams[0].rally).toEqual(globalPoint);
    for (const unit of guards(world)) expect(Math.hypot(unit.homeX - globalPoint.x, unit.homeY - globalPoint.y)).toBeLessThanOrEqual(60);

    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: rack.id, x: ownPoint.x, y: ownPoint.y });
    step(world, content);
    for (const unit of guards(world)) expect(Math.hypot(unit.homeX - ownPoint.x, unit.homeY - ownPoint.y)).toBeLessThanOrEqual(60);

    // Moving the global rally no longer affects a spawner that has its own.
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
      { buildingId: world.teams[1].coreId, x: open.x, y: open.y },
      { buildingId: world.teams[0].coreId, x: 1, y: 1 },
    ]) {
      queueCommand(world, { type: "rally", tick: world.tick, team: 0, ...command });
      step(world, content);
      for (const e of world.events) if (e.type === "rejected") reasons.push(e.reason);
    }
    expect(reasons).toEqual(["doesn't spawn units", "not your building", "can't rally there"]);
  });
});

describe("races", () => {
  const HYPER = { ...SETUP, races: ["hyperscaler", "botnet"] as [string, string] };

  it("every playable race has a builder, a core, and its own roster", () => {
    const playable = Object.entries(content.races).filter(([, r]) => r.controller === "human");
    expect(playable.length).toBeGreaterThanOrEqual(2);
    const rosters = playable.map(([, r]) => r.buildings.join(","));
    expect(new Set(rosters).size).toBe(rosters.length);
    for (const [, race] of playable) expect(race.builder).toBeDefined();
  });

  it("the Hyperscaler starts richer and fields tougher units", () => {
    const os = createWorld(content, SETUP);
    const hyper = createWorld(content, HYPER);
    expect(hyper.teams[0].compute - os.teams[0].compute).toBe(content.races.hyperscaler!.modifiers.startingComputeBonus);

    const rack = planBuildOrder(content, HYPER, [[0, "hyperscale-rack"]])[0]!;
    queueCommand(hyper, rack);
    while (!hyper.entities.some((e) => e.kind === "unit" && e.team === 0)) step(hyper, content);
    const unit = hyper.entities.find((e) => e.kind === "unit" && e.team === 0)!;
    expect(unit.maxHp).toBe(Math.round(content.units["load-balancer"]!.hp * content.races.hyperscaler!.modifiers.unitHpMultiplier));
  });

  it("each race can only build its own roster", () => {
    const world = createWorld(content, HYPER);
    const spot = planBuildOrder(content, HYPER, [[0, "hyperscale-rack"]])[0]!;
    queueCommand(world, { ...spot, building: "server-rack" });
    step(world, content);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "rejected", reason: "not in this race's roster" }));
  });
});

describe("users", () => {
  const BUILDER_SETUP = { seed: 1234, races: ["open-source", "botnet"] as [string, string] };
  const econ = content.economy;
  const coreCap = content.buildings.core!.userCapacity!;

  it("there are no users before the core is online", () => {
    const world = createWorld(content, BUILDER_SETUP);
    for (let i = 0; i < 200; i++) step(world, content);
    expect(world.teams[0].users).toBe(0);
  });

  it("users grow toward capacity and never past it", () => {
    const world = createWorld(content, SETUP);
    expect(world.teams[0].users).toBe(econ.startingUsers);
    let last = world.teams[0].users;
    for (let s = 0; s < 120; s++) {
      for (let i = 0; i < 20; i++) step(world, content);
      expect(world.teams[0].users).toBeGreaterThanOrEqual(last);
      expect(world.teams[0].users).toBeLessThanOrEqual(coreCap);
      last = world.teams[0].users;
    }
    expect(world.teams[0].users).toBe(coreCap);
  });

  it("users pay revenue on top of base income", () => {
    const withUsers = createWorld(content, SETUP);
    const without = createWorld(content, SETUP);
    without.teams[0].users = 0;
    const freeze: typeof content = structuredClone(content);
    freeze.economy = { ...econ, growthPerSecond: 0, minArrivalsPerSecond: 0 };
    for (let i = 0; i < 400; i++) {
      step(withUsers, freeze);
      step(without, freeze);
    }
    // 20 seconds of econ.startingUsers users.
    const expected = Math.floor(20 * econ.startingUsers * econ.revenuePerUserPerSecond);
    expect(withUsers.teams[0].compute - without.teams[0].compute).toBe(expected);
  });

  it("a Web App raises capacity", () => {
    const world = createWorld(content, SETUP);
    world.teams[0].compute = 1000;
    queueCommand(world, planBuildOrder(content, SETUP, [[0, "web-app"]])[0]!);
    for (let i = 0; i < 20 * 150; i++) step(world, content);
    expect(world.teams[0].users).toBe(coreCap + content.buildings["web-app"]!.userCapacity!);
  });

  it("damage to your buildings drives users away", () => {
    // No growth, so any change is churn.
    const frozen: typeof content = structuredClone(content);
    frozen.economy = { ...econ, growthPerSecond: 0, minArrivalsPerSecond: 0 };
    const world = createWorld(frozen, SETUP);
    world.teams[0].users = 40;
    // Let the first wave out, then put one creep right next to the core.
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 1)) step(world, frozen);
    const core = world.entities.find((e) => e.id === world.teams[0].coreId)!;
    const creep = world.entities.find((e) => e.kind === "unit" && e.team === 1)!;
    creep.x = core.x + core.radius + creep.radius + 4;
    creep.y = core.y;
    const hpBefore = core.hp;
    for (let i = 0; i < 200; i++) step(world, frozen);
    const damage = hpBefore - core.hp;
    expect(damage).toBeGreaterThan(0);
    expect(40 - world.teams[0].users).toBe(Math.floor(damage / econ.damagePerUserLost));
  });
});

describe("upgrades", () => {
  const research = (world: ReturnType<typeof createWorld>, upgrade: string) => {
    queueCommand(world, { type: "research", tick: world.tick, team: 0, upgrade });
    step(world, content);
    return world.events.flatMap((e) => (e.type === "rejected" ? [e.reason] : []));
  };

  it("research costs compute, takes time, then raises the level", () => {
    const world = createWorld(content, SETUP);
    world.teams[0].compute = 1000;
    const def = content.upgrades["exploit-kits"]!;
    expect(research(world, "exploit-kits")).toEqual([]);
    expect(world.teams[0].research).toMatchObject({ upgrade: "exploit-kits" });
    expect(levelOf(world.teams[0], "exploit-kits")).toBe(0);
    let done = false;
    for (let i = 0; i < def.researchTicks + 5 && !done; i++) {
      step(world, content);
      done = world.events.some((e) => e.type === "researched");
    }
    expect(done).toBe(true);
    expect(levelOf(world.teams[0], "exploit-kits")).toBe(1);
    expect(world.teams[0].research).toBeNull();
    expect(multiplier(content, world.teams[0], "unitDamage")).toBeCloseTo(1 + def.perLevel);
  });

  it("level n costs cost * n", () => {
    const world = createWorld(content, SETUP);
    world.teams[0].upgrades["anycast"] = 1;
    expect(nextLevel(content, world.teams[0], "anycast")).toMatchObject({ level: 2, cost: content.upgrades.anycast!.cost * 2 });
  });

  it("one research at a time, no buying past max, and it must be affordable", () => {
    const world = createWorld(content, SETUP);
    world.teams[0].compute = 5000;
    expect(research(world, "anycast")).toEqual([]);
    expect(research(world, "autoscaling")).toEqual(["already researching"]);
    world.teams[0].research = null;
    world.teams[0].upgrades["anycast"] = content.upgrades.anycast!.maxLevel;
    expect(research(world, "anycast")).toEqual(["fully researched"]);
    world.teams[0].compute = 0;
    expect(research(world, "premium-tier")).toEqual(["not enough compute"]);
  });

  it("upgrades change unit HP, spawn speed, and user capacity", () => {
    const world = createWorld(content, SETUP);
    const team = world.teams[0];
    const capBefore = userCapacity(world, content, team);
    team.upgrades = { "hardened-containers": 2, "autoscaling": 1, "edge-caching": 1 };
    queueCommand(world, firstSpot("server-rack"));
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 0)) step(world, content);
    const unit = world.entities.find((e) => e.kind === "unit" && e.team === 0)!;
    const base = content.units.process!.hp * content.races["open-source"]!.modifiers.unitHpMultiplier;
    expect(unit.maxHp).toBe(Math.round(base * (1 + 2 * content.upgrades["hardened-containers"]!.perLevel)));
    expect(userCapacity(world, content, team)).toBe(Math.floor(capBefore * (1 + content.upgrades["edge-caching"]!.perLevel)));
    // The rack just spawned, so its timer was reset to the upgraded interval.
    const rack = world.entities.find((e) => e.kind === "building" && e.defId === "server-rack")!;
    const raceMul = content.races["open-source"]!.modifiers.spawnIntervalMultiplier;
    const speed = 1 + content.upgrades.autoscaling!.perLevel;
    const expected = Math.round((content.buildings["server-rack"]!.spawn!.intervalTicks * raceMul) / speed);
    expect(rack.kind === "building" && rack.spawnTimer).toBe(expected);
  });
});

describe("elevation", () => {
  const walkable = (tile: number) => tile !== TILE_BLOCKED && tile !== TILE_CLIFF;

  it("height only changes through ramps, and every walkable tile is reachable", () => {
    for (const seed of [1, 2, 3, 42, 1234, 77]) {
      const { terrain } = createWorld(content, { ...SETUP, seed });
      const { cols, tiles, heights } = terrain;
      let cliffs = 0;
      let ramps = 0;
      for (let i = 0; i < tiles.length; i++) {
        if (tiles[i] === TILE_CLIFF) cliffs++;
        if (tiles[i] === TILE_RAMP) ramps++;
        for (const n of [i + 1, i + cols]) {
          if (n >= tiles.length || (n === i + 1 && (i + 1) % cols === 0)) continue;
          if (!walkable(tiles[i]!) || !walkable(tiles[n]!)) continue;
          if (tiles[i] === TILE_RAMP || tiles[n] === TILE_RAMP) continue;
          expect(heights[i], `seed ${seed} tile ${i}`).toBe(heights[n]);
        }
      }
      expect(cliffs, `seed ${seed}`).toBeGreaterThan(100);
      expect(ramps, `seed ${seed}`).toBeGreaterThan(10);
      const field = flowField(terrain, [terrain.start.row * cols + terrain.start.col]);
      for (let i = 0; i < tiles.length; i++) {
        if (walkable(tiles[i]!)) expect(field[i], `seed ${seed} tile ${i} unreachable`).not.toBe(UNREACHABLE);
      }
    }
  });

  /** A low tile directly below a cliff, and the high tile behind it. */
  function cliffPair(world: ReturnType<typeof createWorld>) {
    const { cols, rows, tiles, heights } = world.terrain;
    for (let row = 2; row < rows - 2; row++) {
      for (let col = 2; col < cols - 6; col++) {
        const low = row * cols + col;
        // low | cliff | high | high ... far enough apart to test sight range
        const cliff = low + 1;
        const high = low + 4;
        if (tiles[low] !== 0 || tiles[cliff] !== TILE_CLIFF || tiles[high] !== 0) continue;
        if (heights[high]! <= heights[low]! || heights[low + 2] !== heights[high] || tiles[low + 2] === TILE_BLOCKED) continue;
        return { low: { x: (col + 0.5) * TILE, y: (row + 0.5) * TILE }, high: { x: (col + 4.5) * TILE, y: (row + 0.5) * TILE } };
      }
    }
    throw new Error("no cliff pair");
  }

  function unitAt(world: ReturnType<typeof createWorld>, team: 0 | 1, at: { x: number; y: number }) {
    return { kind: "unit", id: 900 + team, team, x: at.x, y: at.y, radius: 8, armor: 0, armorType: "container", hp: 1000, maxHp: 1000 } as unknown as Entity;
  }

  it("units walk around cliffs instead of into them", () => {
    // A cliff between here and there is not a straight path, even though
    // you can see across it.
    const world = createWorld(content, SETUP);
    const { low, high } = cliffPair(world);
    expect(hasLineOfSight(world.terrain, low.x, low.y, high.x, high.y)).toBe(true);
    expect(hasClearPath(world.terrain, low.x, low.y, high.x, high.y, 8)).toBe(false);
  });

  it("guards reach a rally point on another level", () => {
    const world = createWorld(content, SETUP);
    const core = world.entities.find((e) => e.id === world.teams[0].coreId)!;
    const { terrain } = world;
    const coreHeight = terrain.heights[Math.floor(core.y / TILE) * terrain.cols + Math.floor(core.x / TILE)];
    // The nearest open tile on a different level from the core.
    let target: { x: number; y: number } | null = null;
    for (let r = 3; r < 40 && !target; r++) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) {
        const col = Math.floor(core.x / TILE) + dc;
        const row = Math.floor(core.y / TILE) + dr;
        const i = row * terrain.cols + col;
        if (terrain.tiles[i] === 0 && terrain.heights[i] !== coreHeight) {
          target = { x: (col + 0.5) * TILE, y: (row + 0.5) * TILE };
          break;
        }
      }
    }
    expect(target).not.toBeNull();
    queueCommand(world, firstSpot("server-rack"));
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 0)) step(world, content);
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: world.teams[0].coreId, x: target!.x, y: target!.y });
    for (let i = 0; i < 20 * 90; i++) step(world, content);
    const guards = world.entities.filter((e) => e.kind === "unit" && e.team === 0);
    expect(guards.length).toBeGreaterThan(0);
    for (const g of guards) expect(Math.hypot(g.x - target!.x, g.y - target!.y)).toBeLessThan(90);
  });

  it("low ground can't see up a cliff; high ground can see down", () => {
    const world = createWorld(content, SETUP);
    const { low, high } = cliffPair(world);
    const ctx = makeContext(world, content);
    const below = unitAt(world, 1, low);
    const above = unitAt(world, 0, high);
    expect(canSee(ctx, below, above)).toBe(false);
    expect(canSee(ctx, above, below)).toBe(true);
  });

  it("attacking downhill hits harder", () => {
    const world = createWorld(content, SETUP);
    const { low, high } = cliffPair(world);
    const ctx = makeContext(world, content);
    const below = unitAt(world, 1, low);
    const above = unitAt(world, 0, high);
    const level = unitAt(world, 1, { x: high.x + TILE, y: high.y });
    dealDamage(ctx, above, below, "brute", 40);
    dealDamage(ctx, above, level, "brute", 40);
    const downhill = 1000 - below.hp;
    const flat = 1000 - level.hp;
    expect(downhill).toBe(Math.round(40 * content.damage.brute.container * 1.25));
    expect(flat).toBe(Math.round(40 * content.damage.brute.container));
  });
});

describe("network and redundancy", () => {
  const coreRadius = content.buildings.core!.buildRadius! * TILE;

  /** An open tile at a given distance (in tiles) from a point, in a fixed search order. */
  function openAt(world: ReturnType<typeof createWorld>, from: { x: number; y: number }, min: number, max: number) {
    const { terrain } = world;
    for (let r = min; r <= max; r++) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) {
        const col = Math.floor(from.x / TILE) + dc;
        const row = Math.floor(from.y / TILE) + dr;
        if (tileAt(terrain, col, row) === 0 && !isOccupied(world, col, row, 1)) return { col, row };
      }
    }
    return null;
  }

  it("each race extends its network differently", () => {
    const os = content.buildings[content.races["open-source"]!.buildings.find((b) => b === "mesh-node")!]!;
    const hyper = content.buildings[content.races.hyperscaler!.buildings.find((b) => b === "edge-pop")!]!;
    expect(os.buildRadius).toBeLessThan(hyper.buildRadius!);
    expect(os.cost).toBeLessThan(hyper.cost);
  });

  it("a finished mesh node lets you build beyond the core's radius; unfinished or destroyed, it doesn't", () => {
    const world = createWorld(content, SETUP);
    world.teams[0].compute = 5000;
    const core = world.entities.find((e) => e.id === world.teams[0].coreId)!;
    // A node near the edge of the core's reach.
    const node = openAt(world, core, 5, 6)!;
    queueCommand(world, { type: "build", tick: world.tick, team: 0, building: "mesh-node", col: node.col, row: node.row });
    step(world, content);
    const mesh = world.entities.find((e) => e.kind === "building" && e.defId === "mesh-node")!;
    // Somewhere the mesh node reaches but the core doesn't.
    let beyond: { col: number; row: number } | null = null;
    for (let r = 1; r <= 4 && !beyond; r++) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
        const col = node.col + dc;
        const row = node.row + dr;
        const cx = (col + 0.5) * TILE;
        const cy = (row + 0.5) * TILE;
        if (tileAt(world.terrain, col, row) !== 0 || Math.hypot(cx - core.x, cy - core.y) <= coreRadius) continue;
        beyond = { col, row };
        break;
      }
    }
    expect(beyond).not.toBeNull();
    const reason = () => canPlace(world, content, 0, "firewall", beyond!.col, beyond!.row);
    expect(reason()).toBe("outside your network"); // still under construction
    while (mesh.kind === "building" && mesh.buildRemaining > 0) step(world, content);
    expect(reason()).toBeNull();
    mesh.hp = 0;
    step(world, content);
    expect(reason()).toBe("outside your network");
  });

  it("you can build more cores; losing the main one fails over, and you only lose when every core is down", () => {
    const world = createWorld(content, SETUP);
    world.teams[0].compute = 5000;
    const first = world.entities.find((e) => e.id === world.teams[0].coreId)!;
    // A free 2x2 spot inside the network.
    let site: { col: number; row: number } | null = null;
    for (let r = 3; r <= 6 && !site; r++) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
        const col = Math.floor(first.x / TILE) + dc;
        const row = Math.floor(first.y / TILE) + dr;
        if (canPlace(world, content, 0, "core", col, row) === null) {
          site = { col, row };
          break;
        }
      }
    }
    expect(site).not.toBeNull();
    queueCommand(world, { type: "build", tick: world.tick, team: 0, building: "core", ...site! });
    step(world, content);
    const second = world.entities.find((e) => e.kind === "building" && e.defId === "core" && e.id !== first.id)!;
    while (second.kind === "building" && second.buildRemaining > 0) step(world, content);

    first.hp = 0;
    step(world, content);
    expect(world.outcome).toBeNull();
    expect(world.teams[0].coreId).toBe(second.id);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "failover", team: 0 }));

    second.hp = 0;
    step(world, content);
    expect(world.outcome).toMatchObject({ winner: 1 });
  });

  it("research continues at another core after failover", () => {
    const world = createWorld(content, SETUP);
    world.teams[0].compute = 5000;
    const first = world.entities.find((e) => e.id === world.teams[0].coreId)!;
    let site: { col: number; row: number } | null = null;
    for (let r = 3; r <= 6 && !site; r++) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
        const col = Math.floor(first.x / TILE) + dc;
        const row = Math.floor(first.y / TILE) + dr;
        if (canPlace(world, content, 0, "core", col, row) === null) {
          site = { col, row };
          break;
        }
      }
    }
    queueCommand(world, { type: "build", tick: world.tick, team: 0, building: "core", ...site! });
    step(world, content);
    const second = world.entities.find((e) => e.kind === "building" && e.defId === "core" && e.id !== first.id)!;
    while (second.kind === "building" && second.buildRemaining > 0) step(world, content);
    queueCommand(world, { type: "research", tick: world.tick, team: 0, upgrade: "anycast" });
    step(world, content);
    first.hp = 0;
    for (let i = 0; i < content.upgrades.anycast!.researchTicks + 5; i++) step(world, content);
    expect(levelOf(world.teams[0], "anycast")).toBe(1);
  });
});

describe("content", () => {
  it("rejects broken references", () => {
    const broken: Content = structuredClone(content);
    broken.waves.roster[0]!.unit = "missing";
    expect(() => validateContent(broken)).toThrow(/unknown unit missing/);
  });

  it("requires every race to have a 2x2 core", () => {
    const broken: Content = structuredClone(content);
    broken.races.botnet!.core = "server-rack";
    expect(() => validateContent(broken)).toThrow(/2x2 footprint/);
  });
});
