import { describe, expect, it } from "vitest";
import { hotkeyLabel } from "../src/ui/build-bar";
import { placeReasonText } from "../src/game/selection";

describe("hotkey label", () => {
  it("maps the tenth button to key 0", () => {
    expect([0, 1, 8, 9].map(hotkeyLabel)).toEqual(["1", "2", "9", "0"]);
  });
});

describe("placement reasons", () => {
  it("speaks player words, and capitalizes what it doesn't translate", () => {
    expect(placeReasonText("outside your network")).toBe("Build inside the ring");
    expect(placeReasonText("not enough $")).toBe("Not enough $");
  });
});
