import { bodyFits } from "../src/sim/nav";
import { describe, expect, it } from "vitest";
import { createWorld, isWalkableTile, queueCommand, step, TILE, type Building, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { placeBuilding, spawnUnit } from "../src/sim/entities";
import { terrainFor } from "../src/sim/walls";
import { loseUsers } from "../src/sim/economy";
import { content, planBuildOrder } from "./fixtures";

const setup = (race = "walled-garden") => ({ seed: 1234, races: [race, "botnet"], startWithCore: true });

function walled(spots = 1): { world: World; walls: Building[] } {
  const s = setup();
  const world = createWorld(content, s);
  world.waves.nextWaveTick = 1e9;
  world.teams[0]!.money = 10000;
  for (const c of planBuildOrder(content, s, Array.from({ length: spots }, () => [0, "wall"] as [number, string]))) queueCommand(world, c);
  step(world, content);
  const walls = world.entities.filter((e): e is Building => e.kind === "building" && e.defId === "wall");
  while (walls.some((w) => w.buildRemaining > 0)) step(world, content);
  return { world, walls };
}

describe("walls", () => {
  it.each(["open-source", "hyperscaler", "serverless", "walled-garden"])("%s can build shared walls and gates", (race) => {
    expect(content.races[race]!.buildings).toEqual(expect.arrayContaining(["wall", "gate"]));
    if (race !== "walled-garden") {
      expect(content.races[race]!.tierPerks?.some((perk) => perk?.mechanics?.thorns)).toBe(false);
    }
  });
  it("a wall blocks its tile the tick it goes down, and frees it when it falls", () => {
    const { world, walls } = walled();
    const wall = walls[0]!;
    expect(isWalkableTile(world.terrain, wall.col, wall.row)).toBe(false);
    wall.hp = 0;
    step(world, content);
    expect(isWalkableTile(world.terrain, wall.col, wall.row)).toBe(true);
  });

  it("can't go down on top of a unit", () => {
    const s = setup();
    const world = createWorld(content, s);
    world.teams[0]!.money = 10000;
    const [spot] = planBuildOrder(content, s, [[0, "wall"]]);
    spawnUnit(makeContext(world, content), 0, "moderator", { x: 0, y: 0 }, (spot!.col + 0.5) * TILE, (spot!.row + 0.5) * TILE, "guard");
    queueCommand(world, { ...spot!, tick: world.tick });
    step(world, content);
    expect(world.events.some((e) => e.type === "rejected" && e.reason === "a unit is in the way")).toBe(true);
  });

  it("units route around a wall and are never inside one", () => {
    const { world, walls } = walled(6);
    world.waves.nextWaveTick = world.tick;
    for (let i = 0; i < 4000; i++) {
      step(world, content);
      for (const u of world.entities) {
        if (u.kind !== "unit") continue;
        for (const w of walls) {
          if (w.hp <= 0) continue;
          const inside = u.x > w.col * TILE && u.x < (w.col + 1) * TILE && u.y > w.row * TILE && u.y < (w.row + 1) * TILE;
          expect(inside, `unit ${u.defId} inside wall at tick ${world.tick}`).toBe(false);
        }
      }
    }
  });

  it("a creep that runs into a wall tears into it", () => {
    const { world, walls } = walled();
    const wall = walls[0]!;
    world.waves.nextWaveTick = world.tick;
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 1 && e.mode === "roam")) step(world, content);
    const creep = world.entities.find((e) => e.kind === "unit" && e.team === 1 && e.mode === "roam")!;
    // Start it two or three tiles from the wall on open ground at the wall's
    // height, where the wall is the nearest building.
    const others = world.entities.filter((e) => e.kind === "building" && e.team === 0 && e.id !== wall.id);
    let spot: { x: number; y: number } | null = null;
    for (let r = 2; r <= 4 && !spot; r += 1) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) {
        const x = (wall.col + dc + 0.5) * TILE;
        const y = (wall.row + dr + 0.5) * TILE;
        const i = (wall.row + dr) * world.terrain.cols + wall.col + dc;
        if (!bodyFits(world.terrain, x, y, creep.radius) || world.terrain.heights[i] !== world.terrain.heights[wall.row * world.terrain.cols + wall.col]) continue;
        // Nearest by edge, the way creeps measure it, with room to spare.
        const toWall = Math.hypot(x - wall.x, y - wall.y) - wall.radius;
        if (others.some((o) => Math.hypot(x - o.x, y - o.y) - o.radius <= toWall + TILE)) continue;
        spot = { x, y };
        break;
      }
    }
    expect(spot).not.toBeNull();
    creep.x = spot!.x;
    creep.y = spot!.y;
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    // Keep the hero and any guards out of it: creeps go for a defender in their face first.
    for (const u of world.entities) {
      if (u.kind === "unit" && u.team === 0) {
        u.x = u.homeX = core.x - 2000;
        u.y = u.homeY = core.y;
      }
    }
    const before = wall.hp;
    for (let i = 0; i < 200; i++) step(world, content);
    expect(wall.hp).toBeLessThan(before);
  });
});

