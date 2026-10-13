import { describe, expect, it } from "vitest";
import {
  bonus,
  canPlace,
  canResearch,
  centerOf,
  createWorld,
  hashWorld,
  queueCommand,
  step,
  tierUpgrade,
  upgradesAt,
  type Building,
  type Unit,
  type World,
} from "../src/sim";
import { dealDamage } from "../src/sim/combat";
import { makeContext } from "../src/sim/context";
import { placeBuilding, spawnUnit } from "../src/sim/entities";
import { invoke } from "../src/sim/functions";
import { effectiveDef } from "../src/sim/traits";
import { content } from "./fixtures";

const TIER = tierUpgrade(content)!;
const PLAYABLE = Object.entries(content.races).filter(([, r]) => r.controller === "human");
const world = (race: string): World => {
  const w = createWorld(content, { seed: 1234, races: [race, "botnet"], startWithCore: true });
  w.waves.nextWaveTick = 1e9;
  return w;
};
const core = (w: World) => w.entities.find((e) => e.id === w.teams[0]!.coreId) as Building;
const learn = (w: World, id: string) => (w.teams[0]!.upgrades[id] = 1);
const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i += 1) step(w, content);
};
const center = (w: World) => placeBuilding(w, content, 0, content.races[w.teams[0]!.raceId]!.center!, core(w).col + 4, core(w).row, true);

describe("upgrade centers", () => {
  it("every race has one, and it researches the army: weapons, armor, HP, spawn speed, and three traits of its own", () => {
    for (const [raceId, race] of PLAYABLE) {
      expect(race.buildings, raceId).toContain(race.center);
      const w = world(raceId);
      const at = upgradesAt(content, w.teams[0]!, "center");
      expect(at, raceId).toEqual(expect.arrayContaining(["exploit-kits", "unit-armor", "hardened-containers", "autoscaling"]));
      const traits = at.filter((id) => content.upgrades[id]!.stat === "trait");
      expect(traits, raceId).toHaveLength(3);
      // Each race's traits are its own, on its own units.
      for (const t of traits) expect(content.upgrades[t]!.races).toEqual([raceId]);
      expect(upgradesAt(content, w.teams[0]!, "core")).not.toContain("exploit-kits");
    }
  });

  it("only one per player", () => {
    const w = world("open-source");
    w.teams[0]!.money = 1e6;
    center(w);
    const c = core(w);
    expect(canPlace(w, content, 0, "ci-server", c.col - 4, c.row)).toMatch(/^only 1/);
  });

  it("army research needs the center, runs alongside the core's, and stops if the center falls", () => {
    const w = world("open-source");
    const team = w.teams[0]!;
    team.money = 1e6;
    expect(canResearch(content, team, "exploit-kits", w)).toBe("needs a CI Server");
    const lab = center(w);
    expect(centerOf(w, content, team)).toBe(lab);
    queueCommand(w, { type: "research", tick: w.tick, team: 0, upgrade: TIER });
    queueCommand(w, { type: "research", tick: w.tick, team: 0, upgrade: "exploit-kits" });
    step(w, content);
    expect(w.events.filter((e) => e.type === "rejected")).toEqual([]);
    expect(team.research?.upgrade).toBe(TIER);
    expect(team.labResearch?.upgrade).toBe("exploit-kits");
    lab.hp = 0;
    run(w, 2);
    expect(team.labResearch).toBeNull();
    expect(team.research).not.toBeNull();
  });

  it("level 2 and 3 need a Data Center and a Region; traits need their unit's tier", () => {
    const w = world("open-source");
    const team = w.teams[0]!;
    team.money = 1e6;
    center(w);
    team.upgrades["exploit-kits"] = 1;
    expect(canResearch(content, team, "exploit-kits", w)).toBe(`needs ${content.economy.tiers[1]!.name}`);
    expect(canResearch(content, team, "open-weights", w)).toBe(`needs ${content.economy.tiers[1]!.name}`);
    expect(canResearch(content, team, "fork-on-exit", w)).toBeNull();
    team.upgrades[TIER] = 1;
    expect(canResearch(content, team, "exploit-kits", w)).toBeNull();
    expect(canResearch(content, w.teams[0]!, "batch-jobs", w)).toBe("not for your race");
  });
});

