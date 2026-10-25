import { describe, expect, it } from "vitest";
import {
  canFound,
  canPlace,
  createWorld,
  queueCommand,
  levelOf,
  isOccupied,
  TILE,
  tileAt,
  step,
} from "../src/sim";
import { placeBuilding } from "../src/sim/entities";
import { content, SETUP, firstSpot, planBuildOrder } from "./fixtures";

describe("building", () => {
  it("charges compute and places the building", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, firstSpot("server-rack"));
    step(world, content);
    expect(world.teams[0]!.money).toBe(200 - 60);
    expect(world.entities.some((e) => e.kind === "building" && e.defId === "server-rack")).toBe(true);
  });

  it("rejects blocked terrain, far-away tiles, occupied tiles, and empty wallets", () => {
    const world = createWorld(content, SETUP);
    const { terrain } = world;
    const spot = firstSpot("server-rack");
    let blocked = { col: 0, row: 0 }; // map border is always blocked
    const far = { col: terrain.nest.col - 3, row: terrain.nest.row };
    const reject = (building: string, col: number, row: number) => {
      queueCommand(world, { type: "build", tick: world.tick, team: 0, building, col, row });
      step(world, content);
      const rejected = world.events.find((e) => e.type === "rejected");
      return rejected?.type === "rejected" ? rejected.reason : null;
    };
    blocked = { col: 0, row: terrain.starts[0]!.row };
    expect(reject("server-rack", blocked.col, blocked.row)).toBe("terrain is not buildable");
    expect(reject("server-rack", far.col, far.row)).toMatch(/terrain is not buildable|outside your network/);
    expect(reject("server-rack", spot.col, spot.row)).toBeNull();
    expect(reject("firewall", spot.col, spot.row)).toBe("tile occupied");
    world.teams[0]!.money = 0;
    const other = planBuildOrder(content, SETUP, [[0, "server-rack"], [0, "server-rack"]])[1]!;
    expect(reject("server-rack", other.col, other.row)).toBe("not enough $");
  });

  it("rejects buildings outside the race roster", () => {
    const world = createWorld(content, SETUP);
    const spot = firstSpot("server-rack");
    queueCommand(world, { ...spot, building: "malware-nest" });
    step(world, content);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "rejected", reason: "not in this race's roster" }));
  });
});

describe("builder start", () => {
  it("the deploy agent is quick: walking to a site isn't dead time, and nothing out-runs it", () => {
    const agent = content.units["deploy-agent"]!;
    for (const [id, unit] of Object.entries(content.units)) {
      if (id !== "deploy-agent") expect(agent.speed, id).toBeGreaterThan(unit.speed);
    }
  });

  const BUILDER_SETUP = { seed: 1234, races: ["open-source", "botnet"] as [string, string] };

  it("you start with a deploy agent and no core, and the horde's clocks are on grace time", () => {
    const world = createWorld(content, BUILDER_SETUP);
    expect(world.teams[0]!.coreId).toBe(-1);
    const builder = world.entities.find((e) => e.id === world.teams[0]!.builderId);
    expect(builder).toMatchObject({ kind: "unit", mode: "builder", defId: "deploy-agent" });
    const { graceTicks, firstWaveTicks, firstIncidentTicks } = content.waves;
    expect(world.waves.nextTrickleTick).toBe(graceTicks);
    expect(world.waves.nextWaveTick).toBe(graceTicks + firstIncidentTicks - firstWaveTicks);
    // The nest still has its core.
    expect(world.teams[1]!.coreId).not.toBe(-1);
  });

  it("the builder walks to the chosen site, becomes the core, and starts the horde's clocks", () => {
    const world = createWorld(content, BUILDER_SETUP);
    const start = world.terrain.starts[0]!;
    // Pick a valid site a few tiles away from where the builder stands.
    let site: { col: number; row: number } | null = null;
    for (let r = 4; r <= 10 && !site; r += 1) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
        if (canFound(world, content, 0, start.col + dc, start.row + dr) === null) {
          site = { col: start.col + dc, row: start.row + dr };
          break;
        }
      }
    }
    expect(site).not.toBeNull();
    queueCommand(world, { type: "found", tick: 0, team: 0, ...site! });
    while (world.teams[0]!.coreId === -1 && world.tick < 2000) step(world, content);

    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    expect(core).toMatchObject({ kind: "building", defId: "core", col: site!.col, row: site!.row });
    expect(world.teams[0]!.builderId).toBe(-1);
    expect(world.entities.some((e) => e.kind === "unit" && e.mode === "builder")).toBe(false);
    const founded = world.tick - 1;
    const { graceTicks, firstWaveTicks, firstIncidentTicks } = content.waves;
    expect(world.waves.nextTrickleTick).toBe(Math.min(graceTicks, founded + firstWaveTicks));
    expect(world.waves.nextWaveTick).toBe(Math.min(graceTicks + firstIncidentTicks - firstWaveTicks, founded + firstIncidentTicks));
  });

  it("rejects founding on blocked terrain, and nothing can be built before the core", () => {
    const world = createWorld(content, BUILDER_SETUP);
    queueCommand(world, { type: "found", tick: 0, team: 0, col: 0, row: 0 });
    queueCommand(world, { type: "build", tick: 0, team: 0, building: "server-rack", col: world.terrain.starts[0]!.col, row: world.terrain.starts[0]!.row });
    step(world, content);
    const reasons = world.events.flatMap((e) => (e.type === "rejected" ? [e.reason] : []));
    // Same tick and team: applied in the order they were queued.
    expect(reasons).toEqual(["terrain is not buildable", "no core"]);
  });

  it("losing the builder before founding loses the match", () => {
    const world = createWorld(content, BUILDER_SETUP);
    const builder = world.entities.find((e) => e.id === world.teams[0]!.builderId)!;
    builder.hp = 0;
    step(world, content);
    expect(world.outcome).toMatchObject({ winners: [1], reason: "all-offline" });
  });

  it("traffic and the first incident come at the end of grace time even if you never found", () => {
    const world = createWorld(content, BUILDER_SETUP);
    while (world.tick < content.waves.graceTicks) step(world, content);
    expect(world.waves.trickleSince).toBe(-1);
    expect(world.waves.nextIndex).toBe(0);
    while (world.tick <= world.waves.nextWaveTick && world.waves.nextIndex === 0) step(world, content);
    expect(world.waves.trickleSince).toBe(content.waves.graceTicks);
    expect(world.waves.nextIndex).toBe(1);
  });
});

