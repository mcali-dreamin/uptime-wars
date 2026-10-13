import { describe, expect, it } from "vitest";
import { createWorld, queueCommand, step, type Building, type SimEvent, type World } from "../src/sim";
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
});