describe("core research: the race and its base", () => {
  it("Building Armor and Unit Armor take a flat amount off each hit", () => {
    const w = world("open-source");
    const ctx = makeContext(w, content);
    const c = core(w);
    const bot = spawnUnit(ctx, 1, "bot", c, c.x + 400, c.y, "roam");
    const hit = (target: Building | Unit) => {
      const before = target.hp;
      dealDamage(ctx, bot, target, 30, true);
      return before - target.hp;
    };
    const rack = placeBuilding(w, content, 0, "server-rack", c.col + 3, c.row, true);
    const plain = hit(rack);
    w.teams[0]!.upgrades["building-armor"] = 3;
    expect(bonus(content, w.teams[0]!, "buildingArmor")).toBe(3);
    expect(plain - hit(rack)).toBe(3);
    const proc = spawnUnit(ctx, 0, "process", c, c.x, c.y, "guard");
    const unarmored = hit(proc);
    w.teams[0]!.upgrades["unit-armor"] = 2;
    expect(unarmored - hit(proc)).toBe(2);
  });

  it("Building HP toughens what's standing (cores included) and what you build next", () => {
    const w = world("open-source");
    const team = w.teams[0]!;
    team.money = 1e6;
    const c = core(w);
    const rack = placeBuilding(w, content, 0, "server-rack", c.col + 3, c.row, true);
    const [coreHp, rackHp] = [c.maxHp, rack.maxHp];
    queueCommand(w, { type: "research", tick: w.tick, team: 0, upgrade: "building-hp" });
    run(w, content.upgrades["building-hp"]!.researchTicks + 5);
    const k = 1 + content.upgrades["building-hp"]!.perLevel;
    expect(c.maxHp).toBe(Math.round(coreHp * k));
    expect(rack.maxHp).toBe(Math.round(rackHp * k));
    const later = placeBuilding(w, content, 0, "firewall", c.col - 3, c.row, true);
    expect(later.maxHp).toBe(Math.round(content.buildings.firewall!.hp * k));
  });
});

