// Expansion: train a deploy agent at a core, found new cores across the
// map, each finished core raising the caps and rallying its own bubble.

import { describe, expect, it } from "vitest";
import {
  EXPANSION_CLEARANCE,
  TILE,
  TILE_OPEN,
  canFound,
  canPlace,
  createWorld,
  finishedCores,
  homeCore,
  queueCommand,
  rallyFor,
  step,
  tierBlocker,
  tierUpgrade,
  tileAt,
  userCapacity,
  type Building,
  type Unit,
  type World,
} from "../src/sim";
import { pastLimit } from "../src/sim/tiers";
import { placeBuilding } from "../src/sim/entities";
import { content, SETUP } from "./fixtures";

const TIER = tierUpgrade(content)!;
const CORE_COST = content.buildings[content.races["open-source"]!.core]!.cost;
const tiers = content.economy.tiers;

const team0 = (w: World) => w.teams[0]!;
const coreOf = (w: World) => w.entities.find((e): e is Building => e.id === team0(w).coreId)!;
const agentOf = (w: World) => w.entities.find((e): e is Unit => e.id === team0(w).builderId);
const rejections = (w: World) => w.events.flatMap((e) => (e.type === "rejected" ? [e.reason] : []));

/** A world with one trained deploy agent and the waves held back. */
function withAgent() {
  const world = createWorld(content, SETUP);
  world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
  const team = team0(world);
  team.money = 10_000;
  queueCommand(world, { type: "trainAgent", tick: world.tick, team: 0, coreId: team.coreId });
  step(world, content);
  return { world, team, core: coreOf(world), agent: agentOf(world)! };
}

/** Open 2x2 sites where canFound says yes, sorted by distance from the nest, farthest first. */
function foundableSites(world: World): { col: number; row: number; distSq: number }[] {
  const nest = world.terrain.nest;
  const out: { col: number; row: number; distSq: number }[] = [];
  for (let row = 2; row < world.terrain.rows - 3; row += 1) {
    for (let col = 2; col < world.terrain.cols - 3; col += 1) {
      if (canFound(world, content, 0, col, row) !== null) continue;
      const dx = col - nest.col;
      const dy = row - nest.row;
      out.push({ col, row, distSq: dx * dx + dy * dy });
    }
  }
  return out.sort((a, b) => b.distSq - a.distSq);
}

/** An open 1x1 tile `min`..`max` tiles from a point. */
function openNear(world: World, from: { col: number; row: number }, min: number, max: number): { col: number; row: number } | null {
  for (let r = min; r <= max; r += 1) {
    for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) {
      const col = from.col + dc;
      const row = from.row + dr;
      if (tileAt(world.terrain, col, row) === TILE_OPEN) return { col, row };
    }
  }
  return null;
}

describe("trainAgent", () => {
  it("spawns the race's deploy agent beside the core and charges the core's price", () => {
    const { team, core, agent } = withAgent();
    expect(team.money).toBe(10_000 - CORE_COST);
    expect(agent).toMatchObject({ kind: "unit", mode: "builder", defId: content.races[team.raceId]!.builder });
    expect(Math.hypot(agent.x - core.x, agent.y - core.y)).toBeLessThan(3 * TILE);
    expect(core.buildRemaining).toBe(0);
  });

  it("rejects a second agent while one is out", () => {
    const { world, team } = withAgent();
    const money = team.money;
    queueCommand(world, { type: "trainAgent", tick: world.tick, team: 0, coreId: team.coreId });
    step(world, content);
    expect(rejections(world)).toContain("an agent is already out");
    expect(team.money).toBe(money);
    expect(world.entities.filter((e): e is Unit => e.kind === "unit" && e.mode === "builder")).toHaveLength(1);
  });

  it("rejects a broke team, and a target that isn't one of your finished cores", () => {
    const world = createWorld(content, SETUP);
    world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
    const team = team0(world);
    const core = coreOf(world);
    const rack = placeBuilding(world, content, 0, "server-rack", core.col + 3, core.row, true);
    // An unfinished core doesn't count either.
    const open = openNear(world, core, 4, 8)!;
    const unfinished = placeBuilding(world, content, 0, "core", open.col, open.row, false);
    team.money = 0;
    for (const target of [999, rack.id]) {
      queueCommand(world, { type: "trainAgent", tick: world.tick, team: 0, coreId: target });
      step(world, content);
      expect(rejections(world)).toContain("not your core");
    }
    queueCommand(world, { type: "trainAgent", tick: world.tick, team: 0, coreId: unfinished.id });
    step(world, content);
    expect(rejections(world)).toContain("still building");
    queueCommand(world, { type: "trainAgent", tick: world.tick, team: 0, coreId: core.id });
    step(world, content);
    expect(rejections(world)).toContain("not enough $");
    expect(team.builderId).toBe(-1);
  });
});

