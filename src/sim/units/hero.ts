// Your hero: does what you say. A move order walks it there (it won't stop to
// fight on the way; that's how you get it out of trouble). An attack order
// chases one enemy. A cast order walks it into range and casts. With no
// order it holds its ground and fights whatever comes near, like a guard.

import { dealDamage, edgeDistance, nearestEnemy } from "../combat";
import { buffMultiplier, castPoint, heroDamage, resolveCast } from "../heroes";
import { distance, walkTo } from "../movement";
import { hostile } from "../teams";
import { MOVE_REACH } from "../tuning";
import { multiplier } from "../upgrades";
import type { Behavior } from "./index";

export const hero: Behavior = (ctx, unit, def) => {
  const { world, content } = ctx;
  const team = world.teams[unit.team]!;
  const state = team.hero;
  if (!state) return;
  const damage = () => heroDamage(content, unit.defId, state.level) * multiplier(content, team, "unitDamage") * buffMultiplier(team, world.tick);

  // 1. A cast: walk into range, then cast.
  if (state.cast) {
    const cast = state.cast;
    const at = castPoint(ctx, cast, unit);
    const ability = content.heroes.abilities[cast.ability]!;
    if (!at) {
      state.cast = null;
    } else if (distance(unit, at) <= ability.range + (cast.targetId !== null ? unit.radius : 0) || ability.target === "self") {
      state.cast = null;
      resolveCast(ctx, team, unit, cast.ability, { x: at.x, y: at.y }, cast.targetId);
      return;
    } else {
      walkTo(world, unit, at, def.speed);
      return;
    }
  }

  // 2. A move order: walk, ignoring fights.
  if (unit.moveTo) {
    if (distance(unit, unit.moveTo) > MOVE_REACH) {
      walkTo(world, unit, unit.moveTo, def.speed);
      return;
    }
    unit.homeX = unit.moveTo.x;
    unit.homeY = unit.moveTo.y;
    unit.moveTo = null;
  }

  // 3. A focus target, else the nearest enemy that comes close.
  let target = state.focusId === null ? undefined : ctx.byId.get(state.focusId);
  if (!target || target.hp <= 0 || !hostile(world, target.team, unit.team)) {
    state.focusId = null;
    target = nearestEnemy(ctx, unit, def.aggro, (e) => e.kind === "unit" && e.mode !== "decoy") ?? undefined;
  }
  unit.targetId = target?.id ?? null;
  if (target) {
    if (edgeDistance(unit, target) <= def.range) {
      if (unit.attackCooldown <= 0) {
        dealDamage(ctx, unit, target, def.attackType, damage());
        unit.attackCooldown = def.cooldownTicks;
      }
    } else {
      walkTo(world, unit, target, def.speed);
    }
    return;
  }

  // 4. Nothing to do: stay where you were last sent.
  const home = { x: unit.homeX, y: unit.homeY };
  if (distance(unit, home) > MOVE_REACH * 4) walkTo(world, unit, home, def.speed);
};
