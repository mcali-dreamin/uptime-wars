import { describe, expect, it } from "vitest";
import { createWorld } from "../src/sim";
import { HORDE_COLOR, PLAYER_COLORS, setLocalColor, teamColor } from "../src/render/palette";
import { content } from "./fixtures";

describe("team colours", () => {
  const world = createWorld(content, { seed: 1234, races: ["open-source", "open-source", "botnet"], startWithCore: true });
  const horde = world.teams.findIndex((t) => t.controller !== "human");

  it("players get distinct defaults and the horde is always red", () => {
    setLocalColor(0, PLAYER_COLORS[0]);
    expect(teamColor(world, 0)).toBe(PLAYER_COLORS[0]);
    expect(teamColor(world, 1)).toBe(PLAYER_COLORS[1]);
    expect(teamColor(world, horde)).toBe(HORDE_COLOR);
  });

  it("your pick paints your team; an ally with that default takes yours, so nobody matches", () => {
    setLocalColor(0, PLAYER_COLORS[1]);
    expect(teamColor(world, 0)).toBe(PLAYER_COLORS[1]);
    expect(teamColor(world, 1)).toBe(PLAYER_COLORS[0]);
    setLocalColor(1, 0xe2e8f0);
    expect(teamColor(world, 1)).toBe(0xe2e8f0);
    expect(teamColor(world, 0)).toBe(PLAYER_COLORS[0]);
    expect(teamColor(world, horde)).toBe(HORDE_COLOR);
  });
});