describe("mid-match founding", () => {
  it("rejects a site within the clearance of the nest", () => {
    const { world, agent } = withAgent();
    const nest = world.terrain.nest;
    let site: { col: number; row: number } | null = null;
    for (let r = 3; r <= EXPANSION_CLEARANCE - 1 && !site; r += 1) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]] as const) {
        const col = nest.col + dc;
        const row = nest.row + dr;
        if (canFound(world, content, 0, col, row) === "too close to hostiles") {
          site = { col, row };
          break;
        }
      }
    }
    expect(site).not.toBeNull();
    queueCommand(world, { type: "found", tick: world.tick, team: 0, ...site! });
    step(world, content);
    expect(rejections(world)).toContain("too close to hostiles");
    expect(team0(world).builderId).toBe(agent.id);
  });

  it("founds an expansion at a far open site: built over buildTicks, core, users, waves and hero untouched, agent spent", () => {
    const { world, team, core, agent } = withAgent();
    const heroBefore = team.hero!.unitId;
    const site = foundableSites(world)[0]!;
    // Drop the agent beside the site so it arrives the tick the order lands.
    agent.x = (site.col + 1) * TILE + 60;
    agent.y = (site.row + 1) * TILE;
    team.users = 0;
    team.peakUsers = 0;
    queueCommand(world, { type: "found", tick: world.tick, team: 0, col: site.col, row: site.row });
    for (let i = 0; i < 5 && team.builderId !== -1; i += 1) step(world, content);
    expect(team.builderId).toBe(-1);
    expect(world.entities.some((e): e is Unit => e.kind === "unit" && e.mode === "builder")).toBe(false);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "expanded", team: 0 }));
    const expansion = world.entities.find((e): e is Building => e.kind === "building" && e.defId === "core" && e.id !== core.id)!;
    expect(expansion.col).toBe(site.col);
    expect(expansion.row).toBe(site.row);
    // Placed this tick or the one before: it has only just started building.
    expect(expansion.buildRemaining).toBeGreaterThan(content.buildings.core!.buildTicks - 3);
    expect(team.coreId).toBe(core.id);
    // No second hero, no user reset, no wave clock rewind: foundCore never ran.
    expect(team.hero!.unitId).toBe(heroBefore);
    expect(team.users).toBeLessThan(content.economy.startingUsers);
    expect(world.waves.nextWaveTick).toBe(1e9);
    expect(world.waves.nextTrickleTick).toBe(1e9);
    // Once finished it counts as a core.
    for (let i = 0; i < content.buildings.core!.buildTicks + 2; i += 1) step(world, content);
    expect(expansion.buildRemaining).toBe(0);
    expect(finishedCores(world, content, team)).toBe(2);
    expect(userCapacity(world, content, team)).toBe(content.buildings.core!.userCapacity! * 2);
    expect(world.entities.find((e): e is Unit => e.id === heroBefore)).toBeDefined();
  });

  it("an order on the agent's id walks it mid-match, while 'move' still means the hero", () => {
    const { world, team, agent } = withAgent();
    const spot = openNear(world, world.terrain.starts[0]!, 3, 8)!;
    const to = { x: (spot.col + 0.5) * TILE, y: (spot.row + 0.5) * TILE };
    queueCommand(world, { type: "order", tick: world.tick, team: 0, unitIds: [agent.id], x: to.x, y: to.y, attack: false });
    step(world, content);
    expect(agent.moveTo && Math.hypot(agent.moveTo.x - to.x, agent.moveTo.y - to.y) < 2).toBe(true);
    // The hero, not the agent, is what "move" means once a core is up.
    const hero = world.entities.find((e): e is Unit => e.id === team.hero!.unitId)!;
    queueCommand(world, { type: "move", tick: world.tick, team: 0, x: to.x, y: to.y });
    step(world, content);
    expect(hero.moveTo && Math.hypot(hero.moveTo.x - to.x, hero.moveTo.y - to.y) < 2).toBe(true);
  });
});