describe("Walled Garden loyalty", () => {
  it("users leave at the loyalty share of the usual rate", () => {
    const churn = (race: string) => {
      const world = createWorld(content, setup(race));
      const team = world.teams[0]!;
      team.users = 500;
      loseUsers(makeContext(world, content), team, 1200, "web-app");
      return 500 - team.users;
    };
    const share = content.races["walled-garden"]!.mechanics!.loyalty!.churnPermille / 1000;
    expect(churn("walled-garden")).toBe(Math.floor(churn("open-source") * share));
  });
});

describe("gates", () => {
  const gated = (races: string[], mode?: "ffa") => {
    const s = { seed: 1234, races, startWithCore: true, ...(mode ? { mode } : {}) };
    const world = createWorld(content, s);
    world.waves.nextWaveTick = 1e9;
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId) as Building;
    // An open tile two right of the core's footprint with open ground either side, east-west.
    let at: { col: number; row: number } | null = null;
    for (let dc = 3; dc < 8 && !at; dc += 1) {
      const col = core.col + dc;
      const row = core.row;
      if ([-1, 0, 1].every((o) => isWalkableTile(world.terrain, col + o, row))) at = { col, row };
    }
    const gate = placeBuilding(world, content, 0, "gate", at!.col, at!.row, true);
    step(world, content);
    return { world, gate };
  };
  const open = (world: World, team: number, gate: Building) => isWalkableTile(terrainFor(world, team).terrain, gate.col, gate.row);

  it("a non-WG gate blocks enemies but opens for its owner", () => {
    const { world, gate } = gated(["open-source", "botnet"]);
    expect(isWalkableTile(world.terrain, gate.col, gate.row)).toBe(false);
    expect(open(world, 1, gate)).toBe(false);
    expect(open(world, 0, gate)).toBe(true);
  });

  it("opens for co-op allies, not for free-for-all enemies", () => {
    const coop = gated(["walled-garden", "open-source", "botnet"]);
    expect(open(coop.world, 1, coop.gate)).toBe(true);
    const ffa = gated(["walled-garden", "open-source"], "ffa");
    expect(open(ffa.world, 1, ffa.gate)).toBe(false);
  });

  it("a non-WG race's units walk straight through its gate", () => {
    const { world, gate } = gated(["open-source", "botnet"]);
    const ctx = makeContext(world, content);
    const unit = spawnUnit(ctx, 0, "process", gate, (gate.col - 1 + 0.5) * TILE, (gate.row + 0.5) * TILE, "guard");
    unit.homeX = (gate.col + 1 + 0.5) * TILE;
    unit.homeY = (gate.row + 0.5) * TILE;
    unit.order = "move";
    // It goes *through* the gate tile, not round it.
    let crossed = false;
    for (let i = 0; i < 80; i += 1) {
      step(world, content);
      if (Math.floor(unit.x / TILE) === gate.col && Math.floor(unit.y / TILE) === gate.row) crossed = true;
    }
    expect(crossed).toBe(true);
    expect(unit.x).toBeGreaterThan((gate.col + 1) * TILE);
  });

  it("when it falls, the views go with it", () => {
    const { world, gate } = gated(["walled-garden", "botnet"]);
    gate.hp = 0;
    step(world, content);
    expect(world.nav.views).toBeUndefined();
    expect(isWalkableTile(world.terrain, gate.col, gate.row)).toBe(true);
  });
});
