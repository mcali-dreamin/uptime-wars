// Infectors: the botnet's workers. Walk to the site, build an infected node
// there, and are used up doing it. They don't fight; their escort does.

import { footprintCenter } from "../map";
import { distance, walkTo } from "../movement";
import { buildNode, INFECT_REACH } from "../spread";
import type { Behavior } from "./index";

export const infector: Behavior = (ctx, unit, def) => {
  const site = unit.foundAt;
  if (!site) {
    unit.mode = "roam";
    return;
  }
  const at = footprintCenter(site.col, site.row, 2);
  if (distance(unit, at) > INFECT_REACH) {
    walkTo(ctx.world, unit, at, def.speed);
    return;
  }
  unit.foundAt = null;
  // Built: the infector becomes the node. Site taken meanwhile: it wanders off.
  if (buildNode(ctx, unit.team, site)) unit.hp = 0;
  else unit.mode = "roam";
};
