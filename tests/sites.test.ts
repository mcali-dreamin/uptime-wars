// Capturable sites ("derelict datacenters") and transferOwnership (#160 step 2).

import { describe, expect, it } from "vitest";
import {
  computeBalance,
  createWorld,
  hashWorld,
  incomeRate,
  neutralTeam,
  queueCommand,
  step,
  TICK_RATE,
  transferOwnership,
  type Building,
  type Unit,
  type World,
} from "../src/sim";
import { campSpots } from "../src/sim";
import { dealDamage, nearestEnemy } from "../src/sim/combat";
import { makeContext, buildGrid } from "../src/sim/context";
import { placeBuilding, spawnUnit } from "../src/sim/entities";
import { GUARD_RADIUS } from "../src/sim/tuning";
import { content, SETUP } from "./fixtures";

const sites = content.neutrals.sites;
const FFA = { seed: 1234, races: ["open-source", "hyperscaler"], mode: "ffa" as const, startWithCore: true };

function quiet(setup: Parameters<typeof createWorld>[1] = SETUP): World {
  const world = createWorld(content, setup);
  world.waves.nextWaveTick = 1e9;
  world.waves.nextTrickleTick = 1e9;
  return world;
}

const siteList = (world: World) => world.entities.filter((e): e is Building => e.kind === "building" && content.buildings[e.defId]!.site === true);
const ctxOf = (world: World) => {
  const ctx = makeContext(world, content);
  ctx.grid = buildGrid(world.entities);
  return ctx;
};

/** The first site with its camp's guards removed. */
function cleared(world: World): Building {
  const site = siteList(world)[0]!;
  world.entities = world.entities.filter((e) => !(e.kind === "unit" && e.campId === site.campId));
  return site;
}

/** A stunned unit of `team` standing on the site (stays put, hostile to the other team). */
function stand(world: World, site: Building, team: number, dx = 0): Unit {
  const unit = spawnUnit(ctxOf(world), team, "process", site, site.x + dx, site.y + site.radius + 40, "guard");
  unit.hp = unit.maxHp = 1e6;
  unit.stunnedUntil = 1e9;
  return unit;
}

const run = (world: World, ticks: number) => {
  for (let i = 0; i < ticks; i += 1) step(world, content);
};

describe("site placement", () => {
  it("one site at the center of every far camp, deterministic per seed", () => {
    for (const seed of [1234, 5, 77]) {
      const world = createWorld(content, { ...SETUP, seed });
      const camps = campSpots(world.terrain, content.neutrals).filter((s) => sites.tiers.includes(s.tier));
      const list = siteList(world);
      expect(list.length).toBe(camps.length);
      expect(list.length).toBeGreaterThan(0);
      for (const site of list) {
        const spot = campSpots(world.terrain, content.neutrals)[site.campId!]!;
        expect(sites.tiers).toContain(spot.tier);
        expect(site.x).toBe((spot.col + 0.5) * 48);
        expect(site.y).toBe((spot.row + 0.5) * 48);
        expect(site.team).toBe(neutralTeam(world)!.id);
      }
      expect(hashWorld(createWorld(content, { ...SETUP, seed }))).toBe(hashWorld(world));
    }
    expect(siteList(createWorld(content, SETUP)).length).toBe(4);
  });

  it("guards stand around the footprint, inside the leash", () => {
    const world = createWorld(content, SETUP);
    for (const site of siteList(world)) {
      const guards = world.entities.filter((e): e is Unit => e.kind === "unit" && e.campId === site.campId);
      expect(guards.length).toBeGreaterThan(0);
      for (const g of guards) {
        const half = (site.footprint * 48) / 2;
        const outside = Math.abs(g.x - site.x) > half + g.radius || Math.abs(g.y - site.y) > half + g.radius;
        expect(outside).toBe(true);
        expect(Math.hypot(g.x - g.homeX, g.y - g.homeY)).toBeLessThanOrEqual(GUARD_RADIUS);
      }
    }
  });
});

