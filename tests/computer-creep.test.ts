// Computer players creep (issue #160 step 3): clear neutral camps, take sites,
// and break a rival's capture, only in matches with rivals.

import { describe, expect, it } from "vitest";
import { TICK_RATE, TILE, campSpots, createWorld, hashWorld, neutralTeam, step, type Content, type Unit, type World } from "../src/sim";
import { playArmy, power } from "../src/sim/ai/army";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { BUILDING_SIGHT } from "../src/sim/tuning";
import { content as base } from "./fixtures";

const withCreep = (level: string, patch: Record<string, unknown>): Content => ({
  ...base,
  difficulties: {
    ...base.difficulties,
    [level]: { ...base.difficulties[level]!, creep: { ...base.difficulties[level]!.creep!, ...patch } },
  },
});
const ffa = (content: Content, seed: number, level: string, quiet = false): World => {
  const world = createWorld(content, { seed, mode: "ffa", races: ["open-source", "hyperscaler"], startWithCore: true, ai: [undefined, level] });
  if (quiet) {
    world.waves.nextWaveTick = 1e9;
    world.waves.nextTrickleTick = 1e9;
  }
  return world;
};
const guards = (world: World, camp: number) =>
  world.entities.filter((e): e is Unit => e.kind === "unit" && e.campId === camp && e.hp > 0);
const centerOf = (world: World, camp: number, content = base) => {
  const s = campSpots(world.terrain, content.neutrals)[camp]!;
  return { x: (s.col + 0.5) * TILE, y: (s.row + 0.5) * TILE };
};
const coreOf = (world: World, team: number) => world.entities.find((e) => e.id === world.teams[team]!.coreId)!;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

describe("power", () => {
  it("is hp x damage per second, rounded, from live hp", () => {
    const def = base.units["legacy-server"]!;
    const full = Math.round((def.hp * def.damage * TICK_RATE) / def.cooldownTicks);
    expect(power(base, [{ defId: "legacy-server", hp: def.hp }])).toBe(full);
    expect(power(base, [{ defId: "legacy-server", hp: def.hp }, { defId: "legacy-server", hp: def.hp }])).toBe(2 * full);
    expect(power(base, [{ defId: "legacy-server", hp: 0 }])).toBe(0);
    expect(power(base, [])).toBe(0);
    const half = power(base, [{ defId: "legacy-server", hp: def.hp / 2 }]);
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(0);
    expect(Number.isInteger(half)).toBe(true);
  });
});

