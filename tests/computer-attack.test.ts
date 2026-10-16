// Computer players attack (issue #123): only other players, only when the
// match has some, scouting start spots rather than knowing who's where, and
// pulling back when the attack is spent or home is in trouble.

import { describe, expect, it } from "vitest";
import { TICK_RATE, createWorld, hashWorld, step, type Content, type Unit, type World } from "../src/sim";
import { moveHero, playArmy } from "../src/sim/ai/army";
import { content as base } from "./fixtures";

/** The same difficulties, but every attack may start after a minute: tests don't wait ten. */
const content: Content = {
  ...base,
  difficulties: Object.fromEntries(
    Object.entries(base.difficulties).map(([id, d]) => [id, { ...d, attack: d.attack && { ...d.attack, firstTicks: 60 * TICK_RATE } }]),
  ),
};
const run = (world: World, minutes: number) => {
  const until = world.tick + minutes * 60 * TICK_RATE;
  while (world.tick < until && !world.outcome) step(world, content);
};
const ordered = (world: World, team: number) => world.entities.filter((e) => e.kind === "unit" && e.team === team && e.commanded).length;

describe("computer players attack", () => {
  it("breaks a player who doesn't defend", () => {
    const world = createWorld(content, { seed: 42, mode: "ffa", races: ["open-source", "hyperscaler"], startWithCore: true, ai: [undefined, "normal"] });
    run(world, 20);
    expect(world.outcome?.winners).toEqual([1]);
    // Its army did it: the player's core fell to units it ordered.
    expect(world.teams[0]!.downTick).not.toBeNull();
  });

  it("finds its enemy by checking start spots, not by knowing where it is", () => {
    const world = createWorld(content, { seed: 7, mode: "ffa", races: ["serverless", "walled-garden"], startWithCore: true, ai: [undefined, "hard"] });
    const ai = world.teams[1]!.ai!;
    const spotOf = (i: number) => world.terrain.starts[i]!;
    const far = (i: number) => Math.hypot(spotOf(i).col - spotOf(1).col, spotOf(i).row - spotOf(1).row);
    let firstGoal: number | null = null;
    while (world.tick < 20 * 60 * TICK_RATE && !world.outcome && ai.known.length === 0) {
      step(world, content);
      firstGoal ??= ai.goal;
    }
    // It went for the nearest spot first, whoever was (or wasn't) there.
    const others = [0, 2, 3];
    expect(firstGoal).toBe(others.reduce((a, b) => (far(b) < far(a) ? b : a)));
    expect(ai.known).toEqual([0]);
    // Every spot it looked at was empty, or it found who's there.
    for (const spot of ai.checked) expect(spot === 0 ? ai.known.includes(0) : [2, 3].includes(spot)).toBe(true);
  });

  it("never attacks alone against the horde, or in co-op: balance runs and allies are untouched", () => {
    const solo = createWorld(content, { seed: 99, races: ["hyperscaler", "botnet"], startWithCore: true, ai: ["hard"] });
    const coop = createWorld(content, { seed: 99, races: ["hyperscaler", "serverless", "botnet"], startWithCore: true, ai: [undefined, "hard"] });
    run(solo, 8);
    run(coop, 8);
    expect(solo.teams[0]!.ai!.phase).toBe("gather");
    expect(coop.teams[1]!.ai!.phase).toBe("gather");
    expect(ordered(solo, 0)).toBe(0);
    expect(ordered(coop, 1)).toBe(0);
  });

  it("pulls back when the attack is spent, or when home is in trouble", () => {
    const world = createWorld(content, { seed: 1, mode: "ffa", races: ["open-source", "hyperscaler"], startWithCore: true, ai: [undefined, "normal"] });
    run(world, 6);
    const team = world.teams[1]!;
    const plan = content.difficulties.normal!.attack!;
    const army = () => world.entities.filter((e): e is Unit => e.kind === "unit" && e.team === 1 && e.mode === "guard");
    expect(army().length).toBeGreaterThan(0);
    const issued: string[] = [];
    const issue = (c: { type: string }) => issued.push(c.type);

    // Spent: what's left is a fraction of what set out.
    Object.assign(team.ai!, { phase: "attack", group: army().map((u) => u.id), launched: 1e6, goal: null, goalId: -1 });
    playArmy(world, content, team, plan, issue);
    expect(team.ai!.phase).toBe("retreat");
    expect(issued).toContain("order");
    expect(team.ai!.until).toBe(world.tick + plan.cooldownTicks);

    // Home in trouble: the core is low, however the attack is going.
    const core = world.entities.find((e) => e.id === team.coreId)!;
    Object.assign(team.ai!, { phase: "attack", group: army().map((u) => u.id), launched: 1, goalId: -1 });
    core.hp = core.maxHp * (plan.recallBelowPermille / 1000) * 0.9;
    playArmy(world, content, team, plan, issue);
    expect(team.ai!.phase).toBe("retreat");
  });

  it("its hero goes with an attack, and heads home when hurt", () => {
    const world = createWorld(content, { seed: 1, mode: "ffa", races: ["open-source", "hyperscaler"], startWithCore: true, ai: [undefined, "normal"] });
    run(world, 3);
    const team = world.teams[1]!;
    const plan = content.difficulties.normal!.attack!;
    const hero = world.entities.find((e): e is Unit => e.id === team.hero?.unitId)!;
    const core = world.entities.find((e) => e.id === team.coreId)!;
    const army = world.entities.filter((e): e is Unit => e.kind === "unit" && e.team === 1 && e.mode === "guard");
    expect(hero).toBeDefined();
    // Its army is out across the map.
    const far = { x: core.x + 3000, y: core.y };
    for (const u of army) Object.assign(u, far);
    Object.assign(team.ai!, { phase: "attack", group: army.map((u) => u.id) });
    team.hero!.cast = null;
    hero.moveTo = null;
    const moves: { x: number; y: number }[] = [];
    const issue = (c: { type: string; x?: number; y?: number }) => c.type === "move" && moves.push({ x: c.x!, y: c.y! });

    moveHero(world, team, plan, issue);
    expect(moves).toEqual([far]);

    moves.length = 0;
    Object.assign(hero, far);
    hero.hp = hero.maxHp * (plan.heroRetreatPermille / 1000) * 0.5;
    moveHero(world, team, plan, issue);
    expect(moves).toEqual([{ x: core.x, y: core.y }]);
  });

  it("a computer free-for-all is deterministic", () => {
    const setup = { seed: 2026, mode: "ffa" as const, races: ["hyperscaler", "open-source", "walled-garden"], startWithCore: true, ai: ["hard", "normal", "insane"] };
    const a = createWorld(content, setup);
    const b = createWorld(content, setup);
    run(a, 7);
    run(b, 7);
    expect(a.teams.some((t) => t.ai!.phase !== "gather" || t.ai!.checked.length > 0)).toBe(true);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });
});
