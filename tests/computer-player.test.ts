// Computer players (issue #123): a player like any other whose commands come
// from src/sim/ai. Deterministic, never cheats except the open revenue
// handicap, and never logged (a replay decides its commands again).

import { describe, expect, it } from "vitest";
import {
  TICK_RATE,
  createWorld,
  hashWorld,
  incomeRate,
  loadDefaultContent,
  step,
  tierOf,
  type World,
} from "../src/sim";
import { computeBalance, squadReserve } from "../src/sim/economy";
import { skirmishSetup } from "../src/game/skirmish";

const content = loadDefaultContent();
const minutes = (world: World, n: number) => {
  const until = world.tick + n * 60 * TICK_RATE;
  const rejected: string[] = [];
  while (world.tick < until && !world.outcome) {
    step(world, content);
    for (const e of world.events)
      if (e.type === "rejected" && world.teams[e.command.team]!.ai)
        rejected.push(`${e.command.type}: ${e.reason}`);
  }
  return rejected;
};
const buildings = (world: World, team: number) =>
  world.entities.filter(
    (e) => e.kind === "building" && e.team === team && e.hp > 0,
  ).length;

describe("computer players", () => {
  for (const difficulty of Object.keys(content.difficulties)) {
    it(`${difficulty}: builds a base and holds the early game, with only commands a person could give`, () => {
      const world = createWorld(content, {
        seed: 42,
        races: ["open-source", "botnet"],
        startWithCore: true,
        ai: [difficulty],
      });
      const rejected = minutes(world, 8);
      expect(world.outcome).toBeNull();
      expect(buildings(world, 0)).toBeGreaterThan(8);
      expect(rejected).toEqual([]);
    });
  }

  it("starts like a person: deploys its agent and founds its core", () => {
    const world = createWorld(content, {
      seed: 314,
      mode: "ffa",
      races: [
        "walled-garden",
        "serverless",
        "hyperscaler",
        "open-source",
        "botnet",
      ],
      ai: [undefined, "easy", "normal", "hard"],
    });
    expect(
      world.teams.every((t) => t.coreId === -1 || t.controller !== "human"),
    ).toBe(true);
    const rejected = minutes(world, 3);
    expect(rejected).toEqual([]);
    for (const id of [1, 2, 3]) {
      expect(world.teams[id]!.coreId, `computer ${id}`).not.toBe(-1);
      expect(buildings(world, id), `computer ${id}`).toBeGreaterThan(3);
    }
    expect(world.teams[0]!.coreId).toBe(-1);
  });

  it("difficulty sets how far it techs: Easy stops where its data says", () => {
    const tierAt = (difficulty: string) => {
      const world = createWorld(content, {
        seed: 7,
        races: ["serverless", "botnet"],
        startWithCore: true,
        ai: [difficulty],
      });
      minutes(world, 14);
      return tierOf(content, world.teams[0]!);
    };
    expect(tierAt("easy")).toBe(content.difficulties.easy!.maxTier);
    expect(tierAt("hard")).toBeGreaterThan(content.difficulties.easy!.maxTier);
  });

  it("is deterministic, and its commands aren't logged", () => {
    const setup = {
      seed: 99,
      mode: "ffa" as const,
      races: ["hyperscaler", "walled-garden", "serverless", "botnet"],
      startWithCore: true,
      ai: ["hard", "normal", "insane"],
    };
    const a = createWorld(content, setup);
    const b = createWorld(content, setup);
    minutes(a, 4);
    minutes(b, 4);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(buildings(a, 1)).toBeGreaterThan(5);
    expect(a.log).toEqual([]);
  });

  it("a person and a computer make a free-for-all", () => {
    const world = createWorld(content, {
      seed: 1,
      mode: "ffa",
      races: ["open-source", "hyperscaler"],
      startWithCore: true,
      ai: [undefined, "normal"],
    });
    expect(world.teams[0]!.ai).toBeNull();
    expect(world.teams[1]!.ai?.difficulty).toBe("normal");
    minutes(world, 2);
    expect(buildings(world, 1)).toBeGreaterThan(3);
    expect(buildings(world, 0)).toBe(1);
  });

  it("only players can be computers, at a difficulty that exists", () => {
    expect(() =>
      createWorld(content, {
        seed: 1,
        races: ["open-source", "botnet"],
        ai: [undefined, "hard"],
      }),
    ).toThrow(/isn't a player/);
    expect(() =>
      createWorld(content, {
        seed: 1,
        races: ["open-source", "botnet"],
        ai: ["godlike"],
      }),
    ).toThrow(/Unknown difficulty/);
  });

  it("the open handicap: revenue scales by revenuePermille, for computers only", () => {
    const world = createWorld(content, {
      seed: 1,
      mode: "ffa",
      races: ["open-source", "open-source", "open-source"],
      startWithCore: true,
      ai: [undefined, "insane", "normal"],
    });
    for (const team of world.teams) team.users = 100;
    const [person, insane, normal] = world.teams.map(
      (t) => incomeRate(world, content, t).users,
    );
    expect(normal).toBe(person);
    expect(insane).toBeCloseTo(
      (person! * content.difficulties.insane!.revenuePermille) / 1000,
    );
    expect(insane).toBeGreaterThan(person!);
  });
});

describe("computer players grow on their own income", () => {
  // No horde, so no creep bounties to cover its mistakes: it has to save for
  // its core tiers, not sink the money into spawners it can't man or towers,
  // and keep finding room as the base fills. Every race.
  const races = ["open-source", "hyperscaler", "serverless", "walled-garden"];
  const world = createWorld(content, {
    seed: 42,
    mode: "ffa",
    races,
    startWithCore: true,
    ai: ["normal", "normal", "normal", "normal"],
  });
  minutes(world, 6);
  const tiers = world.teams.map((t) => tierOf(content, t));
  minutes(world, 5);
  const defences = (team: number) =>
    world.entities.filter((e) => {
      if (e.kind !== "building" || e.team !== team || e.hp <= 0) return false;
      const def = content.buildings[e.defId]!;
      return (def.attack !== undefined || def.blocks) && !def.spawn && !def.invoke && !def.compute && !def.userCapacity && !def.buildRadius;
    }).length;

  it.each(races.map((race, team) => [race, team] as const))("%s saves up for its top tier in good time", (_race, team) => {
    expect(tiers[team]).toBe(content.difficulties.normal!.maxTier);
  });

  it.each(races.map((race, team) => [race, team] as const))("%s finds room to spend what it earns", (_race, team) => {
    expect(world.teams[team]!.money).toBeLessThan(2000);
    expect(buildings(world, team)).toBeGreaterThan(25);
  });

  it.each(races.map((race, team) => [race, team] as const))("%s keeps its defences to a few per tier", (_race, team) => {
    expect(defences(team)).toBeLessThanOrEqual(4 + 4 * tierOf(content, world.teams[team]!));
  });
});

describe("computer players man what they build", () => {
  // A spawner it has no compute to fill is money sunk into an empty
  // building. Worse, a base of them is a wall of hp no attack gets through,
  // so an FFA against a weak computer turns into a stalemate.
  it("builds no spawner that spare compute can't fill", () => {
    const world = createWorld(content, {
      seed: 1,
      mode: "ffa",
      races: ["serverless", "walled-garden"],
      startWithCore: true,
      ai: ["normal", "easy"],
    });
    minutes(world, 9);
    for (const team of world.teams.slice(0, 2)) {
      const { supply, demand } = computeBalance(world, content, team);
      expect(squadReserve(world, content, team) - (supply - demand)).toBeLessThanOrEqual(0);
    }
  });
});

describe("skirmish setup from the address bar", () => {
  it("no ?ai is you and the horde, as before", () => {
    expect(skirmishSetup(content, "", 5, "serverless", "x")).toEqual({
      seed: 5,
      races: ["serverless", "botnet"],
      heroes: ["x"],
    });
  });
  it("opponents take a difficulty and a race (or the next other race)", () => {
    const setup = skirmishSetup(
      content,
      "?ai=hard,easy:serverless,bogus",
      5,
      "serverless",
      undefined,
    );
    expect(setup.mode).toBe("ffa");
    expect(setup.races).toEqual([
      "serverless",
      "open-source",
      "serverless",
      "walled-garden",
      "botnet",
    ]);
    expect(setup.ai).toEqual([undefined, "hard", "easy", "normal"]);
  });
  it("horde=0 drops the horde; mode=coop puts computers on your side and keeps it", () => {
    expect(
      skirmishSetup(content, "?ai=hard&horde=0", 5, "serverless", undefined)
        .races,
    ).not.toContain("botnet");
    const coop = skirmishSetup(
      content,
      "?ai=hard&mode=coop&horde=0",
      5,
      "serverless",
      undefined,
    );
    expect(coop.mode).toBe("coop");
    expect(coop.races).toContain("botnet");
    const world = createWorld(content, { ...coop, startWithCore: true });
    expect(world.teams[1]!.ai).not.toBeNull();
  });
});
