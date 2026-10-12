import { describe, expect, it } from "vitest";
import {
  TILE_OPEN,
  canPlace,
  createWorld,
  fortify,
  generateTerrain,
  hashWorld,
  hubBuilding,
  queueCommand,
  step,
  userCapacity,
  type World,
} from "../src/sim";
import { dealDamage } from "../src/sim/combat";
import { makeContext } from "../src/sim/context";
import { placeBuilding, spawnUnit } from "../src/sim/entities";
import { bfs } from "../src/sim/terrain/grid";
import { content, SETUP } from "./fixtures";

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 1);

/** Knock down the botnet's squatters on hub `i`. */
function clear(world: World, i: number) {
  const hub = world.terrain.hubs[i]!;
  const center = { x: (hub.col + 1) * 48, y: (hub.row + 1) * 48 };
  const r = content.economy.hubs.contestRadius;
  for (const e of world.entities) {
    if (e.kind === "building" && e.defId === "c2-server" && Math.hypot(e.x - center.x, e.y - center.y) <= r) e.hp = 0;
  }
}

/** Clear hub `i` and put a finished Mesh Node of `team` right beside it, so its network reaches it. */
function reach(world: World, i: number, team = 0) {
  clear(world, i);
  const hub = world.terrain.hubs[i]!;
  const { cols, tiles } = world.terrain;
  for (const [dc, dr] of [[-2, 0], [3, 0], [0, -2], [0, 3], [-2, -2], [3, 3], [-2, 3], [3, -2]] as const) {
    const col = hub.col + dc;
    const row = hub.row + dr;
    if (tiles[row * cols + col] !== TILE_OPEN) continue;
    if (world.entities.some((e) => e.kind === "building" && e.col === col && e.row === row)) continue;
    return placeBuilding(world, content, team, "mesh-node", col, row, true);
  }
  throw new Error(`no room beside hub ${i}`);
}
const second = (world: World, seconds = 1) => {
  for (let i = 0; i < 20 * seconds; i++) step(world, content);
};

