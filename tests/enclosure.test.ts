import { describe, expect, it } from "vitest";
import { createWorld } from "../src/sim";
import { placeBuilding } from "../src/sim/entities";
import { enclosureRevenueFactor, enclosureBonus, enclosureGround } from "../src/sim/enclosure";
import { dealDamage } from "../src/sim/combat";
import { makeContext } from "../src/sim/context";
import { incomeRate } from "../src/sim/economy";
import { content } from "./fixtures";

function garden(race = "walled-garden", gate = false) {
  const world = createWorld(content, { seed: 1234, races: [race, "botnet"], startWithCore: true });
  world.entities = [];
  world.terrain.tiles.fill(0);
  const app = placeBuilding(world, content, 0, "web-app", 12, 12, true);
  const ring = [];
  for (let r = 10; r <= 16; r += 1) for (let c = 10; c <= 16; c += 1) {
    if (r !== 10 && r !== 16 && c !== 10 && c !== 16) continue;
    ring.push(placeBuilding(world, content, 0, gate && r === 10 && c === 13 ? "gate" : "wall", c, r, true));
  }
  return { world, app, ring };
}

describe("Walled Garden enclosure", () => {
  it("a closed ring grants armor and Web App revenue; an open ring gives nothing", () => {
    const { world, app, ring } = garden();
    expect(enclosureBonus(world, content, app)?.armor).toBe(3);
    expect(enclosureRevenueFactor(world, content, 0)).toBe(1.25);
    ring[3]!.hp = 0;
    expect(enclosureBonus(world, content, app)).toBeUndefined();
    expect(enclosureRevenueFactor(world, content, 0)).toBe(1);
  });
  it("applies armor in combat and the premium to displayed user income", () => {
    const { world, app, ring } = garden();
    world.terrain.heights.fill(0);
    const attacker = placeBuilding(world, content, 1, "wall", 30, 30, true);
    const before = app.hp;
    dealDamage(makeContext(world, content), attacker, app, 20, true);
    const protectedDamage = before - app.hp;
    const team = world.teams[0]!;
    team.users = 20;
    const protectedIncome = incomeRate(world, content, team).users;
    ring[3]!.hp = 0;
    const breachedHp = app.hp;
    dealDamage(makeContext(world, content), attacker, app, 20, true);
    expect(breachedHp - app.hp).toBe(protectedDamage + 3);
    team.users = 20;
    expect(protectedIncome).toBeCloseTo(incomeRate(world, content, team).users * 1.25);
  });
  it("a friendly gate keeps it closed, until destroyed", () => {
    const { world, app, ring } = garden("walled-garden", true);
    expect(enclosureBonus(world, content, app)?.armor).toBe(3);
    ring.find((e) => e.defId === "gate")!.hp = 0;
    expect(enclosureBonus(world, content, app)).toBeUndefined();
  });
  it("caches by standing buildings, refreshing on death and rebuilding", () => {
    const { world, app, ring } = garden();
    const initial = enclosureGround(world, content, 0);
    world.tick += 100;
    ring[3]!.hp -= 1;
    expect(enclosureGround(world, content, 0)).toBe(initial);
    const wall = ring[3]!;
    wall.hp = 0;
    const breached = enclosureGround(world, content, 0);
    expect(breached).not.toBe(initial);
    placeBuilding(world, content, 0, "wall", wall.col, wall.row, true);
    expect(enclosureGround(world, content, 0)).not.toBe(breached);
    expect(enclosureBonus(world, content, app)?.armor).toBe(3);
  });
  it.each(["open-source", "hyperscaler", "serverless"])("%s gets no bonus", (race) => {
    const { world, app } = garden(race);
    expect(enclosureGround(world, content, 0)).toBeUndefined();
    expect(enclosureBonus(world, content, app)).toBeUndefined();
    expect(enclosureRevenueFactor(world, content, 0)).toBe(1);
  });
  it("requires the entire footprint and excludes hostile starting ground", () => {
    const { world, app } = garden();
    app.col = 9;
    expect(enclosureBonus(world, content, app)).toBeUndefined();
    app.col = 12;
    world.terrain.nest = { col: 13, row: 13 };
    // A fresh world cache is unnecessary in real play (terrain is immutable).
    placeBuilding(world, content, 0, "wall", 30, 30, true);
    expect(enclosureBonus(world, content, app)).toBeUndefined();
  });
});
