import { defineConfig } from "vitest/config";

// Computer vs computer free-for-alls (see ffa.match.ts).
export default defineConfig({
  test: { include: ["balance/ffa.match.ts"], testTimeout: 6 * 60 * 60 * 1000, root: ".", silent: false },
});
