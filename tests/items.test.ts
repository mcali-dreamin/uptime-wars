// Items: the shop, the inventory, drops and pickups. Everything here goes
// through commands, so it replays; the drop roll lives on its own RNG.

import { describe, expect, it } from "vitest";
import {
  MAX_ITEMS,
  createWorld,
  footprintCenter,
  hashWorld,
  queueCommand,
  sellValue,
  simulate,
  step,
  type Building,
  type Command,
  type MatchSetup,
  type Unit,
  type World,
} from "../src/sim";
import { heroSpeed, itemTotals, rollDrop } from "../src/sim/items";
import { heroOf } from "../src/sim/heroes";
import { makeContext } from "../src/sim/context";
import { dealDamage } from "../src/sim/combat";
import { placeBuilding, spawnUnit } from "../src/sim/entities";
import { content, OPENING, SETUP } from "./fixtures";

const setup = (race = "open-source"): MatchSetup => ({
  seed: 1234,
  races: [race, "botnet"],
  startWithCore: true,
});

const team0 = (world: World) => world.teams[0]!;
const hero0 = (world: World) => heroOf(world, team0(world))!;
const state0 = (world: World) => team0(world).hero!;

type Order = Command extends infer C ? (C extends Command ? Omit<C, "tick" | "team"> : never) : never;

function order(world: World, command: Order): void {
  queueCommand(world, { ...command, tick: world.tick, team: 0 } as Command);
  step(world, content);
}

const rejected = (world: World) => world.events.find((e) => e.type === "rejected");

/** Take the hero out of core-heal reach and keep it there (open ground along the way out). */
function strandHero(world: World): Unit {
  const hero = hero0(world)!;
  const core = world.entities.find((e) => e.id === team0(world).coreId) as Building;
  const nest = world.entities.find((e) => e.id === world.teams[1]!.coreId) as Building;
  const dx = nest.x - core.x;
  const dy = nest.y - core.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  // Down the road toward the nest, far past the heal radius, where the map is open.
  const spot = footprintCenter(core.col, core.row, 2);
  hero.x = spot.x + (dx / length) * 640;
  hero.y = spot.y + (dy / length) * 640;
  hero.homeX = hero.x;
  hero.homeY = hero.y;
  hero.moveTo = null;
  return hero;
}

/** A team-0 fighter standing next to `victim`, ready to land the killing blow. */
function killerNear(world: World, victim: { x: number; y: number }): Unit {
  const attacker = spawnUnit(makeContext(world, content), 0, "process", victim as Unit, victim.x + 60, victim.y, "guard");
  attacker.homeX = attacker.x;
  attacker.homeY = attacker.y;
  return attacker;
}

const FARM = content.waves.fortress.farms.building;
const C2 = content.waves.fortress.building;
const BOSS = content.waves.bosses.unit;
const farmOf = (world: World) => world.entities.find((e): e is Building => e.kind === "building" && e.defId === FARM && e.hp > 0)!;
const c2Of = (world: World) => world.entities.find((e): e is Building => e.kind === "building" && e.defId === C2 && e.hp > 0)!;

/** Kill the first Botnet Farm with a team-0 unit and return the drop. */
function dropOne(world: World) {
  const victim = farmOf(world);
  const killer = killerNear(world, victim);
  victim.hp = 1;
  dealDamage(makeContext(world, content), killer, victim, 50);
  return world.groundItems[0]!;
}

/** Put a registry of `team` on the map and the hero `offset` px from its centre. */
function registryFor(world: World, team: number, opts: { finished?: boolean; offset?: number } = {}): Building {
  const core = world.entities.find((e) => e.id === team0(world).coreId) as Building;
  const registry = placeBuilding(world, content, team, "package-registry", core.col + 6, core.row, opts.finished ?? true);
  const hero = hero0(world);
  hero.x = registry.x + (opts.offset ?? 40);
  hero.y = registry.y;
  hero.homeX = hero.x;
  hero.homeY = hero.y;
  hero.moveTo = null;
  return registry;
}

