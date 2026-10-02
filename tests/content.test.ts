import { describe, expect, it } from "vitest";
import {
  validateContent,
  type Content,
} from "../src/sim";
import { content } from "./fixtures";

describe("content", () => {
  it("rejects broken references", () => {
    const broken: Content = structuredClone(content);
    broken.waves.roster[0]!.unit = "missing";
    expect(() => validateContent(broken)).toThrow(/unknown unit missing/);
  });

  it("requires every race to have a 2x2 core", () => {
    const broken: Content = structuredClone(content);
    broken.races.botnet!.core = "server-rack";
    expect(() => validateContent(broken)).toThrow(/2x2 footprint/);
  });
});
