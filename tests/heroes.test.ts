// Heroes: picking one, leveling, skill points, abilities, death and respawn.

import { describe, expect, it } from "vitest";
import {
  createWorld,
  hashWorld,
  queueCommand,
  step,
  type Command,
  type MatchSetup,
  type Unit,
  type World,
} from "../src/sim";
import { abilityAmount, heroOf, levelForRank, skillPoints, xpForLevel } from "../src/sim/heroes";
import { spawnUnit } from "../src/sim/entities";
import { makeContext } from "../src/sim/context";
import { content } from "./fixtures";

const setup = (hero?: string, race = "open-source"): MatchSetup => ({
  seed: 1234,
  races: [race, "botnet"],
  heroes: [hero],
  startWithCore: true,
});

const team0 = (world: World) => world.teams[0]!;
const hero0 = (world: World) => heroOf(world, team0(world))!;

type Order = Command extends infer C ? (C extends Command ? Omit<C, "tick" | "team"> : never) : never;

function order(world: World, command: Order): void {
  queueCommand(world, { ...command, tick: world.tick, team: 0 } as Command);
  step(world, content);
}

/** A creep standing right next to the hero. */
function creepNear(world: World, unitId = "bot", dx = 40): Unit {
  const hero = hero0(world);
  const creep = spawnUnit(makeContext(world, content), 1, unitId, hero, hero.x + dx, hero.y, "roam");
  creep.packId = 9999;
  return creep;
}

function giveXp(world: World, level: number): void {
  const state = team0(world).hero!;
  state.xp = xpForLevel(content, level) - 1;
  // One cheap kill pushes it over.
  const creep = creepNear(world, "bot");
  creep.hp = 1;
  order(world, { type: "attack", targetId: creep.id });
  for (let i = 0; i < 40 && state.level < level; i += 1) step(world, content);
}