describe("computer players creep camps", () => {
  it("a normal computer clears near camps before its first attack, and is paid for it", () => {
    const world = ffa(base, 42, "normal");
    const ai = world.teams[1]!.ai!;
    const spots = campSpots(world.terrain, base.neutrals);
    const team = world.teams[1]!;
    const neutral = neutralTeam(world)!.id;
    const standing = new Map<number, string>();
    for (const e of world.entities) if (e.kind === "unit" && e.team === neutral && e.campId !== undefined) standing.set(e.id, e.defId);
    let paid = false;
    let xpAtFirstClear = -1;
    let money = team.money;
    while (ai.phase !== "attack" && world.tick < 20 * 60 * TICK_RATE) {
      step(world, base);
      for (const [id, defId] of [...standing]) {
        const unit = world.entities.find((e) => e.id === id);
        if (unit && unit.hp > 0) continue;
        standing.delete(id);
        // The step a guard fell (and nothing else bought): the money rose by its bounty at least.
        if (team.money - money >= base.units[defId]!.bounty) paid = true;
        if (xpAtFirstClear < 0) xpAtFirstClear = team.hero!.xp;
      }
      money = team.money;
    }
    expect(ai.phase).toBe("attack");
    const cleared = spots.map((s, i) => ({ s, i })).filter(({ s, i }) => s.tier === "near" && guards(world, i).length === 0);
    expect(cleared.length).toBeGreaterThan(0);
    expect(paid).toBe(true);
    expect(team.hero!.xp).toBeGreaterThan(0);
    expect(xpAtFirstClear).toBeGreaterThanOrEqual(0);
  });

  it("goes for the nearest camp of an allowed tier it can beat, never a tier its difficulty excludes", () => {
    for (const [level, seed] of [["normal", 42], ["normal", 1], ["hard", 7]] as const) {
      const world = ffa(base, seed, level);
      const ai = world.teams[1]!.ai!;
      const allowed = base.difficulties[level]!.creep!.tiers;
      const spots = campSpots(world.terrain, base.neutrals);
      const core = coreOf(world, 1);
      let launches = 0;
      let phase = ai.phase;
      while (world.tick < 9000 && ai.phase !== "attack") {
        const standing = new Set(world.entities.filter((e) => e.kind === "unit" && e.campId !== undefined && e.hp > 0).map((e) => e.campId!));
        step(world, base);
        if (phase !== "creep" && ai.phase === "creep" && ai.creepKind === "camp") {
          launches += 1;
          expect(allowed).toContain(spots[ai.camp]!.tier);
          const mine = power(base, world.entities.filter((e): e is Unit => e.kind === "unit" && ai.group.includes(e.id)));
          const beatable = spots
            .map((s, i) => ({ s, i, p: power(base, base.neutrals.tiers[s.tier]!.units.map((defId) => ({ defId, hp: base.units[defId]!.hp }))) }))
            .filter(({ s, i, p }) => allowed.includes(s.tier) && standing.has(i) && mine * 1000 >= p * base.difficulties[level]!.creep!.oddsPermille);
          const nearest = beatable.map(({ i }) => ({ i, d: dist(centerOf(world, i), core) })).sort((a, b) => a.d - b.d)[0]!;
          expect(ai.camp).toBe(nearest.i);
        }
        phase = ai.phase;
      }
      expect(launches, `${level} ${seed}`).toBeGreaterThan(0);
    }
  });

  it("an easy computer never creeps", () => {
    const world = ffa(base, 42, "easy");
    while (world.tick < 7 * 60 * TICK_RATE) {
      step(world, base);
      expect(world.teams[1]!.ai!.phase).not.toBe("creep");
    }
  });

  it("doesn't go for a camp it can't beat, and pulls back when the creep goes bad", () => {
    const hopeless = withCreep("normal", { oddsPermille: 1e9 });
    const world = ffa(hopeless, 42, "normal");
    while (world.tick < 9000) {
      step(world, hopeless);
      expect(world.teams[1]!.ai!.phase).not.toBe("creep");
    }

    const real = ffa(base, 42, "normal");
    const ai = real.teams[1]!.ai!;
    while (ai.phase !== "creep" && real.tick < 9000) step(real, base);
    expect(ai.phase).toBe("creep");
    // The group is spent: far below what it set out with.
    ai.launched *= 100;
    const issued: string[] = [];
    playOnce(real, base, issued);
    expect(ai.phase).toBe("retreat");
    expect(issued).toContain("order");
  });

  it("gives up after giveUpTicks", () => {
    const quick = withCreep("normal", { giveUpTicks: 40 });
    const world = ffa(quick, 42, "normal");
    const ai = world.teams[1]!.ai!;
    while (ai.phase !== "creep" && world.tick < 9000) step(world, quick);
    expect(ai.phase).toBe("creep");
    while (ai.phase === "creep" && world.tick < 9000) step(world, quick);
    expect(ai.phase).toBe("retreat");
  });
});

function playOnce(world: World, content: Content, issued: string[]) {
  const team = world.teams[1]!;
  playArmy(world, content, team, content.difficulties.normal!.attack!, (c) => issued.push(c.type));
}

