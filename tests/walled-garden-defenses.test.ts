import { describe, expect, it } from "vitest";
import { createWorld } from "../src/sim";
import { placeBuilding, spawnUnit, buildingMaxHp } from "../src/sim/entities";
import { makeContext } from "../src/sim/context";
import { dealDamage } from "../src/sim/combat";
import { buildingCard, buildingDetail, upgradeCard } from "../src/ui/cards";
import { validateContent } from "../src/sim/content/validate";
import { content } from "./fixtures";

function setup(race = "walled-garden") {
  const world = createWorld(content, { seed: 1234, races: [race, "botnet"], startWithCore: true });
  const wall = placeBuilding(world, content, 0, "wall", 10, 10, true);
  const ctx = makeContext(world, content);
  // Same position means the same terrain height; use a ranged unit to exclude thorns.
  const unit = spawnUnit(ctx, 1, "trojan", wall, wall.x, wall.y, "roam");
  unit.x = wall.x;
  unit.y = wall.y;
  unit.armor = 50; // reflection returns the exact share, not another armor-mitigated hit
  return { world, ctx, wall, unit };
}

describe("Walled Garden defenses (#205)", () => {
  it.each(["walled-garden", "open-source", "hyperscaler", "serverless"])("%s gets only its own attacking-building bonuses", (raceId) => {
    const { world } = setup(raceId);
    const race = content.races[raceId]!;
    for (const id of [race.core, ...race.buildings]) {
      const def = content.buildings[id]!;
      const building = placeBuilding(world, content, 0, id, 12, 12, true);
      const boosted = raceId === "walled-garden" && !!def.attack;
      expect(building.maxHp).toBe(Math.round(def.hp * (boosted ? 1.25 : 1)));
      expect(building.hp).toBe(building.maxHp);
      expect(building.armor).toBe(def.armor + (boosted ? 2 : 0));
      if (def.attack && raceId === "walled-garden") {
        const attacker = placeBuilding(world, content, 1, "core", 12, 12, true);
        dealDamage(makeContext(world, content), attacker, building, 100);
        expect(building.maxHp - building.hp).toBe(100 - building.armor);
      }
    }
  });

  it("preserves the HP bonus when core tier and building HP research change", () => {
    const { world } = setup();
    const team = world.teams[0]!;
    const tier = Object.keys(content.upgrades).find((id) => content.upgrades[id]!.stat === "tier")!;
    const hp = Object.keys(content.upgrades).find((id) => content.upgrades[id]!.stat === "buildingHp")!;
    team.upgrades[tier] = 1;
    team.upgrades[hp] = 1;
    expect(buildingMaxHp(world, content, 0, "core")).toBe(Math.round(content.buildings.core!.hp * 1.25 * content.economy.tiers[1]!.coreHp * (1 + content.upgrades[hp]!.perLevel)));
  });

  it.each(["wall", "gate"])("%s reflects only after research, after armor, with integer rounding", (id) => {
    const { world, ctx, wall, unit } = setup();
    wall.defId = id;
    wall.armor = content.buildings[id]!.armor;
    dealDamage(ctx, unit, wall, 101);
    expect(unit.hp).toBe(unit.maxHp);
    world.teams[0]!.upgrades["terms-of-service"] = 1;
    const before = wall.hp;
    dealDamage(ctx, unit, wall, 101);
    const taken = before - wall.hp;
    expect(taken).toBe(101 - wall.armor);
    expect(unit.maxHp - unit.hp).toBe(Math.floor(taken * 300 / 1000));
  });

  it("never reflects from non-WG walls, even with the upgrade injected", () => {
    const { world, ctx, wall, unit } = setup("open-source");
    world.teams[0]!.upgrades["terms-of-service"] = 1;
    dealDamage(ctx, unit, wall, 100);
    expect(unit.hp).toBe(unit.maxHp);
  });

  it("does not loop when both buildings have reflection", () => {
    const { world, ctx, wall } = setup();
    world.teams[1]!.raceId = "walled-garden";
    world.teams[0]!.upgrades["terms-of-service"] = 1;
    world.teams[1]!.upgrades["terms-of-service"] = 1;
    const other = placeBuilding(world, content, 1, "gate", 10, 10, true);
    const before = wall.hp;
    dealDamage(ctx, other, wall, 100);
    expect(wall.hp).toBe(before - (100 - wall.armor));
    expect(other.maxHp - other.hp).toBe(Math.floor((100 - wall.armor) * 300 / 1000));
    expect(world.events.filter((e) => e.type === "shot")).toHaveLength(2);
  });

  it("does not hit an already dead attacker and can kill a living one", () => {
    const { world, ctx, wall, unit } = setup();
    world.teams[0]!.upgrades["terms-of-service"] = 1;
    unit.hp = 0;
    dealDamage(ctx, unit, wall, 100);
    expect(unit.hp).toBe(0);
    unit.hp = 1;
    dealDamage(ctx, unit, wall, 100);
    expect(unit.hp).toBeLessThanOrEqual(0);
    expect(world.events.some((e) => e.type === "death" && e.id === unit.id)).toBe(true);
  });

  it("shows boosted stats and building research in cards", () => {
    const { world } = setup();
    expect(buildingCard(content, "walled-garden", "app-review").lines.join(" ")).toContain("950 HP · 6 armor");
    expect(buildingDetail(content, "walled-garden", "app-review").stats).toContain("950 HP, 6 armor");
    expect(upgradeCard(content, world.teams[0]!, "terms-of-service").lines.join(" ")).toContain("30%");
  });

  it("validates defense modifiers and building reflection traits", () => {
    const bad = structuredClone(content);
    bad.races["walled-garden"]!.modifiers.towerHpMultiplier = 0;
    bad.races["walled-garden"]!.modifiers.towerArmorBonus = 0.5;
    bad.upgrades["terms-of-service"]!.trait!.reflectPermille = 1001;
    expect(() => validateContent(bad)).toThrow(/towerHpMultiplier/);
    expect(() => validateContent(bad)).toThrow(/towerArmorBonus/);
    expect(() => validateContent(bad)).toThrow(/reflectPermille/);
  });
});
