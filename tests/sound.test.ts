// Sound: which sim events make which sounds, how loud, and how often.

import { describe, expect, it } from "vitest";
import { Director, tension, type Listener } from "../src/audio/cues";
import { createWorld, step, type SimEvent, type World } from "../src/sim";
import { spawnUnit } from "../src/sim/entities";
import { makeContext } from "../src/sim/context";
import { content, SETUP } from "./fixtures";

const listener = (at: { x: number; y: number }, visible = true): Listener => ({ center: at, span: 1600, visible: () => visible });

function setup() {
  const world = createWorld(content, SETUP);
  const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
  return { world, core, director: new Director(content), here: listener(core) };
}

const shot = (_world: World, x: number, y: number, team = 1, to = -1): SimEvent => ({ type: "shot", from: -1, to, x1: x, y1: y, x2: x + 10, y2: y, team: team as 0 | 1 });

describe("sound director", () => {
  it("every sound cue has a recipe", async () => {
    const { SoundEngine } = await import("../src/audio/engine");
    void SoundEngine;
    const source = (await import("../src/audio/engine.ts?raw")).default as string;
    const cues = (await import("../src/audio/cues.ts?raw")).default as string;
    const names = [...cues.matchAll(/\| "([a-z-]+)"/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) expect(source, name).toMatch(new RegExp(`(^|\\s)"?${name}"?: \\(v\\)`, "m"));
  });

  it("big moments always play: waves, bosses, founding, level-ups, your casts", () => {
    const { world, director, here } = setup();
    const events: SimEvent[] = [
      { type: "wave", wave: 3, name: "x", packs: 2, units: 10, boss: false },
      { type: "wave", wave: 8, name: "y", packs: 2, units: 10, boss: true },
      { type: "founded", x: 0, y: 0 },
      { type: "hero-level", team: 0, level: 2 },
      { type: "cast", team: 0, ability: "fan-out", x: here.center.x, y: here.center.y, radius: 110, targetId: null },
    ];
    expect(director.cues(world, events, 0, here, 0).map((c) => c.name)).toEqual(["wave", "boss", "founded", "level-up", "cast-blast"]);
  });

  it("other players' hero events stay quiet", () => {
    const { world, director, here } = setup();
    const events: SimEvent[] = [
      { type: "hero-level", team: 1, level: 2 },
      { type: "hero-down", team: 1, respawnAt: 9 },
      { type: "researched", team: 1, upgrade: "x", level: 1 },
    ];
    expect(director.cues(world, events, 0, here, 0)).toEqual([]);
  });

  it("combat you can't see is silent; far-off combat fades and pans", () => {
    const { world, core, director } = setup();
    expect(director.cues(world, [shot(world, core.x, core.y)], 0, listener(core, false), 0)).toEqual([]);
    const near = director.cues(world, [shot(world, core.x, core.y)], 0, listener(core), 1)[0]!;
    const far = new Director(content).cues(world, [shot(world, core.x + 1400, core.y)], 0, listener(core), 1)[0]!;
    expect(far.volume).toBeLessThan(near.volume);
    expect(far.pan).toBeGreaterThan(0);
    // Way off screen: nothing.
    expect(new Director(content).cues(world, [shot(world, core.x + 5000, core.y)], 0, listener(core), 1)).toEqual([]);
  });

  it("a hundred shots in one tick make two sounds, and the next tick waits its turn", () => {
    const { world, core, director, here } = setup();
    const burst = Array.from({ length: 100 }, () => shot(world, core.x, core.y));
    expect(director.cues(world, burst, 0, here, 10).length).toBe(2);
    expect(director.cues(world, burst, 0, here, 10.01).length).toBe(0);
    expect(director.cues(world, burst, 0, here, 10.2).length).toBeGreaterThan(0);
  });

  it("your core getting hit sounds an alarm, at most every few seconds", () => {
    const { world, core, director, here } = setup();
    const hit = shot(world, core.x, core.y, 1, core.id);
    expect(director.cues(world, [hit], 0, here, 0).map((c) => c.name)).toEqual(["hit-building", "alarm"]);
    expect(director.cues(world, [hit], 0, here, 1).map((c) => c.name)).toEqual(["hit-building"]);
    expect(director.cues(world, [hit], 0, here, 7).map((c) => c.name)).toContain("alarm");
  });

  it("deaths: buildings and big units sound bigger (the event says what died)", () => {
    const { world, core, director, here } = setup();
    const at = { x: core.x, y: core.y };
    const cues = director.cues(
      world,
      [
        { type: "death", id: 1, ...at, team: 1, kind: "unit", defId: "bot" },
        { type: "death", id: 2, ...at, team: 1, kind: "unit", defId: "ransomware" },
        { type: "death", id: 3, ...at, team: 0, kind: "building", defId: "server-rack" },
      ],
      0,
      here,
      0,
    );
    expect(cues.map((c) => c.name)).toEqual(["death", "death-big", "building-down"]);
  });

  it("real matches: deaths carry kind and defId, and the end plays once", () => {
    const world = createWorld(content, SETUP);
    const ctx = makeContext(world, content);
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    const creep = spawnUnit(ctx, 1, "bot", core, core.x + 40, core.y, "roam");
    creep.hp = 1;
    let death: SimEvent | undefined;
    for (let i = 0; i < 200 && !death; i += 1) {
      step(world, content);
      death = world.events.find((e) => e.type === "death");
    }
    expect(death).toMatchObject({ kind: "unit", defId: "bot" });

    const director = new Director(content);
    for (const e of world.entities) if (e.team === 0 && e.kind === "building") e.hp = 0;
    step(world, content);
    const end = director.cues(world, world.events, 0, listener(core), 0).map((c) => c.name);
    expect(end).toContain("defeat");
    expect(director.cues(world, [{ type: "founded", x: 0, y: 0 }], 0, listener(core), 1).map((c) => c.name)).not.toContain("defeat");
  });

  it("tension rises with enemies near your core", () => {
    const world = createWorld(content, SETUP);
    expect(tension(world, 0, content)).toBe(0);
    const ctx = makeContext(world, content);
    const core = world.entities.find((e) => e.id === world.teams[0]!.coreId)!;
    for (let i = 0; i < 10; i += 1) spawnUnit(ctx, 1, "bot", core, core.x + 200 + i * 10, core.y, "roam");
    expect(tension(world, 0, content)).toBeCloseTo(0.5);
  });
});