describe("agent death", () => {
  it("an agent that dies mid-match is gone without a refund, and says so", () => {
    const { world, team, agent } = withAgent();
    const money = team.money;
    agent.hp = 0;
    step(world, content);
    expect(team.builderId).toBe(-1);
    expect(team.money).toBe(money);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "agentLost", team: 0 }));
  });
});

describe("caps per core", () => {
  it("each finished core adds half the base limit; an unfinished one adds nothing", () => {
    const world = createWorld(content, SETUP);
    const team = team0(world);
    const L = content.buildings["web-app"]!.limitPerTier![0]!;
    const raised = L + Math.ceil(L / 2);
    expect(tierBlocker(content, team, "web-app", L, 1)).toBe(`only ${L} at ${tiers[0]!.name}`);
    expect(tierBlocker(content, team, "web-app", L, 2)).toBeNull();
    expect(tierBlocker(content, team, "web-app", raised, 2)).toBe(`only ${raised} at ${tiers[0]!.name}`);
    // An expansion under construction doesn't raise anything yet.
    const core = coreOf(world);
    const open = openNear(world, core, 4, 8)!;
    placeBuilding(world, content, 0, "core", open.col, open.row, false);
    expect(finishedCores(world, content, team)).toBe(1);
    expect(tierBlocker(content, team, "web-app", L, finishedCores(world, content, team))).toBe(`only ${L} at ${tiers[0]!.name}`);
  });

  it("the pastLimit price threshold rises with the caps", () => {
    const world = createWorld(content, SETUP);
    const team = team0(world);
    const TOP = tiers.length - 1;
    team.upgrades[TIER] = TOP;
    const def = content.buildings["solar-array"]!;
    const last = def.limitPerTier![TOP]!;
    expect(pastLimit(content, team, "solar-array", last, 1)).toBe(1);
    expect(pastLimit(content, team, "solar-array", last, 2)).toBe(0);
    // And so does the price of the next generator past the old cap.
    world.teams[0]!.money = 1e6;
    const spots: { col: number; row: number }[] = [];
    for (let r = coreOf(world).row - 5; r <= coreOf(world).row + 6 && spots.length < last + 1; r += 2) {
      for (let c = coreOf(world).col - 5; c <= coreOf(world).col + 6 && spots.length < last + 1; c += 2) spots.push({ col: c, row: r });
    }
    for (let i = 0; i < last; i += 1) placeBuilding(world, content, 0, "solar-array", spots[i]!.col, spots[i]!.row, true);
    const oneCore = buildPrice(world);
    const open = openNear(world, coreOf(world), 4, 8)!;
    placeBuilding(world, content, 0, "core", open.col, open.row, true);
    expect(finishedCores(world, content, team)).toBe(2);
    const twoCores = buildPrice(world);
    expect(twoCores).toBeLessThan(oneCore);

    function buildPrice(w: World) {
      const base = content.buildings["solar-array"]!.cost;
      const growth = def.costGrowthPermille ?? content.economy.costGrowthPermille ?? 0;
      const past = pastLimit(content, team, "solar-array", last, finishedCores(w, content, team)) * def.pastLimitGrowthPermille!;
      return Math.round((base * (1000 + growth * last + past)) / 1000);
    }
  });

  it("canPlace honours the raised limit", () => {
    const world = createWorld(content, SETUP);
    const team = team0(world);
    team.money = 1e6;
    const L = content.buildings["web-app"]!.limitPerTier![0]!;
    const core = coreOf(world);
    const spots: { col: number; row: number }[] = [];
    for (let r = core.row - 5; r <= core.row + 6; r += 3) {
      for (let c = core.col - 5; c <= core.col + 6; c += 3) spots.push({ col: c, row: r });
    }
    let placed = 0;
    for (const spot of spots) {
      if (placed >= L) break;
      if (canPlace(world, content, 0, "web-app", spot.col, spot.row) === null) {
        placeBuilding(world, content, 0, "web-app", spot.col, spot.row, true);
        placed += 1;
      }
    }
    expect(placed).toBe(L);
    // A second finished core raises the cap to L + ceil(L/2). It goes on a
    // spot that's still fully open.
    const open = spots.find(
      ({ col, row }) =>
        ([[0, 0], [0, 1], [1, 0], [1, 1]] as const).every(([dc, dr]) => tileAt(world.terrain, col + dc, row + dr) === TILE_OPEN) &&
        !world.entities.some((e) => e.kind === "building" && col < e.col + e.footprint && col + 2 > e.col && row < e.row + e.footprint && row + 2 > e.row),
    )!;
    placeBuilding(world, content, 0, "core", open.col, open.row, true);
    expect(finishedCores(world, content, team)).toBe(2);
    let more = 0;
    for (const spot of spots) {
      if (more >= Math.ceil(L / 2)) break;
      if (canPlace(world, content, 0, "web-app", spot.col, spot.row) === null) {
        placeBuilding(world, content, 0, "web-app", spot.col, spot.row, true);
        more += 1;
      }
    }
    expect(more).toBe(Math.ceil(L / 2));
    // Every spot that's otherwise fine now hits the raised cap (others are
    // occupied or off the network, which says nothing about the cap).
    const reasons = spots.map(({ col, row }) => canPlace(world, content, 0, "web-app", col, row));
    expect(reasons).toContain(`only ${L + Math.ceil(L / 2)} at ${content.economy.tiers[0]!.name}`);
    expect(reasons).not.toContain(null);
  });
});