/** A finished registry of team 0 right where the hero stands: for tests that just need to shop. */
function shopAtHero(world: World): Building {
  const core = world.entities.find((e) => e.id === team0(world).coreId) as Building;
  return placeBuilding(world, content, 0, "package-registry", core.col + 3, core.row, true);
}

/** Keep the hero out of the way of any registry, and next to the core only. */
const nearCoreOnly = (world: World) => {
  const hero = hero0(world);
  const core = world.entities.find((e) => e.id === team0(world).coreId) as Building;
  hero.x = core.x + 50;
  hero.y = core.y;
};

describe("the shop", () => {
  it("is not at the core any more", () => {
    const world = createWorld(content, setup());
    nearCoreOnly(world);
    order(world, { type: "buyItem", item: "overclock-chip" });
    expect(rejected(world)).toMatchObject({ reason: "hero not at a registry" });
    expect(state0(world).items).toEqual([]);
  });

  it("buys near a finished own registry, and refuses out of range", () => {
    const world = createWorld(content, setup());
    const registry = registryFor(world, 0);
    const money = team0(world).money;
    order(world, { type: "buyItem", item: "overclock-chip" });
    expect(rejected(world)).toBeUndefined();
    expect(state0(world).items).toEqual([{ item: "overclock-chip" }]);
    expect(team0(world).money).toBe(money - content.items.items["overclock-chip"]!.cost);

    const hero = hero0(world);
    hero.x = registry.x + content.items.shopRadius + registry.radius + 60;
    hero.homeX = hero.x;
    order(world, { type: "buyItem", item: "hardened-shell" });
    expect(rejected(world)).toMatchObject({ reason: "hero not at a registry" });
    expect(state0(world).items).toHaveLength(1);
  });

  it("does not open at an unfinished registry", () => {
    const world = createWorld(content, setup());
    registryFor(world, 0, { finished: false });
    order(world, { type: "buyItem", item: "overclock-chip" });
    expect(rejected(world)).toMatchObject({ reason: "hero not at a registry" });
  });

  it("does not open at an enemy's or an ally's registry", () => {
    const enemy = createWorld(content, setup());
    registryFor(enemy, 1);
    order(enemy, { type: "buyItem", item: "overclock-chip" });
    expect(rejected(enemy)).toMatchObject({ reason: "hero not at a registry" });

    const ally = createWorld(content, { seed: 1234, races: ["open-source", "open-source", "botnet"], startWithCore: true, rules: { sides: [0, 0] } });
    registryFor(ally, 1);
    order(ally, { type: "buyItem", item: "overclock-chip" });
    expect(rejected(ally)).toMatchObject({ reason: "hero not at a registry" });
  });

  it("needs the money and a free slot", () => {
    const world = createWorld(content, setup());
    registryFor(world, 0);
    team0(world).money = 0;
    order(world, { type: "buyItem", item: "overclock-chip" });
    expect(rejected(world)).toMatchObject({ reason: "not enough $" });

    team0(world).money = 100000;
    for (let i = 0; i < MAX_ITEMS; i += 1) order(world, { type: "buyItem", item: "patch-kit" });
    expect(state0(world).items).toHaveLength(MAX_ITEMS);
    order(world, { type: "buyItem", item: "patch-kit" });
    expect(rejected(world)).toMatchObject({ reason: "inventory full" });

    order(world, { type: "buyItem", item: "tensor-core" });
    expect(rejected(world)).toMatchObject({ reason: "not for sale" });
  });

  it("sells for part of the price under the same rule", () => {
    const world = createWorld(content, setup());
    const registry = registryFor(world, 0);
    team0(world).money += 100000;
    order(world, { type: "buyItem", item: "patch-kit" });
    const afterBuy = team0(world).money;
    order(world, { type: "sellItem", slot: 0 });
    expect(rejected(world)).toBeUndefined();
    expect(state0(world).items).toEqual([]);
    expect(team0(world).money).toBe(afterBuy + sellValue(content, "patch-kit"));

    // Out of range, or an unfinished registry: nothing sells.
    order(world, { type: "buyItem", item: "patch-kit" });
    const hero = hero0(world);
    hero.x = registry.x + 1000;
    hero.homeX = hero.x;
    order(world, { type: "sellItem", slot: 0 });
    expect(rejected(world)).toMatchObject({ reason: "hero not at a registry" });
    expect(state0(world).items).toHaveLength(1);

    hero.x = registry.x + 40;
    registry.buildRemaining = 5;
    order(world, { type: "sellItem", slot: 0 });
    expect(rejected(world)).toMatchObject({ reason: "hero not at a registry" });
    expect(state0(world).items).toHaveLength(1);
  });
});