describe("capture", () => {
  it("is blocked while any guard of the camp lives", () => {
    const world = quiet();
    const site = siteList(world)[0]!;
    stand(world, site, 0);
    run(world, sites.captureTicks + 20);
    expect(site.team).toBe(neutralTeam(world)!.id);
    expect(site.captureProgress ?? 0).toBe(0);
  });

  it("completes after captureTicks with one team present, and says so", () => {
    const world = quiet();
    const site = cleared(world);
    stand(world, site, 0);
    run(world, sites.captureTicks - 1);
    expect(site.team).toBe(neutralTeam(world)!.id);
    expect(site.captureProgress).toBe(sites.captureTicks - 1);
    step(world, content);
    expect(site.team).toBe(0);
    expect(site.captureProgress ?? 0).toBe(0);
    expect(world.events).toContainEqual({ type: "siteCaptured", team: 0, from: neutralTeam(world)!.id, x: site.x, y: site.y, id: site.id });
  });

  it("pauses when two alliances are present", () => {
    const world = quiet(FFA);
    const site = cleared(world);
    stand(world, site, 0);
    run(world, 50);
    const mid = site.captureProgress;
    expect(mid).toBe(50);
    stand(world, site, 1, 20);
    run(world, 100);
    expect(site.captureProgress).toBe(mid);
    expect(site.team).toBe(neutralTeam(world)!.id);
  });

  it("drains when nobody is there", () => {
    const world = quiet();
    const site = cleared(world);
    const unit = stand(world, site, 0);
    run(world, 60);
    unit.hp = 0;
    run(world, 20);
    expect(site.captureProgress).toBe(40);
    run(world, 100);
    expect(site.captureProgress ?? 0).toBe(0);
    expect(site.captureTeam).toBeUndefined();
  });

  it("makes a rival drain the old progress first", () => {
    const world = quiet(FFA);
    const site = cleared(world);
    const a = stand(world, site, 0);
    run(world, 60);
    a.hp = 0;
    stand(world, site, 1);
    run(world, 59);
    expect(site.captureTeam).toBe(0);
    expect(site.captureProgress).toBe(1);
    run(world, 1);
    expect(site.captureProgress ?? 0).toBe(0);
    run(world, 1);
    expect(site.captureTeam).toBe(1);
    expect(site.captureProgress).toBe(1);
    run(world, sites.captureTicks);
    expect(site.team).toBe(1);
  });

  it("credits co-op allies to the team with the most units, ties to the lowest id", () => {
    const world = quiet({ seed: 1234, races: ["open-source", "hyperscaler"], startWithCore: true, mode: "coop", rules: { nestMustFall: false, diplomacy: "open" } });
    expect(world.allies[0]! >> 1 & 1).toBe(1);
    const site = cleared(world);
    stand(world, site, 1);
    stand(world, site, 0, 10);
    run(world, sites.captureTicks);
    expect(site.team).toBe(0);
  });
});

describe("owning a site", () => {
  it("adds its compute and income, and pays money over time", () => {
    const world = quiet();
    const site = cleared(world);
    const team = world.teams[0]!;
    const def = content.buildings[site.defId]!;
    const supply = computeBalance(world, content, team).supply;
    const rate = incomeRate(world, content, team).buildings;
    transferOwnership(ctxOf(world), site, 0);
    expect(computeBalance(world, content, team).supply).toBe(supply + def.compute!);
    expect(incomeRate(world, content, team).buildings).toBeCloseTo(rate + (def.income!.amount * TICK_RATE) / def.income!.intervalTicks);
    const neutral = neutralTeam(world)!;
    const before = team.money;
    run(world, def.income!.intervalTicks * 5);
    // Base income also ticks; the site adds at least five payouts.
    expect(team.money - before).toBeGreaterThanOrEqual(def.income!.amount * 5);
    expect(neutral.money).toBe(world.teams[neutral.id]!.money);
  });

  it("at 0 hp goes neutral at rearmPermille, stays, emits siteLost, and can be retaken", () => {
    const world = quiet(FFA);
    const site = cleared(world);
    transferOwnership(ctxOf(world), site, 0);
    const neutral = neutralTeam(world)!.id;
    const foe = stand(world, site, 1);
    const ctx = ctxOf(world);
    world.events = [];
    dealDamage(ctx, foe, site, 1e9);
    expect(site.hp).toBe(Math.round((site.maxHp * sites.rearmPermille) / 1000));
    expect(site.team).toBe(neutral);
    expect(world.entities).toContain(site);
    expect(world.events).toContainEqual({ type: "siteLost", team: 0, by: 1, x: site.x, y: site.y, id: site.id });
    expect(world.events.some((e) => e.type === "death" && e.id === site.id)).toBe(false);
    run(world, TICK_RATE * 3);
    expect(site.hp).toBeGreaterThan(Math.round((site.maxHp * sites.rearmPermille) / 1000));
    expect(world.entities).toContain(site);
    // Anyone can take it: the camp stays cleared.
    run(world, sites.captureTicks + 5);
    expect(site.team).toBe(1);
  });

  it("is never damaged while neutral, and is not a target", () => {
    const world = quiet(FFA);
    const site = cleared(world);
    const foe = stand(world, site, 0);
    const ctx = ctxOf(world);
    dealDamage(ctx, foe, site, 500);
    expect(site.hp).toBe(site.maxHp);
    expect(nearestEnemy(ctx, foe, 1000, (e) => e.kind === "building")).not.toBe(site);
    expect(nearestEnemy(ctx, foe, 1000, (e) => e.id === site.id)).toBeNull();
  });

  it("does not drive users away when it is damaged", () => {
    const world = quiet(FFA);
    const site = cleared(world);
    transferOwnership(ctxOf(world), site, 0);
    const foe = stand(world, site, 1);
    const users = world.teams[0]!.users;
    dealDamage(ctxOf(world), foe, site, 1000);
    expect(world.teams[0]!.users).toBe(users);
    expect(world.teams[0]!.churnCarry).toBe(0);
  });
});

