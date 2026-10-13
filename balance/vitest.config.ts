import { defineConfig } from "vitest/config";

// Balance runs: long headless matches, one file per race so they run in parallel.
export default defineConfig({
  test: { include: ["balance/**/*.run.ts"], testTimeout: 6 * 60 * 60 * 1000, root: "." },
});