describe("item stats", () => {
  it("extra RAM raises max HP, and the current HP with it", () => {
    const world = createWorld(content, setup());
    shopAtHero(world);
    team0(world).money += 100000;
    const hero = hero0(world)!;
    const before = hero.maxHp;
    order(world, { type: "buyItem", item: "extra-ram" });
    expect(hero.maxHp).toBe(before + content.items.items["extra-ram"]!.stats!.hp!);
    // It was full: the new memory is full too.
    expect(hero.hp).toBe(hero.maxHp);
    // Walk home is unnecessary: sell while still in range, hp is full so the core heals nothing.
    order(world, { type: "sellItem", slot: 0 });
    expect(hero.maxHp).toBe(before);
    expect(hero.hp).toBeLessThanOrEqual(hero.maxHp);
  });

  it("a chip hits harder, a shell soaks more, by exactly the carried amounts", () => {
    // One behavior tick, hero and creep toe to toe: the hit lands through the hero's own damage.
    const round = (chip: boolean, shell: boolean) => {
      const world = createWorld(content, setup());
      shopAtHero(world);
      team0(world).money += 100000;
      if (chip) order(world, { type: "buyItem", item: "overclock-chip" });
      if (shell) order(world, { type: "buyItem", item: "hardened-shell" });
      const hero = hero0(world)!;
      const creep = spawnUnit(makeContext(world, content), 1, "bot", hero, hero.x + 40, hero.y, "roam");
      creep.hp = 10000;
      const heroHp = hero.hp;
      step(world, content);
      return { dealt: 10000 - creep.hp, taken: heroHp - hero.hp };
    };
    const plain = round(false, false);
    const geared = round(true, true);
    expect(geared.dealt - plain.dealt).toBe(content.items.items["overclock-chip"]!.stats!.damage!);
    expect(plain.taken - geared.taken).toBe(content.items.items["hardened-shell"]!.stats!.armor!);
  });

  it("a link moves it faster; a watchdog mends it anywhere; a cache swings faster", () => {
    // Speed: both heroes march the same open first stretch toward the nest;
    // the geared one covers more of it per tick. Both runs burn one tick first
    // (a rejected buy is still a tick) so they march side by side.
    const march = (buy: boolean, ticks: number) => {
      const world = createWorld(content, setup());
      shopAtHero(world);
      team0(world).money += 100000;
      order(world, { type: "buyItem", item: buy ? "low-latency-link" : "tensor-core" });
      const hero = hero0(world)!;
      const nest = world.entities.find((e) => e.id === world.teams[1]!.coreId) as Building;
      const dx = nest.x - hero.x;
      const dy = nest.y - hero.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      order(world, { type: "move", x: hero.x + (dx / length) * 200, y: hero.y + (dy / length) * 200 });
      const start = { x: hero.x, y: hero.y };
      for (let i = 0; i < ticks; i += 1) step(world, content);
      return Math.sqrt((hero.x - start.x) * (hero.x - start.x) + (hero.y - start.y) * (hero.y - start.y));
    };
    const plain = march(false, 8);
    const geared = march(true, 8);
    expect(plain).toBeGreaterThan(0);
    expect(geared).toBeGreaterThan(plain);
    // The whole def-speed formula, exactly: +12% from the link.
    const linked = createWorld(content, setup());
    team0(linked).hero!.items.push({ item: "low-latency-link" });
    expect(heroSpeed(content, team0(linked), content.units["maintainer"]!.speed)).toBe(
      (content.units["maintainer"]!.speed * content.items.items["low-latency-link"]!.stats!.speed!) / 1000,
    );

    // Regen: three seconds away from any core, +3 HP each.
    const world = createWorld(content, setup());
    shopAtHero(world);
    world.waves.nextWaveTick = 1e9;
    world.waves.nextTrickleTick = 1e9;
    team0(world).money += 100000;
    order(world, { type: "buyItem", item: "watchdog" });
    const watcher = strandHero(world);
    watcher.hp = watcher.maxHp - 100;
    const hurt = watcher.hp;
    for (let i = 0; i < 61; i += 1) step(world, content);
    expect(watcher.hp).toBe(hurt + 3 * 3);

    // Attack speed: the cooldown after a swing shrinks by the cache's share.
    const swing = (cached: boolean) => {
      const world = createWorld(content, setup());
      if (cached) team0(world).hero!.items.push({ item: "write-cache" });
      const hero = hero0(world)!;
      const creep = spawnUnit(makeContext(world, content), 1, "bot", hero, hero.x + 40, hero.y, "roam");
      creep.hp = 10000;
      step(world, content);
      return hero.attackCooldown;
    };
    expect(swing(false)).toBe(content.units["maintainer"]!.cooldownTicks);
    expect(swing(true)).toBe(Math.round((content.units["maintainer"]!.cooldownTicks * 1000) / content.items.items["write-cache"]!.stats!.attackSpeed!));
  });

  it("the totals are the sum of everything carried", () => {
    const world = createWorld(content, setup());
    const state = state0(world);
    state.items = [
      { item: "overclock-chip" },
      { item: "hardened-shell" },
      { item: "watchdog" },
      { item: "watchdog", charges: 2 },
    ];
    const totals = itemTotals(content, state);
    expect(totals.damage).toBe(8);
    expect(totals.armor).toBe(2);
    expect(totals.regen).toBe(6);
    expect(totals.speed).toBe(1000);
  });
});