describe("commands on a site", () => {
  it("are rejected: produce, upgrade queue, decommission, rally, rank, fork, build", () => {
    const world = quiet();
    const site = cleared(world);
    transferOwnership(ctxOf(world), site, 0);
    const col = site.col;
    const row = site.row;
    const rejected = () => world.events.filter((e) => e.type === "rejected");
    queueCommand(world, { type: "decommission", tick: world.tick, team: 0, buildingIds: [site.id] });
    queueCommand(world, { type: "rally", tick: world.tick, team: 0, buildingId: site.id, x: site.x, y: site.y + 200 });
    queueCommand(world, { type: "rank", tick: world.tick, team: 0, buildingId: site.id });
    queueCommand(world, { type: "invoke", tick: world.tick, team: 0, buildingId: site.id });
    queueCommand(world, { type: "fork", tick: world.tick, team: 0, sourceId: site.id, col: col + 10, row });
    queueCommand(world, { type: "build", tick: world.tick, team: 0, building: site.defId, col: col + 10, row });
    step(world, content);
    expect(rejected().length).toBe(6);
    expect(site.hp).toBeGreaterThan(0);
    expect(site.team).toBe(0);
    expect(content.buildings[site.defId]!.spawn).toBeUndefined();
    expect(content.buildings[site.defId]!.buildable).toBe(false);
  });
});

describe("outcome", () => {
  it("a team whose only standing building is a site still loses", () => {
    const world = quiet();
    const site = cleared(world);
    transferOwnership(ctxOf(world), site, 0);
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    core.hp = 0;
    run(world, 2);
    expect(world.teams[0]!.downTick).not.toBeNull();
    expect(site.hp).toBeGreaterThan(0);
    expect(world.outcome?.reason).toBe("all-offline");
  });
});

describe("transferOwnership", () => {
  it("emits siteCaptured / siteLost, resets timers and capture state", () => {
    const world = quiet();
    const site = cleared(world);
    const ctx = ctxOf(world);
    site.captureTeam = 0;
    site.captureProgress = 30;
    site.incomeTimer = 3;
    site.targetId = 99;
    site.attackCooldown = 5;
    world.events = [];
    transferOwnership(ctx, site, 0);
    expect(site.team).toBe(0);
    expect(site.captureProgress).toBeUndefined();
    expect(site.captureTeam).toBeUndefined();
    expect(site.targetId).toBeNull();
    expect(site.attackCooldown).toBe(0);
    expect(site.incomeTimer).toBe(content.buildings[site.defId]!.income!.intervalTicks);
    expect(world.events).toEqual([{ type: "siteCaptured", team: 0, from: neutralTeam(world)!.id, x: site.x, y: site.y, id: site.id }]);
    world.events = [];
    transferOwnership(ctx, site, neutralTeam(world)!.id, 1);
    expect(world.events).toEqual([{ type: "siteLost", team: 0, by: 1, x: site.x, y: site.y, id: site.id }]);
  });

  it("cancels and refunds an upgrade queue held at the building", () => {
    const world = quiet();
    const team = world.teams[0]!;
    const center = placeBuilding(world, content, 0, content.races[team.raceId]!.center!, 10, 10, true);
    team.labResearch = { upgrade: "exploit-kits", remaining: 100 };
    const first = content.upgrades["exploit-kits"]!.cost;
    team.labResearchQueue = [{ upgrade: "exploit-kits", ticks: 100, paid: first * 2 }];
    const money = team.money;
    transferOwnership(ctxOf(world), center, neutralTeam(world)!.id, 1);
    expect(team.labResearch).toBeNull();
    expect(team.labResearchQueue).toEqual([]);
    expect(team.money).toBe(money + first + first * 2);
    expect(center.team).toBe(neutralTeam(world)!.id);
  });

  it("is the only place the sim assigns entity.team", () => {
    const sources = import.meta.glob<string>("../src/sim/**/*.ts", { query: "?raw", import: "default", eager: true });
    const hits = Object.entries(sources)
      .filter(([path, text]) => !path.endsWith("ownership.ts") && /\b(entity|site|target|building|unit|e)\.team\s*=[^=]/.test(text))
      .map(([path]) => path);
    expect(hits).toEqual([]);
  });
});
