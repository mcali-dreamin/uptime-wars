// A honeypot: it just sits there being attacked. Creeps lured onto it keep
// attacking it (see luredBy in heroes.ts) until it breaks or expires.

import type { Behavior } from "./index";

export const decoy: Behavior = () => {};