describe("unit traits", () => {
  it("Fork on Exit: a Process splits in two when it dies, and its forks don't", () => {
    const w = world("open-source");
    learn(w, "fork-on-exit");
    const ctx = makeContext(w, content);
    const c = core(w);
    const p = spawnUnit(ctx, 0, "process", c, c.x + 60, c.y, "guard");
    const bot = spawnUnit(ctx, 1, "bot", c, c.x + 400, c.y, "roam");
    dealDamage(ctx, bot, p, 9999);
    const forks = w.entities.filter((e): e is Unit => e.kind === "unit" && e.defId === "process" && e.hp > 0);
    expect(forks).toHaveLength(2);
    for (const f of forks) dealDamage(ctx, bot, f, 9999);
    expect(w.entities.filter((e) => e.kind === "unit" && e.defId === "process" && e.hp > 0)).toHaveLength(0);
  });

  it("Self-Hosting: a Kernel brings back the first ally that falls near it, then waits", () => {
    const w = world("open-source");
    learn(w, "self-hosting");
    const ctx = makeContext(w, content);
    const c = core(w);
    spawnUnit(ctx, 0, "kernel", c, c.x + 40, c.y, "guard");
    const a = spawnUnit(ctx, 0, "process", c, c.x + 60, c.y, "guard");
    const b = spawnUnit(ctx, 0, "process", c, c.x + 70, c.y, "guard");
    const bot = spawnUnit(ctx, 1, "bot", c, c.x + 400, c.y, "roam");
    dealDamage(ctx, bot, a, 9999);
    expect(a.hp).toBeGreaterThan(0);
    dealDamage(ctx, bot, b, 9999);
    expect(b.hp).toBeLessThanOrEqual(0);
  });

  it("Open Weights and Edge Routing: range and speed, as units actually move and shoot", () => {
    const w = world("open-source");
    const ctx = makeContext(w, content);
    const drone = spawnUnit(ctx, 0, "inference-drone", core(w), core(w).x, core(w).y, "guard");
    const base = content.units["inference-drone"]!;
    expect(effectiveDef(content, w.teams[0], drone, base).range).toBe(base.range);
    learn(w, "open-weights");
    expect(effectiveDef(content, w.teams[0], drone, base).range).toBeCloseTo(base.range * 1.4);
    const h = world("hyperscaler");
    const swarm = spawnUnit(makeContext(h, content), 0, "cdn-swarm", core(h), core(h).x, core(h).y, "guard");
    const sb = content.units["cdn-swarm"]!;
    learn(h, "edge-routing");
    expect(effectiveDef(content, h.teams[0], swarm, sb).speed).toBeCloseTo(sb.speed * 1.35);
  });

  it("Edge Routing crits every third hit; Batch Jobs splashes; Batching chains", () => {
    const hits = (race: string, attackerId: string, trait: string) => {
      const w = world(race);
      learn(w, trait);
      const ctx = makeContext(w, content);
      const c = core(w);
      const att = spawnUnit(ctx, 0, attackerId, c, c.x, c.y, "guard");
      const bots = [0, 1, 2].map((i) => spawnUnit(ctx, 1, "bot", c, c.x + 500 + i * 20, c.y, "roam"));
      const before = bots.map((b) => b.hp);
      for (let i = 0; i < 3; i += 1) dealDamage(ctx, att, bots[0]!, 10);
      return bots.map((b, i) => before[i]! - b.hp);
    };
    const crit = hits("hyperscaler", "cdn-swarm", "edge-routing");
    const plain = (() => {
      const w = world("hyperscaler");
      const ctx = makeContext(w, content);
      const c = core(w);
      const att = spawnUnit(ctx, 0, "cdn-swarm", c, c.x, c.y, "guard");
      const bot = spawnUnit(ctx, 1, "bot", c, c.x + 500, c.y, "roam");
      const before = bot.hp;
      for (let i = 0; i < 3; i += 1) dealDamage(ctx, att, bot, 10);
      return before - bot.hp;
    })();
    expect(crit[0]!).toBeGreaterThan(plain);
    const splash = hits("hyperscaler", "mainframe", "batch-jobs");
    expect(splash[1]! + splash[2]!).toBeGreaterThan(0);
    const chain = hits("serverless", "inference-call", "batching");
    expect(chain[1]!).toBeGreaterThan(0);
  });

  it("Sticky Sessions: creeps near a Load Balancer turn on it", () => {
    const w = world("hyperscaler");
    const ctx = makeContext(w, content);
    const c = core(w);
    const lb = spawnUnit(ctx, 0, "load-balancer", c, c.x + 300, c.y, "guard");
    const bot = spawnUnit(ctx, 1, "bot", c, c.x + 440, c.y, "roam");
    // A Process right in the bot's face: without the taunt, that's what it fights.
    const near = spawnUnit(ctx, 0, "process", c, c.x + 455, c.y, "guard");
    const taunted = structuredClone(w);
    taunted.teams[0]!.upgrades["sticky-sessions"] = 1;
    w.teams[0]!.upgrades["sticky-sessions"] = 0;
    for (const ww of [w, taunted]) for (let i = 0; i < 20; i += 1) step(ww, content);
    const target = (ww: World) => (ww.entities.find((e) => e.id === bot.id) as Unit | undefined)?.targetId;
    expect(target(w)).toBe(near.id);
    expect(target(taunted)).toBe(lb.id);
  });

  it("Provisioned Concurrency and Parallel State: bigger bursts", () => {
    const burst = (trait: string | null, building: string) => {
      const w = world("serverless");
      if (trait) learn(w, trait);
      const ctx = makeContext(w, content);
      const c = core(w);
      const fn = placeBuilding(w, content, 0, building, c.col + 3, c.row, true);
      w.teams[0]!.money = 1e6;
      return invoke(ctx, fn, false).length;
    };
    expect(burst("provisioned-concurrency", "function")).toBe(burst(null, "function") + 2);
    expect(burst("parallel-state", "state-machine")).toBe(burst(null, "state-machine") * 2);
  });

  it("Shadowban disarms, Cease and Desist stuns, Hold the Line armors a Gatekeeper at its post", () => {
    const w = world("walled-garden");
    learn(w, "shadowban");
    learn(w, "cease-and-desist");
    learn(w, "hold-the-line");
    const ctx = makeContext(w, content);
    const c = core(w);
    const mod = spawnUnit(ctx, 0, "moderator", c, c.x, c.y, "guard");
    const legal = spawnUnit(ctx, 0, "legal-team", c, c.x, c.y, "guard");
    const bot = spawnUnit(ctx, 1, "bot", c, c.x + 500, c.y, "roam");
    dealDamage(ctx, mod, bot, 1);
    expect(bot.disarmedUntil).toBeGreaterThan(w.tick);
    dealDamage(ctx, legal, bot, 1);
    expect(bot.stunnedUntil).toBeGreaterThan(w.tick);
    const gk = spawnUnit(ctx, 0, "gatekeeper", c, c.x + 100, c.y, "guard");
    const before = gk.hp;
    dealDamage(ctx, bot, gk, 30, true);
    const held = before - gk.hp;
    gk.order = "move";
    const mid = gk.hp;
    dealDamage(ctx, bot, gk, 30, true);
    expect(mid - gk.hp - held).toBe(content.upgrades["hold-the-line"]!.trait!.holdArmor);
  });

  it("is deterministic with every trait in play", () => {
    const go = () => {
      const w = createWorld(content, { seed: 77, races: ["open-source", "hyperscaler", "botnet"], startWithCore: true });
      for (const id of Object.keys(content.upgrades)) if (content.upgrades[id]!.stat === "trait") {
        w.teams[0]!.upgrades[id] = 1;
        w.teams[1]!.upgrades[id] = 1;
      }
      run(w, 3000);
      return hashWorld(w);
    };
    expect(go()).toBe(go());
  });
});
