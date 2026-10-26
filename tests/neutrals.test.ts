import { describe, expect, it } from "vitest";
import { Alerts } from "../src/game/alerts";
import { HORDE_COLOR, NEUTRAL_COLOR, PLAYER_COLORS, teamColor } from "../src/render/palette";
import {
  EXPANSION_CLEARANCE,
  TICK_RATE,
  TILE,
  campSpots,
  createWorld,
  farmSpots,
  fortressSpots,
  generateTerrain,
  hashWorld,
  hordeTeam,
  hostile,
  humanTeams,
  neutralTeam,
  step,
  type Unit,
  type World,
} from "../src/sim";
import { makeContext } from "../src/sim/context";
import { dealDamage } from "../src/sim/combat";
import { spawnUnit } from "../src/sim/entities";
import { heroOf } from "../src/sim/heroes";
import { CAMP_SPACING, CAMP_TOLERANCE, GUARD_RADIUS, STARTING_MONEY } from "../src/sim/tuning";
import { content, SETUP } from "./fixtures";

const SEEDS = Array.from({ length: 12 }, (_, i) => i * 7919 + 1);
const plan = content.neutrals;
const tiles = Object.keys(plan.tiers);
const dist = (a: { col: number; row: number }, b: { col: number; row: number }) => Math.sqrt((a.col - b.col) ** 2 + (a.row - b.row) ** 2);
const center = (p: { col: number; row: number }) => ({ col: p.col + 1, row: p.row + 1 });

/** A quiet world: no waves, so only camps and the players' hero are about. */
function quiet(setup = SETUP): World {
  const world = createWorld(content, setup);
  world.waves.nextWaveTick = 1e9;
  world.waves.nextTrickleTick = 1e9;
  return world;
}

const guards = (world: World, campId?: number) =>
  world.entities.filter((e): e is Unit => e.kind === "unit" && e.team === neutralTeam(world)!.id && (campId === undefined || e.campId === campId));

describe("camp placement", () => {
  it("the same seed gives the same spots and compositions; other seeds give other spots", () => {
    for (const seed of SEEDS.slice(0, 4)) {
      expect(campSpots(generateTerrain(seed), plan)).toEqual(campSpots(generateTerrain(seed), plan));
    }
    const a = createWorld(content, { ...SETUP, seed: 5 });
    const b = createWorld(content, { ...SETUP, seed: 5 });
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(guards(a).map((u) => [u.campId, u.defId, u.x, u.y])).toEqual(guards(b).map((u) => [u.campId, u.defId, u.x, u.y]));
    expect(guards(a).length).toBeGreaterThan(0);
    const seen = new Set(SEEDS.map((seed) => JSON.stringify(campSpots(generateTerrain(seed), plan))));
    expect(seen.size).toBe(SEEDS.length);
  });

  it("every start gets camps of every tier (nearly always its full set), on open ground, clear of starts, the nest and its fortress", () => {
    const wanted = Object.values(plan.tiers).reduce((n, t) => n + t.count, 0);
    for (const seed of SEEDS) {
      const terrain = generateTerrain(seed);
      const spots = campSpots(terrain, plan);
      // A start boxed in by dead links may lose one camp to the spacing rule, never a whole tier.
      expect(spots.length, `seed ${seed}`).toBeGreaterThanOrEqual(wanted * terrain.starts.length - 1);
      for (const tier of tiles) for (let s = 0; s < terrain.starts.length; s += 1) expect(spots.some((p) => p.tier === tier && p.start === s), `seed ${seed} ${tier}`).toBe(true);
      const avoid = [...terrain.starts.map(center), center(terrain.nest), ...fortressSpots(terrain), ...farmSpots(terrain)];
      for (const spot of spots) {
        const i = spot.row * terrain.cols + spot.col;
        expect(terrain.tiles[i], `seed ${seed}`).toBe(0);
        for (const a of avoid) expect(dist(spot, a), `seed ${seed} ${JSON.stringify(spot)}`).toBeGreaterThanOrEqual(EXPANSION_CLEARANCE);
      }
      for (const [i, a] of spots.entries()) for (const b of spots.slice(i + 1)) expect(dist(a, b)).toBeGreaterThanOrEqual(CAMP_SPACING);
    }
  });

  it("is fair: each start's nearest camp of a tier is about as far as every other start's", () => {
    for (const seed of SEEDS) {
      const terrain = generateTerrain(seed);
      const spots = campSpots(terrain, plan);
      for (const tier of tiles) {
        const nearest = terrain.starts.map((s) => Math.min(...spots.filter((p) => p.tier === tier).map((p) => dist(p, center(s)))));
        expect(Math.max(...nearest) - Math.min(...nearest), `seed ${seed} ${tier}`).toBeLessThanOrEqual(2 * CAMP_TOLERANCE);
        for (const d of nearest) expect(Math.abs(d - plan.tiers[tier]!.fromStart), `seed ${seed} ${tier}`).toBeLessThanOrEqual(CAMP_TOLERANCE);
      }
    }
  });

  it("farther tiers are stronger", () => {
    const worth = (tier: string) => plan.tiers[tier]!.units.reduce((n, id) => n + content.units[id]!.hp, 0);
    expect(worth(tiles[0]!)).toBeLessThan(worth(tiles[1]!));
    expect(worth(tiles[1]!)).toBeLessThan(worth(tiles[2]!));
  });

  it("camp units pay more than ordinary units of similar strength", () => {
    expect(content.units["legacy-terminal"]!.bounty).toBeGreaterThan(content.units.bot!.bounty);
    expect(content.units["legacy-server"]!.bounty).toBeGreaterThan(content.units.trojan!.bounty);
    expect(content.units["legacy-mainframe"]!.bounty).toBeGreaterThan(content.units["brute-forcer"]!.bounty);
  });

  it("units stand at their camp, in guard mode, homed on its center", () => {
    const world = createWorld(content, SETUP);
    const spots = campSpots(world.terrain, plan);
    for (const unit of guards(world)) {
      const spot = spots[unit.campId!]!;
      expect(unit.mode).toBe("guard");
      expect(unit.homeX).toBe((spot.col + 0.5) * TILE);
      expect(unit.homeY).toBe((spot.row + 0.5) * TILE);
    }
  });
});

