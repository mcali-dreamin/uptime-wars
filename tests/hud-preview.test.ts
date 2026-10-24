import { describe, expect, it } from "vitest";
import { previewWave } from "../src/sim";
import { previewLine } from "../src/ui/hud";
import { content } from "./fixtures";

describe("the HUD's next-incident list", () => {
  it("puts the boss first, then what's new: the list trails off when the bar is narrow", () => {
    let checked = 0;
    for (let wave = 2; wave < 40; wave += 1) {
      const preview = previewWave(content, wave);
      const line = previewLine(content, wave);
      const kinds = line.map((part) => part.kind);
      expect(line, `wave ${wave}`).toHaveLength(preview.creeps.length + (preview.bosses > 0 ? 1 : 0));
      if (preview.bosses > 0) expect(kinds[0], `wave ${wave}`).toBe("boss");
      // Everything new comes before anything that isn't.
      const rest = kinds.filter((k) => k !== "boss");
      expect(rest, `wave ${wave}`).toEqual([...rest].sort((a, b) => Number(b === "new") - Number(a === "new")));
      if (preview.bosses > 0 && preview.fresh.length > 0) checked += 1;
    }
    expect(checked, "some wave has both a boss and something new").toBeGreaterThan(0);
  });
});
