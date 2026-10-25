// The deploy agent: walk to the order; on arrival at a founding site, become
// the core. Mid-match it founds expansions instead: it builds the core there
// over its buildTicks and is spent (the match-start agent deploys into the
// core whole).

import { foundCore, placeBuilding } from "../entities";
import { spawnHero } from "../heroes";
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
  const team = world.teams[unit.team]!;
  const expansion = team.coreId !== -1;
  if (expansion) {
    // An expansion: it builds over its buildTicks and joins once finished.
    // The main core, the users and the waves stay as they are, and no hero
    // comes out: the agent is spent either way.
    const core = placeBuilding(world, content, unit.team, content.races[team.raceId]!.core, site.col, site.row, false);
    ctx.byId.set(core.id, core);
    unit.hp = 0;
    team.builderId = -1;
    world.events.push({ type: "expanded", team: unit.team, x: core.x, y: core.y });
    return;
  }
  const core = foundCore(world, content, unit.team, site.col, site.row);
  ctx.byId.set(core.id, core);
  // The agent deploys into the core.
  unit.hp = 0;
  team.builderId = -1;
  world.events.push({ type: "founded", x: core.x, y: core.y });
  spawnHero(ctx, team, core);
};
