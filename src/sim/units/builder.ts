// The deploy agent: walk to the order; on arrival at a founding site, become
// the core.

import { foundCore } from "../entities";
import { distance, walkTo } from "../movement";
import { canFound } from "../placement";
import { FOUND_REACH, MOVE_REACH } from "../tuning";
import type { Behavior } from "./index";

export const builder: Behavior = (ctx, unit, def) => {
  const { world, content } = ctx;
  const goal = unit.moveTo;
  if (!goal) return;
  if (distance(unit, goal) > (unit.foundAt ? FOUND_REACH : MOVE_REACH)) {
    walkTo(world, unit, goal, def.speed);
    return;
  }
  unit.moveTo = null;
  const site = unit.foundAt;
  unit.foundAt = null;
  if (!site) return;
  const reason = canFound(world, content, unit.team, site.col, site.row);
  if (reason) {
    world.events.push({ type: "rejected", command: { type: "found", tick: world.tick, team: unit.team, ...site }, reason });
    return;
  }
  const core = foundCore(world, content, unit.team, site.col, site.row);
  ctx.byId.set(core.id, core);
  // The agent deploys into the core.
  unit.hp = 0;
  world.teams[unit.team].builderId = -1;
  world.events.push({ type: "founded", x: core.x, y: core.y });
};