describe("user hubs", () => {
  it("every map has a campus near every start and some metros, on open, flat, reachable ground", () => {
    for (const seed of SEEDS) {
      const terrain = generateTerrain(seed);
      const { cols, rows } = terrain;
      const campuses = terrain.hubs.filter((h) => h.size === "campus");
      expect(campuses.length, `seed ${seed}`).toBe(terrain.starts.length);
      expect(terrain.hubs.filter((h) => h.size === "metro").length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      const dist = bfs(terrain.tiles, cols, rows, terrain.starts[0]!);
      for (const hub of terrain.hubs) {
        const level = terrain.heights[hub.row * cols + hub.col];
        for (let r = hub.row; r < hub.row + 2; r++) {
          for (let c = hub.col; c < hub.col + 2; c++) {
            expect(terrain.tiles[r * cols + c], `seed ${seed} hub ${hub.col},${hub.row}`).toBe(TILE_OPEN);
            expect(terrain.heights[r * cols + c]).toBe(level);
            expect(dist[r * cols + c]).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it("nobody holds a hub at the start, and nothing can be built on one", () => {
    const world = createWorld(content, SETUP);
    expect(world.hubs.every((h) => h.owner === -1)).toBe(true);
    const hub = world.terrain.hubs[0]!;
    world.teams[0]!.money = 10_000;
    reach(world, 0);
    queueCommand(world, { type: "build", tick: world.tick, team: 0, building: "server-rack", col: hub.col, row: hub.row });
    step(world, content);
    expect(world.events.some((e) => e.type === "rejected" && e.reason === "users live there")).toBe(true);
  });

  it("bring your network within reach and it connects: more user room", () => {
    const world = createWorld(content, SETUP);
    const before = userCapacity(world, content, world.teams[0]!);
    reach(world, 0);
    second(world);
    expect(world.hubs[0]!.owner).toBe(0);
    const spot = world.terrain.hubs[0]!;
    expect(hubBuilding(world, spot)?.team).toBe(0);
    expect(userCapacity(world, content, world.teams[0]!)).toBe(before + content.buildings[spot.size]!.userCapacity!);
  });

  it("cut it off from your network and it's gone, but free to reconnect", () => {
    const world = createWorld(content, SETUP);
    const node = reach(world, 0);
    second(world);
    node.hp = 0;
    second(world, 2);
    expect(world.hubs[0]!.owner).toBe(-1);
    expect(hubBuilding(world, world.terrain.hubs[0]!)).toBeUndefined();
    reach(world, 0);
    second(world);
    expect(world.hubs[0]!.owner).toBe(0);
  });

  it("knocked offline, nobody can reconnect it for a while", () => {
    const world = createWorld(content, SETUP);
    reach(world, 0);
    second(world);
    hubBuilding(world, world.terrain.hubs[0]!)!.hp = 0;
    second(world, 2);
    expect(world.hubs[0]!.owner).toBe(-1);
    const wait = content.economy.hubs.reconnectTicks / 20;
    second(world, wait - 3);
    expect(world.hubs[0]!.owner).toBe(-1);
    second(world, 4);
    expect(world.hubs[0]!.owner).toBe(0);
  });

  it("hitting a hub drives users away, like any building that serves them", () => {
    const frozen = structuredClone(content);
    frozen.economy = { ...content.economy, growthPerSecond: 0, minArrivalsPerSecond: 0 };
    const world = createWorld(frozen, SETUP);
    reach(world, 0);
    for (let i = 0; i < 20; i++) step(world, frozen);
    world.teams[0]!.users = 40;
    const hub = hubBuilding(world, world.terrain.hubs[0]!)!;
    const creep = { ...hub, id: -9, team: 1 } as typeof hub;
    dealDamage(makeContext(world, frozen), creep, hub, 240);
    expect(world.teams[0]!.users).toBeLessThan(40);
  });

  it("is deterministic", () => {
    const run = () => {
      const world = createWorld(content, SETUP);
      reach(world, 0);
      for (let i = 0; i < 3000; i++) step(world, content);
      return hashWorld(world);
    };
    expect(run()).toBe(run());
  });
});

describe("user hubs in co-op", () => {
  const COOP = { seed: SETUP.seed, races: ["open-source", "open-source", "botnet"], startWithCore: true };
  const FFA = { ...COOP, races: ["open-source", "open-source"], mode: "ffa" as const };
  const base = (world: World, team: number) => {
    const t = world.teams[team]!;
    const room = userCapacity(world, content, t);
    return room;
  };

  it("a hub's room is split between online allies, and adds up to the whole hub", () => {
    const world = createWorld(content, COOP);
    const before = [base(world, 0), base(world, 1)];
    reach(world, 0, 0);
    second(world);
    expect(world.hubs[0]!.owner).toBe(0);
    const total = content.buildings[world.terrain.hubs[0]!.size]!.userCapacity!;
    const gained = [base(world, 0) - before[0]!, base(world, 1) - before[1]!];
    expect(gained[0]! + gained[1]!).toBe(total);
    expect(Math.abs(gained[0]! - gained[1]!)).toBeLessThanOrEqual(1);
  });

  it("an ally who goes down stops sharing; the rest get the whole hub", () => {
    const world = createWorld(content, COOP);
    const before = base(world, 0);
    reach(world, 0, 0);
    second(world);
    world.entities.find((e) => e.id === world.teams[1]!.coreId)!.hp = 0;
    second(world);
    const total = content.buildings[world.terrain.hubs[0]!.size]!.userCapacity!;
    expect(base(world, 0) - before).toBe(total);
  });

  it("cut off from its holder, it passes to an ally who still reaches it", () => {
    const world = createWorld(content, COOP);
    const mine = reach(world, 0, 0);
    second(world);
    const hub = hubBuilding(world, world.terrain.hubs[0]!)!;
    reach(world, 0, 1);
    mine.hp = 0;
    second(world);
    expect(world.hubs[0]!.owner).toBe(1);
    expect(hubBuilding(world, world.terrain.hubs[0]!)?.id).toBe(hub.id);
    expect(world.events.some((e) => e.type === "hub" && e.state === "cut-off")).toBe(false);
  });

  it("in free-for-all the holder keeps all of it", () => {
    const world = createWorld(content, FFA);
    const before = [base(world, 0), base(world, 1)];
    reach(world, 0, 0);
    second(world);
    const total = content.buildings[world.terrain.hubs[0]!.size]!.userCapacity!;
    expect(base(world, 0) - before[0]!).toBe(total);
    expect(base(world, 1)).toBe(before[1]);
  });
});

describe("hubs are worth fighting for", () => {
  const squatters = (world: World, i: number) => {
    const hub = world.terrain.hubs[i]!;
    const center = { x: (hub.col + 1) * 48, y: (hub.row + 1) * 48 };
    return world.entities.filter(
      (e) => e.kind === "building" && e.defId === "c2-server" && e.hp > 0 && Math.hypot(e.x - center.x, e.y - center.y) <= content.economy.hubs.contestRadius,
    );
  };

  it("on every map the botnet squats on every hub: one C2 Server on a Campus, three on a Metro", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const world = createWorld(content, { ...SETUP, seed });
      world.terrain.hubs.forEach((hub, i) => {
        expect(squatters(world, i).length, `seed ${seed} ${hub.size}`).toBe(content.economy.hubs.guards[hub.size]);
      });
    }
  });

  it("free-for-all without the horde: no squatters", () => {
    const world = createWorld(content, { seed: SETUP.seed, races: ["open-source", "hyperscaler"], startWithCore: true, mode: "ffa" });
    world.terrain.hubs.forEach((_, i) => expect(squatters(world, i)).toEqual([]));
  });

  it("a squatted hub won't connect, even in reach; clear the squatters and it does", () => {
    const world = createWorld(content, SETUP);
    const hub = world.terrain.hubs[0]!;
    const { cols, tiles } = world.terrain;
    // Reach it without clearing.
    for (const [dc, dr] of [[-2, 0], [3, 0], [0, -2], [0, 3]] as const) {
      const col = hub.col + dc;
      const row = hub.row + dr;
      if (tiles[row * cols + col] !== TILE_OPEN || world.entities.some((e) => e.kind === "building" && e.col === col && e.row === row)) continue;
      placeBuilding(world, content, 0, "mesh-node", col, row, true);
      break;
    }
    second(world, 2);
    expect(world.hubs[0]!.owner).toBe(-1);
    for (const s of squatters(world, 0)) s.hp = 0;
    second(world, 2);
    expect(world.hubs[0]!.owner).toBe(0);
  });

  it("enemies outnumbering you on a held hub cut its users off until you push them out", () => {
    const world = createWorld(content, SETUP);
    const room = () => userCapacity(world, content, world.teams[0]!);
    const before = room();
    reach(world, 0);
    second(world);
    const total = content.buildings[world.terrain.hubs[0]!.size]!.userCapacity!;
    expect(room() - before).toBe(total);

    const hub = world.terrain.hubs[0]!;
    const ctx = makeContext(world, content);
    const at = { x: (hub.col + 1) * 48, y: (hub.row + 1) * 48 + 96 };
    const raiders = [0, 1, 2].map(() => spawnUnit(ctx, 1, "bot", at, at.x, at.y, "guard"));
    for (const r of raiders) r.attackCooldown = 1e6;
    second(world);
    expect(world.hubs[0]!.contested).toBe(true);
    expect(room()).toBe(before);

    const defenders = [0, 1, 2].map(() => spawnUnit(ctx, 0, "process", at, at.x, at.y, "guard"));
    for (const d of defenders) d.attackCooldown = 1e6;
    second(world);
    expect(world.hubs[0]!.contested).toBe(false);
    expect(room() - before).toBe(total);
  });

  it("the botnet re-squats a hub nobody holds when it rebuilds its fortress, but not one you hold", () => {
    const world = createWorld(content, SETUP);
    reach(world, 0);
    second(world);
    expect(world.hubs[0]!.owner).toBe(0);
    for (let i = 1; i < world.terrain.hubs.length; i += 1) for (const s of squatters(world, i)) s.hp = 0;
    second(world);
    fortify(world, content, 1, 4);
    expect(squatters(world, 0)).toEqual([]);
    for (let i = 1; i < world.terrain.hubs.length; i += 1) expect(squatters(world, i).length).toBe(content.economy.hubs.guards[world.terrain.hubs[i]!.size]);
  });

  it("a player can only have two Web Apps", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.money = 100_000;
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)! as { col: number; row: number };
    const placed: string[] = [];
    for (let r = core.row - 4; r <= core.row + 5 && placed.length < 3; r += 2) {
      for (let c = core.col - 4; c <= core.col + 5 && placed.length < 3; c += 2) {
        const reason = canPlace(world, content, 0, "web-app", c, r);
        if (reason === null) {
          placeBuilding(world, content, 0, "web-app", c, r, false);
          placed.push("ok");
        } else if (reason.startsWith("only")) placed.push(reason);
      }
    }
    expect(placed).toEqual(["ok", "ok", "only 2 per player"]);
  });
});