describe("consumables", () => {
  it("a Patch Kit heals nearby allies and spends its charges, then goes", () => {
    const world = createWorld(content, setup());
    shopAtHero(world);
    team0(world).money += 100000;
    order(world, { type: "buyItem", item: "patch-kit" });
    const core = world.entities.find((e) => e.id === team0(world).coreId) as Building;
    const active = content.items.items["patch-kit"]!.active!;
    core.hp = core.maxHp / 2;
    const hurt = core.hp;

    order(world, { type: "useItem", slot: 0 });
    expect(rejected(world)).toBeUndefined();
    expect(core.hp).toBe(Math.min(core.maxHp, hurt + active.amount));
    expect(state0(world).items[0]).toEqual({ item: "patch-kit", charges: 2 });

    // A passive item has nothing to use; an empty slot has nothing at all.
    order(world, { type: "buyItem", item: "overclock-chip" });
    order(world, { type: "useItem", slot: 1 });
    expect(rejected(world)).toMatchObject({ reason: "nothing to use" });

    order(world, { type: "useItem", slot: 0 });
    order(world, { type: "useItem", slot: 0 });
    expect(state0(world).items.some((s) => s.item === "patch-kit")).toBe(false);
    // The chip slid into slot 0; slot 5 has never been filled.
    order(world, { type: "useItem", slot: 5 });
    expect(rejected(world)).toMatchObject({ reason: "empty slot" });
  });
});

