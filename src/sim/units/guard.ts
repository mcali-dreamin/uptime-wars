// Your units: fight what's near, otherwise go home (spawn spot, rally, or
// wherever you last ordered them). A plain move order walks there without
// stopping to fight; an attack-move (and plain guarding) fights on the way.

import { distance, walkTo } from "../movement";
import { HOME_SLACK } from "../tuning";
import type { Behavior } from "./index";
import { engage } from "./engage";

export const guard: Behavior = (ctx, unit, def) => {
  const home = { x: unit.homeX, y: unit.homeY };
  if (unit.order !== "move" && engage(ctx, unit, def)) return;
  if (distance(unit, home) > HOME_SLACK) {
    walkTo(ctx.world, unit, home, def.speed);
    return;
  }
  unit.order = null;
};
