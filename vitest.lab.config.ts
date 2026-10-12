import { defineConfig } from "vitest/config";

// Heavy simulation runs (see lab/). Not part of `npm test`.
export default defineConfig({
  test: { include: ["lab/**/*.test.ts"], testTimeout: 3_600_000 },
});