describe("network and redundancy", () => {
  const coreRadius = content.buildings.core!.buildRadius! * TILE;

  /** An open tile at a given distance (in tiles) from a point, in a fixed search order. */
  function openAt(world: ReturnType<typeof createWorld>, from: { x: number; y: number }, min: number, max: number) {
    const { terrain } = world;
    for (let r = min; r <= max; r++) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) {
        const col = Math.floor(from.x / TILE) + dc;
        const row = Math.floor(from.y / TILE) + dr;
        if (tileAt(terrain, col, row) === 0 && !isOccupied(world, col, row, 1)) return { col, row };
      }
    }
    return null;
  }

  it("each race extends its network differently", () => {
    const os = content.buildings[content.races["open-source"]!.buildings.find((b) => b === "mesh-node")!]!;
    const hyper = content.buildings[content.races.hyperscaler!.buildings.find((b) => b === "edge-pop")!]!;
    expect(os.buildRadius).toBeLessThan(hyper.buildRadius!);
    expect(os.cost).toBeLessThan(hyper.cost);
  });

  it("a finished mesh node lets you build beyond the core's radius; unfinished or destroyed, it doesn't", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.money = 5000;
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    // A node near the edge of the core's reach.
    const node = openAt(world, core, 5, 6)!;
    queueCommand(world, { type: "build", tick: world.tick, team: 0, building: "mesh-node", col: node.col, row: node.row });
    step(world, content);
    const mesh = world.entities.find((e) => e.kind === "building" && e.defId === "mesh-node")!;
    // Somewhere the mesh node reaches but the core doesn't.
    let beyond: { col: number; row: number } | null = null;
    for (let r = 1; r <= 4 && !beyond; r++) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
        const col = node.col + dc;
        const row = node.row + dr;
        const cx = (col + 0.5) * TILE;
        const cy = (row + 0.5) * TILE;
        if (tileAt(world.terrain, col, row) !== 0 || Math.hypot(cx - core.x, cy - core.y) <= coreRadius) continue;
        beyond = { col, row };
        break;
      }
    }
    expect(beyond).not.toBeNull();
    const reason = () => canPlace(world, content, 0, "firewall", beyond!.col, beyond!.row);
    expect(reason()).toBe("outside your network"); // still under construction
    while (mesh.kind === "building" && mesh.buildRemaining > 0) step(world, content);
    expect(reason()).toBeNull();
    mesh.hp = 0;
    step(world, content);
    expect(reason()).toBe("outside your network");
  });

  it("you can hold more cores; losing the main one fails over, and you only lose when every core is down", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.money = 5000;
    const first = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    // A free 2x2 spot inside the network.
    let site: { col: number; row: number } | null = null;
    for (let r = 3; r <= 6 && !site; r++) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
        const col = Math.floor(first.x / TILE) + dc;
        const row = Math.floor(first.y / TILE) + dr;
        if (tileAt(world.terrain, col, row) === 0 && !isOccupied(world, col, row, 2)) {
          site = { col, row };
          break;
        }
      }
    }
    expect(site).not.toBeNull();
    placeBuilding(world, content, 0, "core", site!.col, site!.row, true);
    const second = world.entities.find((e) => e.kind === "building" && e.defId === "core" && e.id !== first.id)!;

    first.hp = 0;
    step(world, content);
    expect(world.outcome).toBeNull();
    expect(world.teams[0]!.coreId).toBe(second.id);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "failover", team: 0 }));

    second.hp = 0;
    step(world, content);
    expect(world.outcome).toMatchObject({ winners: [1], reason: "all-offline" });
  });

  it("research continues at another core after failover", () => {
    const world = createWorld(content, SETUP);
    world.teams[0]!.money = 5000;
    const first = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    let site: { col: number; row: number } | null = null;
    for (let r = 3; r <= 6 && !site; r++) {
      for (const [dc, dr] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
        const col = Math.floor(first.x / TILE) + dc;
        const row = Math.floor(first.y / TILE) + dr;
        if (tileAt(world.terrain, col, row) === 0 && !isOccupied(world, col, row, 2)) {
          site = { col, row };
          break;
        }
      }
    }
    placeBuilding(world, content, 0, "core", site!.col, site!.row, true);
    queueCommand(world, { type: "research", tick: world.tick, team: 0, upgrade: "anycast" });
    step(world, content);
    first.hp = 0;
    for (let i = 0; i < content.upgrades.anycast!.researchTicks + 5; i++) step(world, content);
    expect(levelOf(world.teams[0]!, "anycast")).toBe(1);
  });
});
