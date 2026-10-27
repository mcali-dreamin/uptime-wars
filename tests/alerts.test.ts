import { describe, expect, it } from "vitest";
import { createWorld, queueCommand, step, type Building, type SimEvent, type Unit, type World } from "../src/sim";
import { Alerts } from "../src/game/alerts";
import { content, firstSpot, SETUP } from "./fixtures";

const offScreen = () => false;
const onScreen = () => true;

function base(): { world: World; rack: Building; core: Building } {
  const world = createWorld(content, SETUP);
  world.waves.nextWaveTick = 1e9;
  world.waves.nextTrickleTick = 1e9;
  queueCommand(world, firstSpot("server-rack"));
  while (!world.entities.some((e) => e.kind === "building" && e.defId === "server-rack" && e.buildRemaining === 0)) step(world, content);
  const rack = world.entities.find((e): e is Building => e.kind === "building" && e.defId === "server-rack")!;
  const core = world.entities.find((e): e is Building => e.id === world.teams[0]!.coreId)!;
  return { world, rack, core };
}

const shotAt = (target: Building, team = 1): SimEvent => ({ type: "shot", from: 999, to: target.id, x1: 0, y1: 0, x2: target.x, y2: target.y, team });

describe("alerts", () => {
  it("an off-screen hit on your base alerts once, then stays quiet while the siege goes on", () => {
    const { world, rack } = base();
    const alerts = new Alerts(content);
    expect(alerts.update(world, [shotAt(rack)], 0, 0, offScreen).map((a) => a.kind)).toEqual(["attack"]);
    expect(alerts.update(world, [shotAt(rack)], 0, 5, offScreen)).toEqual([]);
    expect(alerts.update(world, [shotAt(rack)], 0, 20, offScreen)).toHaveLength(1);
  });

  it("a fight you're watching doesn't alert; your core being hit always does", () => {
    const { world, rack, core } = base();
    const alerts = new Alerts(content);
    expect(alerts.update(world, [shotAt(rack)], 0, 0, onScreen)).toEqual([]);
    expect(alerts.update(world, [shotAt(core)], 0, 0, onScreen).map((a) => a.kind)).toEqual(["core"]);
  });

  it("your own shots and hits on other teams don't alert", () => {
    const { world, rack } = base();
    const alerts = new Alerts(content);
    expect(alerts.update(world, [shotAt(rack, 0)], 0, 0, offScreen)).toEqual([]);
    expect(alerts.update(world, [shotAt(rack)], 1, 0, offScreen)).toEqual([]);
  });

  it("losing a building and the hero falling always alert, with where it happened", () => {
    const { world, rack } = base();
    const alerts = new Alerts(content);
    const raised = alerts.update(
      world,
      [
        { type: "death", id: rack.id, x: rack.x, y: rack.y, team: 0, kind: "building", defId: "server-rack" },
        { type: "hero-down", team: 0, respawnAt: 100, x: 123, y: 456 },
      ],
      0,
      0,
      onScreen,
    );
    expect(raised.map((a) => [a.kind, a.text])).toEqual([["lost", "Server Rack lost"], ["hero", "Your hero has fallen"]]);
    expect(raised[1]).toMatchObject({ x: 123, y: 456 });
  });

  it("latest() is the newest fresh alert, for Space to jump to", () => {
    const { world, rack, core } = base();
    const alerts = new Alerts(content);
    alerts.update(world, [shotAt(rack)], 0, 0, offScreen);
    alerts.update(world, [shotAt(core)], 0, 1, offScreen);
    expect(alerts.latest(2)).toMatchObject({ kind: "core", x: core.x });
    expect(alerts.latest(100)).toBeNull();
  });

  it("a real hit in a running match raises a real alert", () => {
    const { world, rack } = base();
    const alerts = new Alerts(content);
    world.waves.nextTrickleTick = world.tick;
    let raised: string[] = [];
    // Park a creep next to the rack and let it fight.
    while (!world.entities.some((e) => e.kind === "unit" && e.team === 1 && e.mode === "roam")) step(world, content);
    const creep = world.entities.find((e) => e.kind === "unit" && e.team === 1 && e.mode === "roam")!;
    for (const u of world.entities) if (u.kind === "unit" && u.team === 0) { u.x = u.homeX = rack.x - 3000; u.y = u.homeY = rack.y; }
    creep.x = rack.x + rack.radius + creep.radius + 4;
    creep.y = rack.y;
    for (let i = 0; i < 200 && raised.length === 0; i++) {
      step(world, content);
      raised = alerts.update(world, world.events, 0, i / 20, offScreen).map((a) => a.kind);
    }
    expect(raised.length).toBeGreaterThan(0);
  });

  it("an Infector heading out, and the node it builds, alert where they are, so Space takes you there", () => {
    const { world } = base();
    const alerts = new Alerts(content);
    const heading = alerts.update(world, [{ type: "infecting", x: 4000, y: 3000 }], 0, 0, onScreen);
    expect(heading.map(({ kind, x, y }) => ({ kind, x, y }))).toEqual([{ kind: "spread", x: 4000, y: 3000 }]);
    expect(alerts.latest(1)).toMatchObject({ kind: "spread", x: 4000, y: 3000 });
    expect(alerts.update(world, [{ type: "infected", x: 4000, y: 3000 }], 0, 40, offScreen).map((a) => a.text)).toEqual(["The botnet is building an Infected Node"]);
  });

  describe("army alerts", () => {
    let nextId = 50000;
    let proto: Unit | undefined;
    const addUnit = (world: World, team: number, x: number, y: number, mode: Unit["mode"] = "guard"): Unit => {
      proto ??= world.entities.find((e): e is Unit => e.kind === "unit")!;
      const unit: Unit = { ...proto, id: nextId++, team, x, y, mode, hp: 100 };
      world.entities.push(unit);
      return unit;
    };
    const shot = (from: number, to: number, team: number): SimEvent => ({ type: "shot", from, to, x1: 0, y1: 0, x2: 0, y2: 0, team });
    const clearGuards = (world: World) => {
      proto ??= world.entities.find((e): e is Unit => e.kind === "unit")!;
      world.entities = world.entities.filter((e) => !(e.kind === "unit" && e.team === 0));
    };

    it("a soldier shot off-screen alerts 'fighting'; on-screen it doesn't", () => {
      const { world } = base();
      const mine = addUnit(world, 0, 500, 600);
      const foe = addUnit(world, 1, 600, 600, "roam");
      const alerts = new Alerts(content);
      expect(alerts.update(world, [shot(foe.id, mine.id, 1)], 0, 0, onScreen)).toEqual([]);
      const raised = alerts.update(world, [shot(foe.id, mine.id, 1)], 0, 1, offScreen);
      expect(raised.map((a) => [a.kind, a.text, a.x, a.y])).toEqual([["fighting", "Your army is fighting", 500, 600]]);
    });

    it("a soldier shooting an enemy off-screen alerts 'fighting' at the soldier", () => {
      const { world } = base();
      const mine = addUnit(world, 0, 500, 600);
      const foe = addUnit(world, 1, 600, 600, "roam");
      const alerts = new Alerts(content);
      const raised = alerts.update(world, [shot(mine.id, foe.id, 0)], 0, 0, offScreen);
      expect(raised.map((a) => [a.kind, a.x, a.y])).toEqual([["fighting", 500, 600]]);
    });

    it("'fighting' is rate limited at the same place and fires again elsewhere", () => {
      const { world } = base();
      const a = addUnit(world, 0, 500, 600);
      const b = addUnit(world, 0, 500 + 5000, 600);
      const foe = addUnit(world, 1, 600, 600, "roam");
      const alerts = new Alerts(content);
      expect(alerts.update(world, [shot(foe.id, a.id, 1)], 0, 0, offScreen)).toHaveLength(1);
      expect(alerts.update(world, [shot(foe.id, a.id, 1)], 0, 10, offScreen)).toEqual([]);
      expect(alerts.update(world, [shot(foe.id, b.id, 1)], 0, 11, offScreen)).toHaveLength(1);
      expect(alerts.update(world, [shot(foe.id, a.id, 1)], 0, 25, offScreen)).toHaveLength(1);
    });

    it("the builder / deploy agent being shot is not 'fighting'", () => {
      const { world } = base();
      const agent = addUnit(world, 0, 500, 600, "builder");
      const foe = addUnit(world, 1, 600, 600, "roam");
      const alerts = new Alerts(content);
      expect(alerts.update(world, [shot(foe.id, agent.id, 1)], 0, 0, offScreen)).toEqual([]);
      expect(alerts.update(world, [shot(agent.id, foe.id, 0)], 0, 1, offScreen)).toEqual([]);
    });

    /** `unit` dies: it leaves the world and its death event goes to `alerts`. */
    const kill = (alerts: Alerts, world: World, unit: Unit, now: number, see = onScreen) => {
      world.entities = world.entities.filter((e) => e.id !== unit.id);
      return alerts.update(world, [{ type: "death", id: unit.id, x: unit.x, y: unit.y, team: unit.team, kind: "unit", defId: unit.defId }], 0, now, see);
    };

    it("four soldier deaths in the window with few left alert 'wiped' at the centroid, even on-screen", () => {
      const { world } = base();
      clearGuards(world);
      const dying = [0, 1, 2, 3].map((i) => addUnit(world, 0, 100 * i, 200 * i));
      addUnit(world, 0, 0, 0);
      const alerts = new Alerts(content);
      alerts.update(world, [], 0, 0, onScreen);
      const raised = dying.flatMap((u, i) => kill(alerts, world, u, i));
      expect(raised.map((a) => [a.kind, a.text])).toEqual([["wiped", "Your army is being wiped out"]]);
      expect(raised[0]).toMatchObject({ x: 150, y: 300 });
    });

    it("deaths spread over more than the window don't count", () => {
      const { world } = base();
      clearGuards(world);
      const dying = [0, 1, 2, 3].map((i) => addUnit(world, 0, i, 0));
      const alerts = new Alerts(content);
      alerts.update(world, [], 0, 0, onScreen);
      expect(dying.flatMap((u, i) => kill(alerts, world, u, i * 6))).toEqual([]);
    });

    it("deaths with a big army still alive don't count", () => {
      const { world } = base();
      clearGuards(world);
      const dying = [0, 1, 2, 3].map((i) => addUnit(world, 0, i, 0));
      for (let i = 0; i < 20; i++) addUnit(world, 0, i, 50);
      const alerts = new Alerts(content);
      alerts.update(world, [], 0, 0, onScreen);
      expect(dying.flatMap((u, i) => kill(alerts, world, u, i))).toEqual([]);
    });

    it("the hero, decoys and the deploy agent dying don't count", () => {
      const { world } = base();
      clearGuards(world);
      const dying = (["hero", "decoy", "decoy", "builder", "decoy"] as const).map((mode, i) => addUnit(world, 0, i, 0, mode));
      const alerts = new Alerts(content);
      alerts.update(world, [], 0, 0, onScreen);
      expect(dying.flatMap((u, i) => kill(alerts, world, u, i))).toEqual([]);
    });

    it("a decoy or the hero being shot doesn't alert 'fighting'", () => {
      const { world } = base();
      const decoy = addUnit(world, 0, 500, 600, "decoy");
      const hero = addUnit(world, 0, 520, 600, "hero");
      const foe = addUnit(world, 1, 600, 600, "roam");
      const alerts = new Alerts(content);
      expect(alerts.update(world, [shot(foe.id, decoy.id, 1), shot(foe.id, hero.id, 1)], 0, 0, offScreen)).toEqual([]);
    });
  });
});

