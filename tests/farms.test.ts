import { describe, expect, it } from "vitest";
import { createWorld, farmSpots, farmsDown, generateTerrain, planWave, queueCommand, step, type Building, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { dealDamage } from "../src/sim/combat";
import { spawnUnit } from "../src/sim/entities";
import { INVULNERABLE } from "../src/sim/fortress";
import { heroOf } from "../src/sim/heroes";
import { content, SETUP } from "./fixtures";

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 1);
const FARM = content.waves.fortress.farms.building;
const farms = (world: World) => world.entities.filter((e): e is Building => e.kind === "building" && e.team === 1 && e.defId === FARM && e.hp > 0);

describe("Botnet Farms", () => {
  it("every map's fortress has room for four farms on the plateau", () => {
    for (const seed of SEEDS) expect(farmSpots(generateTerrain(seed)).length, `seed ${seed}`).toBe(4);
  });

  it("farms stand from the first tick and garrison the fortress", () => {
    const world = createWorld(content, SETUP);
    expect(farms(world)).toHaveLength(4);
    world.waves.nextWaveTick = 1e9;
    for (let i = 0; i < 400; i++) step(world, content);
    const garrison = world.entities.filter((e) => e.kind === "unit" && e.team === 1 && e.mode === "guard");
    expect(garrison.length).toBeGreaterThan(0);
  });

  it("destroying a farm sends a retaliation pack marching on the attacker", () => {
    const world = createWorld(content, SETUP);
    world.waves.nextWaveTick = 1e9;
    world.waves.nextIndex = 5;
    const farm = farms(world)[0]!;
    const ctx = makeContext(world, content);
    const attacker = spawnUnit(ctx, 0, "process", farm, farm.x + 80, farm.y, "guard");
    farm.hp = 1;
    dealDamage(ctx, attacker, farm, 50);
    const event = world.events.find((e) => e.type === "retaliation");
    expect(event).toBeDefined();
    const pack = world.waves.pending.at(-1)!.packId;
    expect(world.waves.packs[pack]).toEqual({ x: attacker.x, y: attacker.y });
    const expected = Math.floor((planWave(createWorld(content, SETUP), content, 5).units.length * content.waves.fortress.farms.retaliationPermille) / 1000);
    expect(world.waves.pending.filter((p) => p.packId === pack).length).toBeGreaterThanOrEqual(Math.min(1, expected));
  });

  it("every farm down shrinks later waves, and they come back on the rebuild wave", () => {
    const world = createWorld(content, SETUP);
    const full = planWave(createWorld(content, SETUP), content, 6).units.length;
    for (const f of farms(world)) f.hp = 0;
    step(world, content);
    expect(farmsDown(world, content, 1)).toBe(4);
    const weakened = planWave(createWorld(content, SETUP), content, 6, 1000 - 4 * content.waves.fortress.farms.weakenPermille).units.length;
    expect(weakened).toBeLessThan(full);
    // Jump to just before the rebuild incident instead of simulating every wave up to it.
    world.waves.nextIndex = content.waves.fortress.farms.rebuildEvery - 1;
    world.waves.nextWaveTick = world.tick + 1;
    world.waves.nextTrickleTick = 1e9;
    for (let i = 0; i < 5 && farms(world).length < 4; i++) step(world, content);
    expect(farms(world)).toHaveLength(4);
  });
});

