import { describe, expect, it } from "vitest";
import { createWorld, farmSpots, farmsDown, generateTerrain, planWave, step, type Building, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { dealDamage } from "../src/sim/combat";
import { spawnUnit } from "../src/sim/entities";
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
