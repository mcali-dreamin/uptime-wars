// Your units: fight what's near, otherwise go home (spawn spot, rally, or
// wherever you last ordered them). A plain move order walks there without
// stopping to fight; an attack-move (and plain guarding) fights on the way.

import { distance, walkTo } from "../movement";
import { HOME_SLACK } from "../tuning";
import type { Behavior } from "./index";
import { engage } from "./engage";
import { sendHome } from "../entities";

export const guard: Behavior = (ctx, unit, def) => {
  const home = { x: unit.homeX, y: unit.homeY };
  if (unit.order !== "move" && engage(ctx, unit, def)) return;
  if (distance(unit, home) > HOME_SLACK) {
    walkTo(ctx.world, unit, home, def.speed);
    return;
  }
  // Arrived: on to the next queued order, if any.
  const next = unit.waypoints?.shift();
  if (next) {
    if (unit.waypoints!.length === 0) unit.waypoints = undefined;
    sendHome(ctx.world, unit, next, next.spread);
    unit.order = next.attack ? "attack" : "move";
    if (!next.attack) unit.targetId = null;
    return;
  }
  unit.order = null;
};