describe("rally per core", () => {
  function twoCores() {
    const world = createWorld(content, SETUP);
    world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
    const team = team0(world);
    const coreA = coreOf(world);
    const open = openNear(world, coreA, 30, 60);
    const coreB = placeBuilding(world, content, 0, "core", open!.col, open!.row, true);
    const rackA = placeBuilding(world, content, 0, "server-rack", coreA.col + 2, coreA.row, true);
    const rackB = placeBuilding(world, content, 0, "server-rack", coreB.col + 2, coreB.row, true);
    return { world, team, coreA, coreB, rackA, rackB };
  }

  const guardsOf = (w: World, rack: Building) =>
    w.entities.filter((e): e is Unit => e.kind === "unit" && e.spawnerId === rack.id && e.hp > 0);

  it("a spawner with no rally of its own follows its nearest core", () => {
    const { world, team, coreA, coreB, rackA, rackB } = twoCores();
    expect(homeCore(world, content, rackA)!.id).toBe(coreA.id);
    expect(homeCore(world, content, rackB)!.id).toBe(coreB.id);
    const pointA = { x: coreA.x + 90, y: coreA.y };
    const pointB = { x: coreB.x + 90, y: coreB.y };
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: coreA.id, x: pointA.x, y: pointA.y });
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: coreB.id, x: pointB.x, y: pointB.y });
    step(world, content);
    expect(rallyFor(world, content, rackA)).toEqual(pointA);
    expect(rallyFor(world, content, rackB)).toEqual(pointB);
    rackA.spawnTimer = 1;
    rackB.spawnTimer = 1;
    step(world, content);
    for (const unit of guardsOf(world, rackA)) expect(Math.hypot(unit.homeX - pointA.x, unit.homeY - pointA.y)).toBeLessThanOrEqual(60);
    for (const unit of guardsOf(world, rackB)) expect(Math.hypot(unit.homeX - pointB.x, unit.homeY - pointB.y)).toBeLessThanOrEqual(60);
    void team;
  });

  it("when a core falls its spawners follow the next nearest core", () => {
    const { world, coreA, coreB, rackB } = twoCores();
    const pointA = { x: coreA.x + 90, y: coreA.y };
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: coreA.id, x: pointA.x, y: pointA.y });
    step(world, content);
    coreB.hp = 0;
    step(world, content);
    expect(rallyFor(world, content, rackB)).toEqual(pointA);
    rackB.spawnTimer = 1;
    step(world, content);
    for (const unit of guardsOf(world, rackB)) expect(Math.hypot(unit.homeX - pointA.x, unit.homeY - pointA.y)).toBeLessThanOrEqual(60);
  });

  it("rallying core A moves only the spawners whose home core is A", () => {
    const { world, coreA, coreB, rackA, rackB } = twoCores();
    const pointA = { x: coreA.x + 90, y: coreA.y };
    const pointB = { x: coreB.x - 90, y: coreB.y };
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: coreA.id, x: pointA.x, y: pointA.y });
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: coreB.id, x: pointB.x, y: pointB.y });
    step(world, content);
    rackA.spawnTimer = 1;
    rackB.spawnTimer = 1;
    step(world, content);
    const beforeB = guardsOf(world, rackB).map((u) => [u.homeX, u.homeY]);
    const moved = { x: pointA.x + 100, y: pointA.y + 50 };
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: coreA.id, x: moved.x, y: moved.y });
    step(world, content);
    for (const unit of guardsOf(world, rackA)) expect(Math.hypot(unit.homeX - moved.x, unit.homeY - moved.y)).toBeLessThanOrEqual(60);
    for (const [i, unit] of guardsOf(world, rackB).entries()) {
      expect([unit.homeX, unit.homeY]).toEqual(beforeB[i]);
      expect(Math.hypot(unit.homeX - pointB.x, unit.homeY - pointB.y)).toBeLessThanOrEqual(60);
    }
  });
});

