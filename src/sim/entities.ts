// Creating things: buildings, units, cores.

import type { TickContext } from "./context";
import type { Content } from "./content";
import { TILE, footprintCenter } from "./map";
import { bodyFits } from "./nav";
import { randomInt } from "./rng";
import type { Terrain } from "./terrain";
import { CONSTRUCTION_START_HP, RALLY_SPREAD } from "./tuning";
import type { Building, Point, Team, TeamId, Unit, World } from "./types";
import { multiplier } from "./upgrades";

export function placeBuilding(
  world: World,
  content: Content,
  team: TeamId,
  defId: string,
  col: number,
  row: number,
  instant: boolean,
): Building {
  const def = content.buildings[defId];
  if (!def) throw new Error(`Unknown building ${defId}`);
  const { x, y } = footprintCenter(col, row, def.footprint);
  const building: Building = {
    kind: "building",
    id: world.nextId++,
    team,
    defId,
    x,
    y,
    col,
    row,
    footprint: def.footprint,
    maxHp: def.hp,
    hp: instant ? def.hp : def.hp * CONSTRUCTION_START_HP,
    armor: def.armor,
    armorType: def.armorType,
    radius: (def.footprint * TILE) / 2,
    attackCooldown: 0,
    targetId: null,
    buildRemaining: instant ? 0 : def.buildTicks,
    rally: null,
    spawnTimer: 0,
    incomeTimer: def.income?.intervalTicks ?? 0,
  };
  building.spawnTimer = spawnInterval(content, world.teams[team], defId);
  world.entities.push(building);
  return building;
}

export function spawnInterval(content: Content, team: Team | undefined, defId: string): number {
  const spawn = content.buildings[defId]?.spawn;
  if (!spawn) return 0;
  const race = team ? content.races[team.raceId]!.modifiers.spawnIntervalMultiplier : 1;
  return Math.max(1, Math.round((spawn.intervalTicks * race) / multiplier(content, team, "spawnSpeed")));
}

/** Nearest spot where a body of radius r fits, searching outward in a fixed pattern. */
function walkableSpot(terrain: Terrain, x: number, y: number, r: number, fallback: Point): Point {
  if (bodyFits(terrain, x, y, r)) return { x, y };
  for (let ring = 1; ring <= 4; ring += 1) {
    const d = ring * (TILE / 2);
    const offsets = [
      [0, -d], [d, 0], [0, d], [-d, 0], [d, -d], [d, d], [-d, d], [-d, -d],
    ] as const;
    for (const [ox, oy] of offsets) {
      if (bodyFits(terrain, x + ox, y + oy, r)) return { x: x + ox, y: y + oy };
    }
  }
  return { x: fallback.x, y: fallback.y };
}

/** Spawn a unit near (x, y), nudged onto walkable ground; `from` is the fallback spot. */
export function spawnUnit(
  ctx: TickContext,
  team: TeamId,
  unitId: string,
  from: Point,
  x: number,
  y: number,
  mode: Unit["mode"],
  hpMultiplier = 1,
): Unit {
  const { world, content } = ctx;
  const def = content.units[unitId]!;
  const race = content.races[world.teams[team].raceId]!;
  const upgraded = multiplier(content, world.teams[team], "unitHp");
  const hp = Math.round(def.hp * race.modifiers.unitHpMultiplier * hpMultiplier * upgraded);
  const spot = walkableSpot(world.terrain, x, y, def.size, from);
  const unit: Unit = {
    kind: "unit",
    id: world.nextId++,
    team,
    defId: unitId,
    x: spot.x,
    y: spot.y,
    homeX: spot.x,
    homeY: spot.y,
    mode,
    packId: -1,
    spawnerId: -1,
    moveTo: null,
    foundAt: null,
    hp,
    maxHp: hp,
    armor: def.armor,
    armorType: def.armorType,
    radius: def.size,
    attackCooldown: 0,
    targetId: null,
  };
  world.entities.push(unit);
  ctx.byId.set(unit.id, unit);
  return unit;
}

/** Put a team's core on the map. Starts the wave clock if it was a player's. */
export function foundCore(world: World, content: Content, teamId: TeamId, col: number, row: number): Building {
  const team = world.teams[teamId];
  const core = placeBuilding(world, content, teamId, content.races[team.raceId]!.core, col, row, true);
  team.coreId = core.id;
  if (team.controller === "human") {
    team.users = content.economy.startingUsers;
    team.peakUsers = team.users;
    world.waves.nextWaveTick = Math.min(world.waves.nextWaveTick, world.tick + content.waves.firstWaveTicks);
  }
  return core;
}

/** Give a guard a new home near `point`, spread out a little so they don't stack. */
export function sendHome(world: World, unit: Unit, point: Point): void {
  unit.homeX = point.x + randomInt(world, -RALLY_SPREAD, RALLY_SPREAD);
  unit.homeY = point.y + randomInt(world, -RALLY_SPREAD, RALLY_SPREAD);
  if (!bodyFits(world.terrain, unit.homeX, unit.homeY, unit.radius)) {
    unit.homeX = point.x;
    unit.homeY = point.y;
  }
}