describe("the neutral team", () => {
  const world = createWorld(content, { seed: 77, races: ["open-source", "hyperscaler", "botnet"], startWithCore: true });
  const neutral = neutralTeam(world)!;

  it("comes after every setup team, so ids don't shift", () => {
    expect(neutral.id).toBe(3);
    expect(world.teams.slice(0, 3).map((t) => t.raceId)).toEqual(["open-source", "hyperscaler", "botnet"]);
  });

  it("is hostile to every team and every team to it", () => {
    for (const team of world.teams) {
      if (team.id === neutral.id) continue;
      expect(hostile(world, neutral.id, team.id)).toBe(true);
      expect(hostile(world, team.id, neutral.id)).toBe(true);
    }
    expect(hostile(world, neutral.id, neutral.id)).toBe(false);
    for (const mask of world.allies.slice(0, 3)) expect((mask >> neutral.id) & 1).toBe(0);
  });

  it("is neither a player nor the horde, and has no core, builder or hero", () => {
    expect(humanTeams(world).map((t) => t.id)).toEqual([0, 1]);
    expect(hordeTeam(world)!.id).toBe(2);
    expect(neutral.coreId).toBe(-1);
    expect(neutral.builderId).toBe(-1);
    expect(neutral.hero).toBeNull();
    expect(world.entities.some((e) => e.team === neutral.id && e.kind === "building" && !content.buildings[e.defId]!.site)).toBe(false);
  });

  it("never goes offline, never affects the outcome and earns no income", () => {
    const w = quiet();
    for (let i = 0; i < 12 * TICK_RATE; i += 1) step(w, content);
    const team = neutralTeam(w)!;
    expect(team.downTick).toBeNull();
    expect(team.money).toBe(STARTING_MONEY);
    expect(team.users).toBe(0);
    expect(w.outcome).toBeNull();
    expect(w.events.some((e) => e.type === "offline")).toBe(false);
  });

  it("has its own colour, apart from players and the horde", () => {
    expect(teamColor(world, neutral.id)).toBe(NEUTRAL_COLOR);
    expect([...PLAYER_COLORS, HORDE_COLOR]).not.toContain(NEUTRAL_COLOR);
  });
});

/** A stunned hostile unit of team 0, so it stays exactly where it is. */
function dummy(world: World, x: number, y: number): Unit {
  const unit = spawnUnit(makeContext(world, content), 0, "process", { x, y }, x, y, "guard");
  unit.hp = unit.maxHp = 1e6;
  unit.stunnedUntil = 1e9;
  return unit;
}

