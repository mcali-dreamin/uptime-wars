import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "es2022",
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Several tests simulate whole matches on the full-size map.
    testTimeout: 120_000,
  },
});