describe("death and drops", () => {
  it("the inventory survives death and respawn", () => {
    const world = createWorld(content, setup());
    shopAtHero(world);
    team0(world).money += 100000;
    order(world, { type: "buyItem", item: "extra-ram" });
    const state = state0(world);
    expect(state.items).toHaveLength(1);
    const hero = hero0(world)!;
    const maxHp = hero.maxHp;
    hero.hp = 0;
    step(world, content);
    expect(state.unitId).toBe(-1);
    expect(state.items).toHaveLength(1);
    while (world.tick < state.respawnAt! + 1) step(world, content);
    const back = hero0(world)!;
    expect(back.maxHp).toBe(maxHp);
    expect(state.items).toEqual([{ item: "extra-ram" }]);
  });

  it("farms, C2 Servers and bosses drop one item where they fell", () => {
    const table = content.items.drops.table.map((e) => e.item);

    // Farm.
    let world = createWorld(content, setup());
    let victim: Building | Unit = farmOf(world);
    let killer = killerNear(world, victim);
    victim.hp = 1;
    dealDamage(makeContext(world, content), killer, victim, 50);
    expect(world.groundItems).toHaveLength(1);
    expect(world.groundItems[0]).toMatchObject({ id: victim.id, x: victim.x, y: victim.y, team: 0 });
    expect(table).toContain(world.groundItems[0]!.item);

    // C2 Server.
    world = createWorld(content, setup());
    victim = c2Of(world);
    killer = killerNear(world, victim);
    victim.hp = 1;
    dealDamage(makeContext(world, content), killer, victim, 50);
    expect(world.groundItems).toHaveLength(1);
    expect(table).toContain(world.groundItems[0]!.item);

    // Boss.
    world = createWorld(content, setup());
    const spot = hero0(world)!;
    const boss = spawnUnit(makeContext(world, content), 1, BOSS, spot, spot.x + 400, spot.y, "roam");
    killer = killerNear(world, boss);
    boss.hp = 1;
    dealDamage(makeContext(world, content), killer, boss, 50);
    expect(world.groundItems).toHaveLength(1);
    expect(table).toContain(world.groundItems[0]!.item);

    // A plain creep is no source.
    world = createWorld(content, setup());
    const bot = spawnUnit(makeContext(world, content), 1, "bot", hero0(world)!, hero0(world)!.x + 400, hero0(world)!.y, "roam");
    killer = killerNear(world, bot);
    bot.hp = 1;
    dealDamage(makeContext(world, content), killer, bot, 50);
    expect(world.groundItems).toHaveLength(0);
  });

  it("the drop roll never touches the match RNG", () => {
    const world = createWorld(content, setup());
    const before = world.rngState;
    for (const source of ["farm", "c2", "boss"] as const) rollDrop(content, world.seed, source, 4711);
    expect(world.rngState).toBe(before);
    // And a real kill rolls nothing either (no retaliation on a C2 Server).
    const victim = c2Of(world);
    const killer = killerNear(world, victim);
    victim.hp = 1;
    const atKill = world.rngState;
    dealDamage(makeContext(world, content), killer, victim, 50);
    expect(world.rngState).toBe(atKill);
    expect(world.groundItems).toHaveLength(1);
    // The same dead entity always rolls the same item: no shared state at all.
    expect(rollDrop(content, world.seed, "c2", victim.id)).toBe(world.groundItems[0]!.item);
  });
});

/** The open plateau a little way from `spot`, toward the nest (farms ring the nest outward). */
function plateauNear(world: World, spot: { x: number; y: number }, range: number): { x: number; y: number } {
  const nest = world.entities.find((e) => e.id === world.teams[1]!.coreId) as Building;
  const dx = nest.x - spot.x;
  const dy = nest.y - spot.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  return { x: spot.x + (dx / length) * range, y: spot.y + (dy / length) * range };
}