describe("site alerts", () => {
  it("says when you capture or lose a site, and when an enemy you can see takes one", () => {
    const world = createWorld(content, { seed: 1234, races: ["open-source", "hyperscaler"], mode: "ffa", startWithCore: true });
    const alerts = new Alerts(content);
    const at = { x: 100, y: 100, id: 5 };
    const neutral = world.teams.length - 1;
    expect(alerts.update(world, [{ type: "siteCaptured", team: 0, from: neutral, ...at }], 0, 0, offScreen).map((a) => a.text)).toEqual(["Site captured"]);
    expect(alerts.update(world, [{ type: "siteLost", team: 0, by: 1, ...at }], 0, 1, offScreen).map((a) => a.text)).toEqual(["Site lost"]);
    const took = { type: "siteCaptured" as const, team: 1, from: neutral, ...at };
    expect(alerts.update(world, [took], 0, 2, offScreen, () => false)).toEqual([]);
    expect(alerts.update(world, [took], 0, 3, offScreen, () => true).map((a) => a.text)).toEqual(["An enemy took a site"]);
  });
});

describe("expansion alerts", () => {
  it("names the main core and an expansion differently", () => {
    const { world, core } = base();
    const exp = { ...core, id: 9999, x: core.x + 5000 } as Building;
    world.entities.push(exp);
    const alerts = new Alerts(content);
    expect(alerts.update(world, [shotAt(core)], 0, 0, offScreen)[0]!.text).toBe("Your core is under attack");
    const hit = alerts.update(world, [shotAt(exp)], 0, 0, offScreen)[0]!;
    expect(hit).toMatchObject({ text: "Your expansion is under attack", x: exp.x });
    const death = (b: Building): SimEvent => ({ type: "death", id: b.id, x: b.x, y: b.y, team: 0, kind: "building", defId: b.defId });
    expect(alerts.update(world, [death(exp)], 0, 1, offScreen)[0]!.text).toBe("Expansion lost");
    expect(alerts.update(world, [death(core)], 0, 2, offScreen)[0]!.text).toBe("Core lost");
  });
});