describe("failover with an expansion under construction", () => {
  it("a finished core takes over before an expansion still building", () => {
    const world = createWorld(content, SETUP);
    world.waves.nextWaveTick = world.waves.nextTrickleTick = 1e9;
    const main = coreOf(world);
    // An expansion still building, placed first so it has the lower id.
    const building = openNear(world, main, 4, 8)!;
    const unfinished = placeBuilding(world, content, 0, "core", building.col, building.row, false);
    const done = openNear(world, main, 9, 14)!;
    const finished = placeBuilding(world, content, 0, "core", done.col, done.row, true);
    expect(unfinished.id).toBeLessThan(finished.id);
    main.hp = 0;
    step(world, content);
    expect(team0(world).coreId).toBe(finished.id);
  });
});

describe("the upgrade center stays one per team", () => {
  it("a second finished core doesn't allow a second upgrade center", () => {
    const world = createWorld(content, SETUP);
    const team = team0(world);
    const center = content.races[team.raceId]!.center!;
    expect(tierBlocker(content, team, center, 0, 2)).toBeNull();
    expect(tierBlocker(content, team, center, 1, 2)).toContain("only 1 at");
    // An economy building does get the raised cap.
    expect(tierBlocker(content, team, "web-app", content.buildings["web-app"]!.limitPerTier![0]!, 2)).toBeNull();
  });
});