describe("picking up", () => {
  it("needs a free slot, then walks there and takes it", () => {
    const world = createWorld(content, setup());
    shopAtHero(world);
    team0(world).money += 100000;
    for (let i = 0; i < MAX_ITEMS; i += 1) order(world, { type: "buyItem", item: "patch-kit" });
    const drop = dropOne(world);
    order(world, { type: "pickUp", itemId: drop.id });
    expect(rejected(world)).toMatchObject({ reason: "inventory full" });
    expect(state0(world).pickup).toBeNull();
    expect(world.groundItems).toHaveLength(1);

    // Make room, stand the hero on the plateau a stone's throw off, and order it again.
    order(world, { type: "sellItem", slot: 0 });
    const hero = hero0(world)!;
    const stood = plateauNear(world, drop, 110);
    hero.x = stood.x;
    hero.y = stood.y;
    hero.homeX = hero.x;
    hero.homeY = hero.y;
    order(world, { type: "pickUp", itemId: drop.id });
    expect(state0(world).pickup).toBe(drop.id);
    let steps = 0;
    while (world.groundItems.length > 0 && steps < 400) {
      step(world, content);
      steps += 1;
    }
    expect(world.groundItems).toHaveLength(0);
    expect(Math.hypot(hero.x - stood.x, hero.y - stood.y)).toBeGreaterThan(0);
    expect(state0(world).items.some((s) => s.item === drop.item)).toBe(true);
    expect(state0(world).pickup).toBeNull();
  });

  it("a new order forgets the pickup, and a gone item is let go", () => {
    const world = createWorld(content, setup());
    const drop = dropOne(world);
    const hero = hero0(world)!;
    const stood = plateauNear(world, drop, 110);
    hero.x = stood.x;
    hero.y = stood.y;
    hero.homeX = hero.x;
    hero.homeY = hero.y;
    order(world, { type: "pickUp", itemId: drop.id });
    expect(state0(world).pickup).toBe(drop.id);
    order(world, { type: "move", x: hero.x, y: hero.y });
    expect(state0(world).pickup).toBeNull();

    world.groundItems.length = 0;
    order(world, { type: "pickUp", itemId: drop.id });
    expect(rejected(world)).toMatchObject({ reason: "nothing there" });
  });
});

describe("determinism and replays", () => {
  it("a match with item commands hashes the same across two runs", () => {
    const run = () => {
      const world = createWorld(content, setup());
      world.waves.nextWaveTick = 1e9;
      world.waves.nextTrickleTick = 1e9;
      world.teams[0]!.money += 100000;
      order(world, { type: "buyItem", item: "patch-kit" });
      order(world, { type: "buyItem", item: "extra-ram" });
      order(world, { type: "useItem", slot: 0 });
      const drop = dropOne(world);
      const hero = hero0(world)!;
      const stood = plateauNear(world, drop, 110);
      hero.x = stood.x;
      hero.y = stood.y;
      hero.homeX = hero.x;
      hero.homeY = hero.y;
      order(world, { type: "pickUp", itemId: drop.id });
      for (let i = 0; i < 300 && world.groundItems.length > 0; i += 1) step(world, content);
      order(world, { type: "sellItem", slot: 0 });
      for (let i = 0; i < 200; i += 1) step(world, content);
      return hashWorld(world);
    };
    expect(run()).toBe(run());
  });

  it("a match with no item commands replays unchanged, with nothing on the ground", () => {
    const world = createWorld(content, SETUP);
    for (const command of OPENING) queueCommand(world, command);
    while (world.tick < 2000) step(world, content);
    expect(world.log.some((c) => ["buyItem", "sellItem", "useItem", "pickUp"].includes(c.type))).toBe(false);
    expect(world.groundItems).toEqual([]);
    expect(hashWorld(simulate(content, SETUP, world.log, 2000))).toBe(hashWorld(world));
  });
});
