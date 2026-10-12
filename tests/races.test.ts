import { describe, expect, it } from "vitest";
import {
  RACE_LOOKS,
  createWorld,
  queueCommand,
  step,
} from "../src/sim";
import { content, SETUP, planBuildOrder } from "./fixtures";

describe("races", () => {
  const HYPER = { ...SETUP, races: ["hyperscaler", "botnet"] as [string, string] };

  it("every playable race has a builder, a core, and its own roster", () => {
    const playable = Object.entries(content.races).filter(([, r]) => r.controller === "human");
    expect(playable.length).toBeGreaterThanOrEqual(2);
    const rosters = playable.map(([, r]) => r.buildings.join(","));
    expect(new Set(rosters).size).toBe(rosters.length);
    for (const [, race] of playable) expect(race.builder).toBeDefined();
  });

  it("the Hyperscaler starts richer and fields tougher units", () => {
    const os = createWorld(content, SETUP);
    const hyper = createWorld(content, HYPER);
    expect(hyper.teams[0]!.money - os.teams[0]!.money).toBe(content.races.hyperscaler!.modifiers.startingMoneyBonus);

    const rack = planBuildOrder(content, HYPER, [[0, "hyperscale-rack"]])[0]!;
    queueCommand(hyper, rack);
    while (!hyper.entities.some((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard")) step(hyper, content);
    const unit = hyper.entities.find((e) => e.kind === "unit" && e.team === 0 && e.mode === "guard")!;
    expect(unit.maxHp).toBe(Math.round(content.units["load-balancer"]!.hp * content.races.hyperscaler!.modifiers.unitHpMultiplier));
  });

  it("each race can only build its own roster", () => {
    const world = createWorld(content, HYPER);
    const spot = planBuildOrder(content, HYPER, [[0, "hyperscale-rack"]])[0]!;
    queueCommand(world, { ...spot, building: "server-rack" });
    step(world, content);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "rejected", reason: "not in this race's roster" }));
  });
});

describe("race looks", () => {
  it("every playable race has a look, and no two races share one", () => {
    const looks = Object.values(content.races)
      .filter((race) => race.controller === "human")
      .map((race) => race.look);
    for (const look of looks) expect(RACE_LOOKS).toContain(look);
    expect(new Set(looks).size).toBe(looks.length);
  });
});
