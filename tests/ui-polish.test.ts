import { describe, expect, it } from "vitest";
import { buildingForKey, buildingHotkeyLabel, hotkeyLabel } from "../src/ui/build-bar";
import { content } from "./fixtures";
import { placeReasonText } from "../src/game/selection";

describe("hotkey label", () => {
  it("maps the tenth button to key 0", () => {
    expect([0, 1, 8, 9].map(hotkeyLabel)).toEqual(["1", "2", "9", "0"]);
  });

  it("puts Wall and Gate on L and K in every race, and every other building on its own number key", () => {
    for (const [id, race] of Object.entries(content.races)) {
      if (race.controller !== "human") continue;
      const buildings = race.buildings;
      expect(buildingForKey(buildings, "l"), id).toBe("wall");
      expect(buildingForKey(buildings, "k"), id).toBe("gate");
      expect(buildingHotkeyLabel(buildings, "wall")).toBe("L");
      const labels = buildings.filter((b) => b !== "wall" && b !== "gate").map((b) => buildingHotkeyLabel(buildings, b));
      expect(new Set(labels).size, id).toBe(labels.length);
      expect(labels, id).not.toContain("");
      for (const b of buildings) if (b !== "wall" && b !== "gate") expect(buildingForKey(buildings, buildingHotkeyLabel(buildings, b)), id).toBe(b);
    }
  });
});

describe("placement reasons", () => {
  it("speaks player words, and capitalizes what it doesn't translate", () => {
    expect(placeReasonText("outside your network")).toBe("Build inside the ring");
    expect(placeReasonText("not enough $")).toBe("Not enough $");
  });
});
