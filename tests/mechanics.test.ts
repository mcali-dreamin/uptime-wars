import { describe, expect, it } from "vitest";
import { buildCost, createWorld, forkCost, queueCommand, regionShield, step, type Building, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { dealDamage } from "../src/sim/combat";
import { content, planBuildOrder } from "./fixtures";

const setup = (race: string) => ({ seed: 1234, races: [race, "botnet"], startWithCore: true });

/** Build `list` near the core and run until all of it is finished. */
function base(race: string, list: string[]): { world: World; built: Building[] } {
  const s = setup(race);
  const world = createWorld(content, s);
  world.waves.nextWaveTick = 1e9;
  world.teams[0]!.money = 10000;
  for (const c of planBuildOrder(content, s, list.map((b) => [0, b] as [number, string]))) queueCommand(world, c);
  const done = () => world.entities.filter((e): e is Building => e.kind === "building" && e.team === 0 && e.defId !== "core" && e.buildRemaining <= 0);
  while (done().length < list.length) {
    if (world.tick > 3000) throw new Error("base never finished");
    step(world, content);
  }
  return { world, built: done() };
}

describe("Open Source: forks", () => {
  it("copies a finished building for half price, faster than building it", () => {
    const { world, built } = base("open-source", ["server-rack"]);
    const rack = built[0]!;
    const price = forkCost(world, content, 0, rack)!;
    // Half of what the next one would cost (and you already own one).
    expect(price).toBe(Math.floor(buildCost(world, content, 0, "server-rack") / 2));
    const [spot] = planBuildOrder(content, setup("open-source"), [[0, "server-rack"], [0, "server-rack"]]).slice(1);
    const before = world.teams[0]!.money;
    queueCommand(world, { type: "fork", tick: world.tick, team: 0, sourceId: rack.id, col: spot!.col, row: spot!.row });
    step(world, content);
    const copy = world.entities.find((e): e is Building => e.kind === "building" && e.defId === "server-rack" && e.id !== rack.id)!;
    expect(copy).toBeDefined();
    expect(before - world.teams[0]!.money).toBeLessThanOrEqual(price);
    expect(copy.buildRemaining).toBeLessThan(content.buildings["server-rack"]!.buildTicks / 2);
  });

  it("can't fork the core, or as a race without forks", () => {
    const os = base("open-source", ["server-rack"]);
    const core = os.world.entities.find((e) => e.id === os.world.teams[0]!.coreId) as Building;
    expect(forkCost(os.world, content, 0, core)).toBeNull();
    const hs = base("hyperscaler", ["hyperscale-rack"]);
    expect(forkCost(hs.world, content, 0, hs.built[0])).toBeNull();
  });

  it("buildings repair themselves once nothing has hit them for a while, and not while under fire", () => {
    const { world, built } = base("open-source", ["firewall"]);
    const wall = built[0]!;
    const repair = content.races["open-source"]!.mechanics!.repair!;
    wall.hp = wall.maxHp / 2;
    wall.lastHitTick = world.tick;
    for (let i = 0; i < repair.quietTicks - 20; i++) step(world, content);
    expect(wall.hp).toBe(wall.maxHp / 2);
    for (let i = 0; i < 20 * 10; i++) step(world, content);
    expect(wall.hp).toBeGreaterThan(wall.maxHp / 2);
  });
});

describe("Hyperscaler: regions", () => {
  it("a building takes less damage the more of your buildings stand near it, up to a cap", () => {
    const lone = base("hyperscaler", ["cdn-edge"]);
    expect(regionShield(lone.world, content, lone.built[0]!).permille).toBe(0);
    const packed = base("hyperscaler", ["cdn-edge", "hyperscale-rack", "hyperscale-rack", "power-plant", "web-app", "cdn-edge", "web-app"]);
    const region = content.races.hyperscaler!.mechanics!.region!;
    const shields = packed.built.map((b) => regionShield(packed.world, content, b).permille);
    expect(Math.max(...shields)).toBeGreaterThan(0);
    for (const s of shields) expect(s).toBeLessThanOrEqual(region.maxPermille);
  });

  it("the shield cuts the damage that actually lands", () => {
    const packed = base("hyperscaler", ["cdn-edge", "hyperscale-rack", "hyperscale-rack", "power-plant", "web-app"]);
    const target = packed.built.reduce((a, b) => (regionShield(packed.world, content, a).permille >= regionShield(packed.world, content, b).permille ? a : b));
    const shield = regionShield(packed.world, content, target).permille;
    expect(shield).toBeGreaterThan(0);
    const ctx = makeContext(packed.world, content);
    // Hit it from its own core: same height, so no downhill bonus muddies the numbers.
    const core = packed.world.entities.find((e) => e.id === packed.world.teams[0]!.coreId)!;
    const before = target.hp;
    dealDamage(ctx, core, target, 200);
    const unshielded = Math.max(1, 200 - target.armor);
    expect(before - target.hp).toBe(Math.max(1, Math.round((unshielded * (1000 - shield)) / 1000)));
  });
});