/** A quiet world with a site camp of the AI's own start cleared; returns where it is. */
function clearedSiteCamp(content: Content, level: string) {
  const world = ffa(content, 7, level, true);
  const spots = campSpots(world.terrain, content.neutrals);
  const camp = spots.findIndex((s) => s.start === 1 && content.neutrals.sites.tiers.includes(s.tier));
  for (const g of guards(world, camp)) g.hp = 0;
  const site = world.entities.find((e) => e.kind === "building" && e.campId === camp)!;
  return { world, camp, site };
}
const withRange = (level: string, extra: Record<string, unknown> = {}) => withCreep(level, { firstTicks: 1, siteRangeTiles: 200, ...extra });

describe("computer players take and contest sites", () => {
  it("captures a site after its camp is cleared, and the site ends up its team's", () => {
    const content = withRange("hard");
    const { world, site } = clearedSiteCamp(content, "hard");
    const ai = world.teams[1]!.ai!;
    expect(site.team).toBe(neutralTeam(world)!.id);
    let sent = 0;
    while (site.team !== 1 && world.tick < 20000) {
      step(world, content);
      if (ai.phase === "creep") sent = Math.max(sent, ai.group.length);
    }
    expect(site.team).toBe(1);
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(content.difficulties.hard!.creep!.siteUnits);
    // Then it goes home.
    while (ai.phase === "creep" && world.tick < 30000) step(world, content);
    expect(ai.phase).not.toBe("creep");
  });

  it("a person capturing a neutral site it can see draws its army there", () => {
    const content = withRange("hard", { minUnits: 1 });
    const { world, camp, site } = clearedSiteCamp(content, "hard");
    const ai = world.teams[1]!.ai!;
    const ctx = makeContext(world, content);
    // A person's units on the site, and one of the AI's watching nearby.
    spawnUnit(ctx, 0, "bot", site, site.x + 60, site.y, "guard");
    const watcher = spawnUnit(ctx, 1, "bot", site, site.x - BUILDING_SIGHT / 2, site.y, "guard");
    let contested = false;
    while (world.tick < 200 && !contested) {
      step(world, content);
      if (ai.phase === "creep" && ai.creepKind === "contest") contested = true;
    }
    expect(contested).toBe(true);
    expect(ai.camp).toBe(camp);
    expect(ai.group).toContain(watcher.id);
  });
});

describe("computer players only creep with rivals", () => {
  it("solo against the horde and in co-op, none of its units ever goes near a camp", () => {
    const solo = createWorld(base, { seed: 99, races: ["hyperscaler", "botnet"], startWithCore: true, ai: ["hard"] });
    const coop = createWorld(base, { seed: 99, races: ["hyperscaler", "serverless", "botnet"], startWithCore: true, ai: [undefined, "hard"] });
    for (const [world, team] of [[solo, 0], [coop, 1]] as const) {
      const spots = campSpots(world.terrain, base.neutrals).map((_, i) => centerOf(world, i));
      let closest = Infinity;
      while (world.tick < 8 * 60 * TICK_RATE) {
        step(world, base);
        expect(world.teams[team]!.ai!.phase).toBe("gather");
        if (world.tick % 10 !== 0) continue;
        for (const e of world.entities) {
          if (e.kind !== "unit" || e.team !== team) continue;
          for (const c of spots) closest = Math.min(closest, dist(e, c));
        }
      }
      expect(closest).toBeGreaterThan(TILE * 6);
    }
  });
});

describe("determinism", () => {
  it("two identical free-for-all runs with creeping computers hash the same", () => {
    const setup = { seed: 2026, mode: "ffa" as const, races: ["hyperscaler", "open-source", "walled-garden"], startWithCore: true, ai: ["hard", "normal", "insane"] };
    const a = createWorld(base, setup);
    const b = createWorld(base, setup);
    let creeped = false;
    while (a.tick < 6 * 60 * TICK_RATE) {
      step(a, base);
      step(b, base);
      if (a.teams.some((t) => t.ai?.phase === "creep")) creeped = true;
    }
    expect(creeped).toBe(true);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });
});
