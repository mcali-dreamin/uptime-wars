import { describe, expect, it } from "vitest";
import { createWorld, step } from "../src/sim";
import { validateContent } from "../src/sim/content";
import { hordeMaxAlive } from "../src/sim/waves";
import { lobbySetup } from "../src/game/net/lobby";
import { buildReport } from "../src/game/telemetry";
import { parseMatch } from "../zero/server/matches";
import { playMatch } from "../balance/bot";
import { content, SETUP } from "./fixtures";

describe("horde difficulty", () => {
  it.each([["easy", 300], ["normal", 500], ["hard", 1000], ["nightmare", 1500]] as const)("resolves %s without changing shared content", (id, cap) => {
    const world = createWorld(content, { ...SETUP, hordeDifficulty: id });
    expect(hordeMaxAlive(content, world)).toBe(cap);
    expect(content.waves.maxAlive).toBe(500);
  });

  it("defaults to unchanged normal content", () => {
    const world = createWorld(content, SETUP);
    expect(world.hordeDifficulty).toBe("normal");
    expect(hordeMaxAlive(content, world)).toBe(content.waves.maxAlive);
    expect(world).toEqual(createWorld(content, { ...SETUP, hordeDifficulty: "normal" }));
  });

  it.each(["missing", "toString", "__proto__"])("rejects unknown id %s", (id) => {
    expect(() => createWorld(content, { ...SETUP, hordeDifficulty: id })).toThrow("Unknown horde difficulty");
  });

  it("round-trips lobby setup and steps deterministically", () => {
    const setup = lobbySetup(42, [{ race: SETUP.races[0]! }], [], { horde: true, hordeDifficulty: "nightmare" });
    const a = createWorld(content, setup);
    const b = createWorld(content, JSON.parse(JSON.stringify(setup)));
    for (let i = 0; i < 200; i++) { step(a, content); step(b, content); }
    expect(a).toEqual(b);
    expect(b.hordeDifficulty).toBe("nightmare");
  });

  it("persists difficulty in telemetry and stored match summaries", () => {
    const world = createWorld(content, { ...SETUP, hordeDifficulty: "hard" });
    const report = buildReport(content, world, 0, "12345678-abcd", "1.2.3", true);
    expect(report.hordeDifficulty).toBe("hard");
    const row = parseMatch(report);
    expect(typeof row).toBe("object");
    if (typeof row !== "string") expect(JSON.parse(row.summary).hordeDifficulty).toBe("hard");
  });

  it("records the horde id in balance results", () => {
    const hero = content.races[SETUP.races[0]!]!.heroes![0]!;
    expect(playMatch(content, SETUP.races[0]!, 42, hero, { minutes: 0, hero: true, aggressive: false, hordeDifficulty: "easy" }).hordeDifficulty).toBe("easy");
  });

  it("validates override caps and text", () => {
    const changed = { ...content, hordeDifficulties: { ...content.hordeDifficulties, easy: { name: "", description: "", waves: { maxAlive: -1 } } } };
    expect(() => validateContent(changed)).toThrow();
  });
});
