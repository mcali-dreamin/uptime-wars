// The upgrade queue at the core and the upgrade center: stack upgrades, pay
// when queued, cancel for a refund, and wait at the head for a core tier.

import { describe, expect, it } from "vitest";
import {
  canResearch,
  createWorld,
  hashWorld,
  levelOf,
  projectedTier,
  queueCommand,
  queueOf,
  RESEARCH_QUEUE,
  step,
  tierOf,
  tierUpgrade,
  upgradesAt,
  type Building,
  type World,
} from "../src/sim";
import { placeBuilding } from "../src/sim/entities";
import { content, OPENING, SETUP } from "./fixtures";

const TIER = tierUpgrade(content)!;
const world = (): World => {
  const w = createWorld(content, { seed: 1234, races: ["open-source", "botnet"], startWithCore: true });
  w.waves.nextWaveTick = 1e9;
  return w;
};
const team = (w: World) => w.teams[0]!;
const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i += 1) step(w, content);
};
/** Queue the next level the way a player does, and return the rejection (if any). */
const queue = (w: World, upgrade: string): string | null => {
  queueCommand(w, { type: "research", tick: w.tick, team: 0, upgrade });
  step(w, content);
  return w.events.flatMap((e) => (e.type === "rejected" ? [e.reason] : []))[0] ?? null;
};
const cancel = (w: World, slot: "research" | "labResearch", index: number): string | null => {
  queueCommand(w, { type: "cancelResearch", tick: w.tick, team: 0, slot, index });
  step(w, content);
  return w.events.flatMap((e) => (e.type === "rejected" ? [e.reason] : []))[0] ?? null;
};
const center = (w: World) => {
  const core = w.entities.find((e): e is Building => e.kind === "building" && e.id === team(w).coreId)!;
  return placeBuilding(w, content, 0, content.races["open-source"]!.center!, core.col + 4, core.row, true) as Building;
};

