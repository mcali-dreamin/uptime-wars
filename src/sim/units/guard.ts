// Your units: fight what's near, otherwise go home (spawn spot or rally).

import { distance, walkTo } from "../movement";
import { HOME_SLACK } from "../tuning";
import type { Behavior } from "./index";
import { engage } from "./engage";

export const guard: Behavior = (ctx, unit, def) => {
  if (engage(ctx, unit, def)) return;
  const home = { x: unit.homeX, y: unit.homeY };
  if (distance(unit, home) > HOME_SLACK) walkTo(ctx.world, unit, home, def.speed);
};