describe("heroes", () => {
  it("every race has several unique heroes, each with four unique abilities", () => {
    const seen = new Set<string>();
    for (const [raceId, race] of Object.entries(content.races)) {
      if (race.controller !== "human") continue;
      expect(race.heroes?.length, raceId).toBeGreaterThanOrEqual(3);
      for (const heroId of race.heroes!) {
        const def = content.heroes.heroes[heroId]!;
        expect(def.abilities).toHaveLength(4);
        for (const ability of def.abilities) {
          expect(seen.has(ability), `${ability} is shared`).toBe(false);
          seen.add(ability);
        }
        // The fourth is an ultimate: one rank, learned at level 6.
        const ult = content.heroes.abilities[def.abilities[3]!]!;
        expect(ult.maxRank).toBe(1);
        expect(ult.unlockLevel).toBe(6);
      }
    }
  });

  it("you play the hero you picked; it appears at the core", () => {
    for (const id of content.races["open-source"]!.heroes!) {
      const world = createWorld(content, setup(id));
      expect(team0(world).heroId).toBe(id);
      expect(hero0(world)).toMatchObject({ defId: id, mode: "hero" });
    }
    // Default: the race's first hero. Another race's hero is refused.
    expect(team0(createWorld(content, setup())).heroId).toBe("maintainer");
    expect(() => createWorld(content, setup("sre"))).toThrow();
  });

  it("in the builder start the hero appears when the core comes online", () => {
    const world = createWorld(content, { ...setup("bdfl"), startWithCore: false });
    expect(team0(world).hero).toBeNull();
    const { col, row } = world.terrain.starts[0]!;
    order(world, { type: "found", col, row });
    while (team0(world).coreId === -1 && world.tick < 400) step(world, content);
    expect(hero0(world)).toMatchObject({ defId: "bdfl" });
  });

  it("moves where it's told and attacks what it's told", () => {
    const world = createWorld(content, setup());
    const hero = hero0(world);
    const to = { x: hero.x + 120, y: hero.y };
    order(world, { type: "move", ...to });
    for (let i = 0; i < 120; i += 1) step(world, content);
    expect(Math.hypot(hero.x - to.x, hero.y - to.y)).toBeLessThan(12);

    const creep = creepNear(world, "trojan", 300);
    order(world, { type: "attack", targetId: creep.id });
    for (let i = 0; i < 400 && creep.hp > 0; i += 1) step(world, content);
    expect(creep.hp).toBeLessThanOrEqual(0);
  });

  it("kills near it give XP, XP gives levels, levels give hp and skill points", () => {
    const world = createWorld(content, setup());
    const hero = hero0(world);
    const state = team0(world).hero!;
    const hp1 = hero.maxHp;
    expect(state.level).toBe(1);
    expect(skillPoints(content, state)).toBe(1);

    giveXp(world, 2);
    expect(state.level).toBe(2);
    expect(hero.maxHp).toBe(hp1 + content.heroes.heroes.maintainer!.hpPerLevel);
    expect(skillPoints(content, state)).toBe(2);
    expect(world.tick).toBeGreaterThan(0);

    // Kills far from the hero don't count.
    const far = spawnUnit(makeContext(world, content), 1, "bot", hero, hero.x + 2000, hero.y, "roam");
    const before = state.xp;
    far.hp = 0;
    step(world, content);
    expect(state.xp).toBe(before);
  });

  it("skill points learn abilities; ranks are gated by level; ultimates wait for level 6", () => {
    const world = createWorld(content, setup("maintainer"));
    const state = team0(world).hero!;
    const [basic, , , ult] = content.heroes.heroes.maintainer!.abilities as [string, string, string, string];

    order(world, { type: "learn", ability: basic });
    expect(state.ranks[basic]).toBe(1);
    expect(skillPoints(content, state)).toBe(0);
    order(world, { type: "learn", ability: basic });
    expect(world.events.find((e) => e.type === "rejected")).toMatchObject({ reason: "no skill points" });

    giveXp(world, 2);
    order(world, { type: "learn", ability: basic });
    // Rank 2 needs level 3.
    expect(levelForRank(content, content.heroes.abilities[basic]!, 2)).toBe(3);
    expect(world.events.find((e) => e.type === "rejected")).toMatchObject({ reason: "needs level 3" });

    giveXp(world, 5);
    order(world, { type: "learn", ability: ult });
    expect(world.events.find((e) => e.type === "rejected")).toMatchObject({ reason: "needs level 6" });
    giveXp(world, 6);
    order(world, { type: "learn", ability: ult });
    expect(state.ranks[ult]).toBe(1);
    // Ranked-up abilities are stronger.
    const def = content.heroes.abilities[basic]!;
    expect(abilityAmount(def, 3)).toBeGreaterThan(abilityAmount(def, 1));
  });

  it("can't cast what it hasn't learned, or while on cooldown", () => {
    const world = createWorld(content, setup("bug-hunter"));
    const hero = hero0(world);
    order(world, { type: "cast", ability: "fuzzing", x: hero.x + 100, y: hero.y, targetId: null });
    expect(world.events.find((e) => e.type === "rejected")).toMatchObject({ reason: "not learned" });
    order(world, { type: "cast", ability: "veto", x: 0, y: 0, targetId: null });
    expect(world.events.find((e) => e.type === "rejected")).toMatchObject({ reason: "not your ability" });

    order(world, { type: "learn", ability: "fuzzing" });
    order(world, { type: "cast", ability: "fuzzing", x: hero.x + 100, y: hero.y, targetId: null });
    for (let i = 0; i < 5; i += 1) step(world, content);
    expect(team0(world).hero!.cooldowns.fuzzing).toBeGreaterThan(0);
    order(world, { type: "cast", ability: "fuzzing", x: hero.x + 100, y: hero.y, targetId: null });
    expect(world.events.find((e) => e.type === "rejected")).toMatchObject({ reason: "on cooldown" });
  });

  it("blast hits every enemy in the area and nothing outside it", () => {
    const world = createWorld(content, setup("bug-hunter"));
    order(world, { type: "learn", ability: "fuzzing" });
    const hero = hero0(world);
    const inside = [creepNear(world, "trojan", 200), creepNear(world, "trojan", 240)];
    const outside = creepNear(world, "trojan", 700);
    const hp = inside.map((c) => c.hp);
    order(world, { type: "cast", ability: "fuzzing", x: hero.x + 220, y: hero.y, targetId: null });
    for (let i = 0; i < 30 && !world.events.some((e) => e.type === "cast"); i += 1) step(world, content);
    inside.forEach((c, i) => expect(c.hp).toBeLessThan(hp[i]!));
    expect(outside.hp).toBe(outside.maxHp);
  });

  it("strike, heal, decoy, summon, and buff each do their thing", () => {
    // strike (walks into range first)
    let world = createWorld(content, setup("bug-hunter"));
    for (const id of ["fuzzing"]) order(world, { type: "learn", ability: id });
    giveXp(world, 7);
    order(world, { type: "learn", ability: "zero-day" });
    const boss = creepNear(world, "ransomware", 900);
    order(world, { type: "cast", ability: "zero-day", x: 0, y: 0, targetId: boss.id });
    for (let i = 0; i < 300 && boss.hp === boss.maxHp; i += 1) step(world, content);
    expect(boss.hp).toBeLessThan(boss.maxHp);

    // heal
    world = createWorld(content, setup("maintainer"));
    giveXp(world, 3);
    order(world, { type: "learn", ability: "hotfix" });
    const core = world.entities.find((e) => e.id === team0(world).coreId)!;
    core.hp = core.maxHp / 2;
    const hero = hero0(world);
    hero.x = core.x + 60;
    hero.y = core.y + 60;
    order(world, { type: "cast", ability: "hotfix", x: 0, y: 0, targetId: null });
    for (let i = 0; i < 5; i += 1) step(world, content);
    expect(core.hp).toBeGreaterThan(core.maxHp / 2);

    // decoy: nearby creeps switch to it
    world = createWorld(content, setup("bug-hunter"));
    giveXp(world, 3);
    order(world, { type: "learn", ability: "honeypot" });
    const h = hero0(world);
    // Creeps right next to the hero; the decoy goes down further away, so
    // only the lure (not "nearest enemy") explains them switching to it.
    const creeps = [creepNear(world, "trojan", 30), creepNear(world, "trojan", -30)];
    order(world, { type: "cast", ability: "honeypot", x: h.x, y: h.y + 230, targetId: null });
    for (let i = 0; i < 20; i += 1) step(world, content);
    const decoy = world.entities.find((e) => e.kind === "unit" && e.mode === "decoy")!;
    expect(decoy).toBeDefined();
    for (const c of creeps) if (c.hp > 0) expect(c.targetId).toBe(decoy.id);
    // They actually leave the hero for it and hit it, not just look at it.
    for (let i = 0; i < 80; i += 1) step(world, content);
    expect(decoy.hp).toBeLessThan(decoy.maxHp);
    expect(creeps.every((c) => c.hp <= 0 || Math.hypot(c.x - h.x, c.y - h.y) > 120)).toBe(true);
    // ...and it vanishes when its time is up.
    for (let i = 0; i < 260; i += 1) step(world, content);
    expect(world.entities.some((e) => e.kind === "unit" && e.mode === "decoy")).toBe(false);

    // summon: temporary units that leave on time
    world = createWorld(content, setup("maintainer"));
    giveXp(world, 5);
    order(world, { type: "learn", ability: "fork-bomb" });
    const guardsBefore = world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.defId === "process").length;
    order(world, { type: "cast", ability: "fork-bomb", x: 0, y: 0, targetId: null });
    step(world, content);
    const summoned = world.entities.filter((e) => e.kind === "unit" && e.team === 0 && e.defId === "process").length - guardsBefore;
    expect(summoned).toBe(abilityAmount(content.heroes.abilities["fork-bomb"]!, 1));

    // buff: every unit of yours hits harder while it runs
    world = createWorld(content, setup("evangelist", "hyperscaler"));
    order(world, { type: "learn", ability: "keynote" });
    order(world, { type: "cast", ability: "keynote", x: 0, y: 0, targetId: null });
    step(world, content);
    expect(team0(world).hero!.buff).toMatchObject({ amount: 0.3 });
  });

  it("a dead hero comes back at the core, later the higher its level", () => {
    const world = createWorld(content, setup());
    const state = team0(world).hero!;
    giveXp(world, 3);
    hero0(world).hp = 0;
    step(world, content);
    expect(state.unitId).toBe(-1);
    const def = content.heroes.heroes.maintainer!;
    expect(state.respawnAt).toBe(world.tick - 1 + def.respawnTicks + def.respawnPerLevel * 2);
    while (world.tick < state.respawnAt! + 1) step(world, content);
    const back = hero0(world);
    expect(back).toBeDefined();
    // Comes back at full health, keeping its level.
    expect(back.hp).toBe(back.maxHp);
    expect(state.level).toBe(3);
  });

  it("hero matches are deterministic", () => {
    const run = () => {
      const world = createWorld(content, setup("bdfl"));
      order(world, { type: "learn", ability: "veto" });
      const hero = hero0(world);
      queueCommand(world, { type: "move", tick: 20, team: 0, x: hero.x + 300, y: hero.y });
      while (world.tick < 3000 && !world.outcome) step(world, content);
      return hashWorld(world);
    };
    expect(run()).toBe(run());
  });
});

describe("hero UI text", () => {
  it("every ability can be described without throwing", async () => {
    // Guard against eager lookups (a summon's unit name read for every ability).
    const { HeroBar } = await import("../src/ui/hero-bar");
    const world = createWorld(content, setup());
    const session = { content, world, team: world.teams[0]! } as never;
    const bar = Object.create(HeroBar.prototype) as InstanceType<typeof HeroBar>;
    Object.assign(bar, { session });
    for (const id of Object.keys(content.heroes.abilities)) expect(() => bar.describe(id)).not.toThrow();
  });
});