describe("research queue", () => {
  it("queues behind a running research and pays the moment it's queued", () => {
    const w = world();
    team(w).money = 10_000;
    expect(queue(w, "building-armor")).toBeNull();
    expect(team(w).money).toBe(10_000 - content.upgrades["building-armor"]!.cost);
    expect(team(w).research).toMatchObject({ upgrade: "building-armor", remaining: content.upgrades["building-armor"]!.researchTicks - 1 });
    expect(queue(w, "building-hp")).toBeNull();
    expect(team(w).money).toBe(10_000 - content.upgrades["building-armor"]!.cost - content.upgrades["building-hp"]!.cost);
    expect(team(w).researchQueue).toEqual([{ upgrade: "building-hp", ticks: content.upgrades["building-hp"]!.researchTicks, paid: content.upgrades["building-hp"]!.cost }]);
    // You can't queue what you can't afford.
    team(w).money = 0;
    expect(queue(w, "tower-damage")).toBe("not enough $");
  });

  it("an upgrade is queued once: its next level waits until it's done (WC3)", () => {
    const w = world();
    team(w).money = 100_000;
    team(w).upgrades[TIER] = 2;
    const def = content.upgrades["building-armor"]!;
    expect(queue(w, "building-hp")).toBeNull();
    expect(queue(w, "building-armor")).toBeNull();
    // Waiting or running, a second level of it is refused.
    expect(queue(w, "building-armor")).toBe("already queued");
    expect(canResearch(content, team(w), "building-armor", w)).toBe("already queued");
    // A different upgrade still queues.
    expect(queue(w, "tower-damage")).toBeNull();
    while (levelOf(team(w), "building-armor") < 1) step(w, content);
    // Done: now level 2 can be queued, at level 2's price.
    const money = team(w).money;
    expect(queue(w, "building-armor")).toBeNull();
    expect(money - team(w).money).toBe(def.cost * 2);
  });

  it("checks tier requirements against everything queued, at either building", () => {
    const w = world();
    team(w).money = 100_000;
    center(w);
    team(w).upgrades["exploit-kits"] = 1;
    // Level 2 needs a Data Center and there's none queued yet.
    expect(canResearch(content, team(w), "exploit-kits", w)).toBe(`needs ${content.economy.tiers[1]!.name}`);
    expect(queue(w, "exploit-kits")).toBe(`needs ${content.economy.tiers[1]!.name}`);
    // Queue the tier first: the projected tier reaches 1, so the upgrade may follow it.
    expect(queue(w, TIER)).toBeNull();
    expect(projectedTier(content, team(w))).toBe(1);
    expect(canResearch(content, team(w), "exploit-kits", w)).toBeNull();
    expect(queue(w, "exploit-kits")).toBeNull();
    expect(team(w).labResearch?.upgrade).toBe("exploit-kits");
    expect(team(w).research?.upgrade).toBe(TIER);
  });

  it("an entry waits at the head, not counting down, until its tier is actually there", () => {
    const w = world();
    team(w).money = 100_000;
    center(w);
    team(w).upgrades["exploit-kits"] = 1;
    expect(queue(w, TIER)).toBeNull();
    expect(queue(w, "exploit-kits")).toBeNull();
    step(w, content);
    const gated = team(w).labResearch!;
    // Gated at the head: not a single tick counted.
    expect(gated.remaining).toBe(content.upgrades["exploit-kits"]!.researchTicks * 2);
    // While the core tier runs, the lab's head doesn't move.
    run(w, 500);
    expect(tierOf(content, team(w))).toBe(0);
    expect(team(w).labResearch!.remaining).toBe(gated.remaining);
    // Tier done: the head starts counting down and finishes at its level.
    while (tierOf(content, team(w)) < 1) step(w, content);
    run(w, gated.remaining + 1);
    expect(levelOf(team(w), "exploit-kits")).toBe(2);
  });

  it("cancelling refunds the entry, and later entries that lose their requirement fall with it", () => {
    const w = world();
    team(w).money = 100_000;
    center(w);
    team(w).upgrades["exploit-kits"] = 1;
    expect(queue(w, TIER)).toBeNull();
    expect(queue(w, "exploit-kits")).toBeNull();
    queue(w, "building-hp");
    const money = team(w).money;
    // The tier (head of the core's queue): refunded in full.
    expect(cancel(w, "research", 0)).toBeNull();
    // Without it the lab's gated head loses its tier, and falls with a refund.
    // The building-hp entry (no tier needed) takes over the core's slot.
    expect(team(w).money).toBe(money + content.upgrades[TIER]!.cost + content.upgrades["exploit-kits"]!.cost * 2);
    expect(team(w).research).toMatchObject({ upgrade: "building-hp" });
    expect(team(w).researchQueue).toEqual([]);
    expect(team(w).labResearch).toBeNull();
    // Cancelling a waiting entry refunds what it paid (queued then removed: net zero).
    queue(w, "building-armor");
    expect(team(w).researchQueue).toHaveLength(1);
    expect(cancel(w, "research", 1)).toBeNull();
    expect(team(w).money).toBe(money + content.upgrades[TIER]!.cost + content.upgrades["exploit-kits"]!.cost * 2);
    expect(queueOf(team(w), "research").map((e) => e.upgrade)).toEqual(["building-hp"]);
    expect(cancel(w, "research", 1)).toBe("nothing to cancel");
  });

  it("a destroyed building refunds its whole queue", () => {
    const w = world();
    team(w).money = 100_000;
    const lab = center(w);
    expect(queue(w, "building-armor")).toBeNull();
    expect(queue(w, "building-hp")).toBeNull();
    expect(queue(w, "exploit-kits")).toBeNull();
    const money = team(w).money;
    // The center falls: the lab's queue (head included) is refunded.
    lab.hp = 0;
    run(w, 3);
    expect(team(w).money).toBe(money + content.upgrades["exploit-kits"]!.cost);
    expect(team(w).labResearch).toBeNull();
    expect(team(w).labResearchQueue).toEqual([]);
    expect(team(w).research).not.toBeNull();
    // The core falls: the core's queue is refunded the same way.
    w.entities.find((e) => e.id === team(w).coreId)!.hp = 0;
    run(w, 3);
    expect(team(w).money).toBe(money + content.upgrades["exploit-kits"]!.cost + content.upgrades["building-armor"]!.cost + content.upgrades["building-hp"]!.cost);
    expect(team(w).research).toBeNull();
    expect(team(w).researchQueue).toEqual([]);
  });

  it("holds five entries a building, and the two queues don't share the count", () => {
    const w = world();
    team(w).money = 100_000;
    center(w);
    const coreUpgrades = upgradesAt(content, team(w), "core");
    for (const upgrade of coreUpgrades.slice(0, RESEARCH_QUEUE)) expect(queue(w, upgrade)).toBeNull();
    expect(queueOf(team(w), "research")).toHaveLength(RESEARCH_QUEUE);
    expect(queue(w, coreUpgrades[RESEARCH_QUEUE]!)).toBe("queue full");
    // The center's queue is its own.
    expect(queue(w, "exploit-kits")).toBeNull();
    expect(queueOf(team(w), "labResearch")).toHaveLength(1);
    expect(canResearch(content, team(w), "unit-armor", w)).toBeNull();
  });

  it("a plain single research behaves exactly as before, and its match still replays", () => {
    const w = world();
    team(w).money = 1000;
    const def = content.upgrades["tower-damage"]!;
    expect(queue(w, "tower-damage")).toBeNull();
    expect(team(w).research).toEqual({ upgrade: "tower-damage", remaining: def.researchTicks - 1 });
    expect(team(w).money).toBe(1000 - def.cost);
    run(w, def.researchTicks + 1);
    expect(team(w).upgrades["tower-damage"]).toBe(1);
    expect(team(w).research).toBeNull();
    expect(team(w).researchQueue).toEqual([]);

    // Seed + setup + the log, research included, reproduces the match.
    const played = createWorld(content, SETUP);
    for (const command of OPENING) queueCommand(played, command);
    played.teams[0]!.money += 2000;
    queueCommand(played, { type: "research", tick: 5, team: 0, upgrade: "anycast" });
    while (played.tick < 2000) step(played, content);
    const replay = createWorld(content, SETUP);
    replay.teams[0]!.money += 2000;
    for (const command of played.log) queueCommand(replay, command);
    while (replay.tick < played.tick) step(replay, content);
    expect(hashWorld(replay)).toBe(hashWorld(played));
  });

  it("queueing is deterministic", () => {
    const go = () => {
      const w = world();
      team(w).money = 100_000;
      center(w);
      for (const upgrade of ["building-armor", "building-hp", "tower-damage"]) queue(w, upgrade);
      queue(w, TIER);
      queue(w, "exploit-kits");
      cancel(w, "research", 1);
      run(w, 1200);
      return hashWorld(w);
    };
    expect(go()).toBe(go());
  });
});
