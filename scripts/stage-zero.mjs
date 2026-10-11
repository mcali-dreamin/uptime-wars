// After vite build: put the Zero server next to the static game in dist/,
// so publishing dist/ ships both. See zero/.
import { cp } from "node:fs/promises";

await cp("zero/sf.jsonc", "dist/sf.jsonc");
await cp("zero/package.json", "dist/package.json");
await cp("zero/server", "dist/server", { recursive: true });
