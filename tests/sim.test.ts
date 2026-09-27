import { describe, expect, it } from "vitest";
import {
  createWorld,
  hashWorld,
  loadDefaultContent,
  queueCommand,
  simulate,
  step,
  validateContent,
  type Command,
  type Content,
} from "../src/sim";

const content = loadDefaultContent();
const SETUP = { seed: 1234, races: ["open-source", "botnet"] as [string, string] };

function build(tick: number, building: string, col: number, row: number): Command {
  return { type: "build", tick, team: 0, building, col, row };
}

const OPENING: Command[] = [
  build(1, "server-rack", 5, 8),
  build(1, "server-rack", 5, 12),
  build(200, "firewall", 8, 10),
  build(400, "solar-array", 3, 3),
  build(700, "gpu-cluster", 5, 5),
  build(1000, "firewall", 8, 14),
  build(1300, "server-rack", 5, 15),
];

describe("determinism", () => {
  it("same seed and command log produce the same world", () => {
    const a = simulate(content, SETUP, OPENING, 3000);
    const b = simulate(content, SETUP, OPENING, 3000);
    expect(a.tick).toBe(b.tick);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it("a different seed diverges", () => {
    const a = simulate(content, SETUP, OPENING, 1500);
    const b = simulate(content, { ...SETUP, seed: 99 }, OPENING, 1500);
    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });

  it("hash is stable when checked mid-match (replay checkpoints)", () => {
    const world = createWorld(content, SETUP);
    for (const command of OPENING) queueCommand(world, command);
    const checkpoints: string[] = [];
    for (let i = 0; i < 1200; i += 1) {
      step(world, content);
      if (world.tick % 300 === 0) checkpoints.push(hashWorld(world));
    }
    const replay = createWorld(content, SETUP);
    for (const command of OPENING) queueCommand(replay, command);
    const replayed: string[] = [];
    for (let i = 0; i < 1200; i += 1) {
      step(replay, content);
      if (replay.tick % 300 === 0) replayed.push(hashWorld(replay));
    }
    expect(replayed).toEqual(checkpoints);
  });
});

describe("building", () => {
  it("charges compute and places the building", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, build(0, "server-rack", 5, 8));
    step(world, content);
    expect(world.teams[0].compute).toBe(200 - 60);
    expect(world.entities.some((e) => e.kind === "building" && e.defId === "server-rack")).toBe(true);
  });

  it("rejects builds outside the zone, on occupied tiles, or without compute", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, build(0, "server-rack", 20, 8)); // mid-lane
    queueCommand(world, build(0, "server-rack", 5, 8));
    queueCommand(world, build(0, "firewall", 5, 8)); // occupied
    queueCommand(world, build(0, "gpu-cluster", 6, 8)); // 140 > 140 remaining? 200-60=140, allowed
    queueCommand(world, build(0, "gpu-cluster", 7, 8)); // now broke
    step(world, content);
    const reasons = world.events.filter((e) => e.type === "rejected").map((e) => e.type === "rejected" && e.reason);
    expect(reasons).toEqual(["outside build zone", "tile occupied", "not enough compute"]);
  });

  it("rejects buildings outside the race roster", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, build(0, "core", 5, 8));
    step(world, content);
    expect(world.events).toContainEqual(expect.objectContaining({ type: "rejected", reason: "not in this race's roster" }));
  });
});

describe("auto-spawn", () => {
  it("a finished server rack forks processes on its (race-modified) timer", () => {
    const world = createWorld(content, SETUP);
    queueCommand(world, build(0, "server-rack", 5, 8));
    const def = content.buildings["server-rack"]!;
    const interval = Math.round(def.spawn!.intervalTicks * content.races["open-source"]!.modifiers.spawnIntervalMultiplier);
    // Placed on step 0, built after buildTicks steps, then fires on the
    // interval-th step after that.
    const stepsBeforeSpawn = def.buildTicks + interval - 1;

    while (world.tick < stepsBeforeSpawn) step(world, content);
    const processes = () => world.entities.filter((e) => e.kind === "unit" && e.defId === "process").length;
    expect(processes()).toBe(0);
    step(world, content);
    expect(processes()).toBe(def.spawn!.count);
  });
});

describe("waves", () => {
  it("the wave director sends the first wave on schedule", () => {
    const world = createWorld(content, SETUP);
    while (world.tick <= content.waves.firstWaveTicks) step(world, content);
    expect(world.waves.nextIndex).toBe(1);
    const bots = world.entities.filter((e) => e.kind === "unit" && e.team === 1);
    expect(bots.length).toBeGreaterThan(0);
  });

  it("an undefended core eventually goes offline", () => {
    const world = simulate(content, SETUP, [], 20_000);
    expect(world.outcome).toMatchObject({ winner: 1, reason: "core-destroyed" });
  });

  it("a reasonable opening survives every wave or wins outright", () => {
    const world = simulate(content, SETUP, OPENING, 20_000);
    expect(world.outcome?.winner).toBe(0);
  });
});

describe("content", () => {
  it("rejects broken references", () => {
    const broken: Content = structuredClone(content);
    broken.waves.waves[0]!.groups[0]!.unit = "missing";
    expect(() => validateContent(broken)).toThrow(/unknown unit missing/);
  });
});
