import { bodyFits } from "../src/sim/nav";
import { describe, expect, it } from "vitest";
import { createWorld, isWalkableTile, queueCommand, step, TILE, type Building, type World } from "../src/sim";
import { makeContext } from "../src/sim/context";
import { spawnUnit } from "../src/sim/entities";
import { loseUsers } from "../src/sim/economy";
import { content, planBuildOrder } from "./fixtures";

const setup = (race = "walled-garden") => ({ seed: 1234, races: [race, "botnet"], startWithCore: true });

function walled(spots = 1): { world: World; walls: Building[] } {
  const s = setup();
  const world = createWorld(content, s);
  world.waves.nextWaveTick = 1e9;
  world.teams[0]!.money = 10000;
  for (const c of planBuildOrder(content, s, Array.from({ length: spots }, () => [0, "garden-wall"] as [number, string]))) queueCommand(world, c);
  step(world, content);
  const walls = world.entities.filter((e): e is Building => e.kind === "building" && e.defId === "garden-wall");
  while (walls.some((w) => w.buildRemaining > 0)) step(world, content);
  return { world, walls };
}

describe("walls", () => {
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
    const [spot] = planBuildOrder(content, s, [[0, "garden-wall"]]);
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