describe("the nest's shield", () => {
  const nestOf = (world: World) => world.entities.find((e) => e.id === world.teams[1]!.coreId)!;
  const attackerAt = (world: World) => {
    const ctx = makeContext(world, content);
    const nest = nestOf(world);
    return { ctx, attacker: spawnUnit(ctx, 0, "process", nest, nest.x + 60, nest.y, "guard") };
  };

  it("takes no damage while any Botnet Farm stands", () => {
    const world = createWorld(content, SETUP);
    const nest = nestOf(world);
    for (const f of farms(world).slice(1)) f.hp = 0;
    const { ctx, attacker } = attackerAt(world);
    const hp = nest.hp;
    dealDamage(ctx, attacker, nest, 500);
    expect(nest.hp).toBe(hp);
    expect(world.events.some((e) => e.type === "nest-shielded" && e.team === 0)).toBe(true);
  });

  // WC3's invulnerable: a shielded nest can't be attacked at all, so units
  // don't park on it, and don't snap back to it after a move order.
  describe("can't be attacked while shielded", () => {
    /** The nest, a lone unit of ours beside it, and no botnet units to distract it. */
    const besideNest = () => {
      const world = createWorld(content, SETUP);
      world.waves.nextWaveTick = 1e9;
      world.waves.nextTrickleTick = 1e9;
      const nest = nestOf(world);
      const { attacker } = attackerAt(world);
      // Tough enough to outlast the fortress's towers for the test.
      attacker.hp = attacker.maxHp = 1e9;
      const quiet = () => {
        world.entities = world.entities.filter((e) => !(e.kind === "unit" && e.team === 1));
      };
      quiet();
      return { world, nest, unit: attacker, quiet };
    };
    const run = (world: World, quiet: () => void, ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        quiet();
        step(world, content);
      }
    };

    it("units beside it never target it, so nothing holds them there", () => {
      const { world, nest, unit, quiet } = besideNest();
      const hp = nest.hp;
      for (let i = 0; i < 200; i++) {
        run(world, quiet, 1);
        expect(unit.targetId).not.toBe(nest.id);
      }
      expect(nest.hp).toBe(hp);
      expect(world.events.some((e) => e.type === "nest-shielded")).toBe(false);
    });

    it("refuses a hero's attack order on it", () => {
      const world = createWorld(content, SETUP);
      const nest = nestOf(world);
      expect(heroOf(world, world.teams[0]!)).toBeDefined();
      queueCommand(world, { type: "attack", tick: world.tick, team: 0, targetId: nest.id });
      step(world, content);
      expect(world.events.find((e) => e.type === "rejected")).toMatchObject({ reason: INVULNERABLE });
      expect(world.teams[0]!.hero!.focusId).toBeNull();
    });

    it("becomes a target again once the last farm falls", () => {
      const { world, nest, unit, quiet } = besideNest();
      for (const f of farms(world)) f.hp = 0;
      run(world, quiet, 60);
      expect(unit.targetId).toBe(nest.id);
      expect(nest.hp).toBeLessThan(nest.maxHp);
    });
  });

  it("drops when the last farm falls, and the retaliation says so", () => {
    const world = createWorld(content, SETUP);
    const nest = nestOf(world);
    const [last, ...rest] = farms(world);
    for (const f of rest) f.hp = 0;
    const { ctx, attacker } = attackerAt(world);
    last!.hp = 1;
    dealDamage(ctx, attacker, last!, 50);
    expect(world.events.find((e) => e.type === "retaliation")).toMatchObject({ farmsLeft: 0 });
    const hp = nest.hp;
    dealDamage(ctx, attacker, nest, 500);
    expect(nest.hp).toBeLessThan(hp);
  });

  it("comes back up when the botnet rebuilds its farms", () => {
    const world = createWorld(content, SETUP);
    for (const f of farms(world)) f.hp = 0;
    step(world, content);
    world.waves.nextIndex = content.waves.fortress.farms.rebuildEvery - 1;
    world.waves.nextWaveTick = world.tick + 1;
    world.waves.nextTrickleTick = 1e9;
    for (let i = 0; i < 5 && farms(world).length < 4; i++) step(world, content);
    const { ctx, attacker } = attackerAt(world);
    const nest = nestOf(world);
    const hp = nest.hp;
    dealDamage(ctx, attacker, nest, 500);
    expect(nest.hp).toBe(hp);
  });

  it("taking the nest offline collapses the whole botnet and wins", () => {
    const world = createWorld(content, SETUP);
    world.waves.nextWaveTick = 1e9;
    for (let i = 0; i < 400; i++) step(world, content);
    world.waves.pending.push({ tick: world.tick + 100, unit: "bot", packId: 0, wave: 1 });
    expect(world.entities.filter((e) => e.team === 1 && e.hp > 0).length).toBeGreaterThan(5);
    for (const f of farms(world)) f.hp = 0;
    step(world, content);
    const { ctx, attacker } = attackerAt(world);
    const nest = nestOf(world);
    nest.hp = 1;
    dealDamage(ctx, attacker, nest, 50);
    step(world, content);
    expect(world.outcome).toMatchObject({ winners: [0], reason: "nest-offline" });
    expect(world.entities.filter((e) => e.team === 1)).toHaveLength(0);
    expect(world.waves.pending).toHaveLength(0);
    expect(world.events.some((e) => e.type === "collapsed")).toBe(true);
  });
});