describe("camp behaviour", () => {
  it("never attacks first: a hostile unit in its face is left alone", () => {
    const world = quiet();
    const a = guards(world, 0)[0]!;
    const foe = dummy(world, a.x + 30, a.y);
    for (let i = 0; i < 3 * TICK_RATE; i += 1) step(world, content);
    expect(foe.hp).toBe(foe.maxHp);
  });

  it("fights back when hit, the whole camp, and only units (a building is not picked on)", () => {
    const world = quiet();
    const camp = guards(world, 0);
    const foe = dummy(world, camp[0]!.homeX + 40, camp[0]!.homeY);
    dealDamage(makeContext(world, content), foe, camp[0]!, 1);
    for (let i = 0; i < 2 * TICK_RATE; i += 1) step(world, content);
    expect(foe.hp).toBeLessThan(foe.maxHp);
  });

  it("pulled away, it walks home and doesn't chase past the leash", () => {
    const world = quiet();
    const unit = guards(world, 0)[0]!;
    const far = GUARD_RADIUS + 120;
    unit.x = unit.homeX + far;
    const foe = dummy(world, unit.x + 20, unit.y);
    dealDamage(makeContext(world, content), foe, unit, 1);
    const before = unit.x;
    for (let i = 0; i < 4 * TICK_RATE; i += 1) {
      step(world, content);
      expect(Math.hypot(unit.x - unit.homeX, unit.y - unit.homeY)).toBeLessThanOrEqual(far + 1);
    }
    expect(unit.x).toBeLessThan(before - 50);
    expect(foe.hp).toBe(foe.maxHp);
    for (let i = 0; i < 20 * TICK_RATE; i += 1) step(world, content);
    expect(Math.hypot(unit.x - unit.homeX, unit.y - unit.homeY)).toBeLessThan(GUARD_RADIUS / 2);
  });

  it("mends only while nothing hostile is within its leash", () => {
    const world = quiet();
    const hurt = (u: Unit) => (u.hp = Math.floor(u.maxHp / 2));
    const unit = guards(world, 0)[0]!;
    hurt(unit);
    const half = unit.hp;
    for (let i = 0; i < 3 * TICK_RATE; i += 1) step(world, content);
    expect(unit.hp).toBeGreaterThan(half);

    const other = guards(world, 1)[0]!;
    hurt(other);
    const stuck = other.hp;
    dummy(world, other.homeX + GUARD_RADIUS - 20, other.homeY);
    for (let i = 0; i < 3 * TICK_RATE; i += 1) step(world, content);
    expect(other.hp).toBe(stuck);

    // Long enough, an undisturbed camp is back to full.
    for (let i = 0; i < 20 * TICK_RATE; i += 1) step(world, content);
    expect(unit.hp).toBe(unit.maxHp);
  });
});

describe("rewards", () => {
  it("killing a camp unit pays its bounty and gives hero XP", () => {
    const world = quiet();
    const victim = guards(world, 0)[0]!;
    const hero = heroOf(world, world.teams[0]!)!;
    hero.x = victim.x;
    hero.y = victim.y;
    const team = world.teams[0]!;
    const money = team.money;
    const xp = team.hero!.xp;
    dealDamage(makeContext(world, content), hero, victim, 1e6);
    expect(team.money - money).toBe(content.units[victim.defId]!.bounty);
    expect(team.hero!.xp - xp).toBe(content.units[victim.defId]!.bounty * content.neutrals.xpPerBounty);
  });

  it("clearing a camp emits campCleared once, and the camp never comes back", () => {
    const world = quiet();
    const ctx = makeContext(world, content);
    const hero = heroOf(world, world.teams[0]!)!;
    const camp = guards(world, 0);
    const at = { x: camp[0]!.homeX, y: camp[0]!.homeY };
    for (const unit of camp) dealDamage(ctx, hero, unit, 1e6);
    expect(world.events.filter((e) => e.type === "campCleared")).toEqual([{ type: "campCleared", x: at.x, y: at.y, team: 0 }]);
    let again = 0;
    for (let i = 0; i < 90 * TICK_RATE; i += 1) {
      step(world, content);
      again += world.events.filter((e) => e.type === "campCleared").length;
    }
    expect(again).toBe(0);
    expect(guards(world, 0).filter((u) => u.hp > 0)).toHaveLength(0);
  });

  it("the cleared-camp alert goes to the team that cleared it, and no other", () => {
    const world = quiet();
    const alerts = new Alerts(content);
    const event = { type: "campCleared", x: 10, y: 20, team: 0 } as const;
    expect(alerts.update(world, [event], 1, 0, () => true)).toEqual([]);
    const raised = alerts.update(world, [event], 0, 0, () => true);
    expect(raised.map((a) => [a.kind, a.x, a.y])).toEqual([["camp", 10, 20]]);
  });
});
