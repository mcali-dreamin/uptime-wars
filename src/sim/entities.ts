// Creating things: buildings, units, cores.

import type { TickContext } from "./context";
import type { Content } from "./content";
import { TILE, footprintCenter } from "./map";
import { bodyFits, nearestFit } from "./nav";
import { randomInt } from "./rng";
import type { Terrain } from "./terrain";
import { CONSTRUCTION_START_HP, RALLY_SPREAD } from "./tuning";
import type { Building, Point, Team, TeamId, Unit, World } from "./types";
import { multiplier } from "./upgrades";
import { raceModifiers, tierDef } from "./tiers";

/** A building's max hp: Building HP research toughens all of them, and a core grows with its team's tier. */
export function buildingMaxHp(world: World, content: Content, teamId: TeamId, defId: string): number {
  const team = world.teams[teamId];
  const base = content.buildings[defId]!.hp;
  if (!team) return base;
  const core = content.races[team.raceId]?.core === defId ? tierDef(content, team).coreHp : 1;
  return Math.round(base * core * multiplier(content, team, "buildingHp"));
}

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
    maxHp: buildingMaxHp(world, content, team, defId),
    hp: (instant ? 1 : CONSTRUCTION_START_HP) * buildingMaxHp(world, content, team, defId),
    armor: def.armor,
    radius: (def.footprint * TILE) / 2,
    attackCooldown: 0,
    targetId: null,
    buildRemaining: instant ? 0 : def.buildTicks,
    rally: null,
    spawnTimer: 0,
    incomeTimer: def.income?.intervalTicks ?? 0,
    lastHitTick: -1,
  };
  building.spawnTimer = spawnInterval(content, world.teams[team]!, defId);
  world.entities.push(building);
  return building;
}

export function spawnInterval(content: Content, team: Team | undefined, defId: string): number {
  const spawn = content.buildings[defId]?.spawn;
  if (!spawn) return 0;
  const race = team ? raceModifiers(content, team).spawnIntervalMultiplier : 1;
  return Math.max(1, Math.round((spawn.intervalTicks * race) / multiplier(content, team, "spawnSpeed")));
}

/** Nearest spot where a body of radius r fits, searching outward in a fixed pattern. */
/** (x, y), or the nearest spot a body fits (not inside a building); `fallback` if none. */
function walkableSpot(terrain: Terrain, x: number, y: number, r: number, fallback: Point): Point {
  return nearestFit(terrain, x, y, r) ?? { x: fallback.x, y: fallback.y };
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
  const modifiers = raceModifiers(content, world.teams[team]!);
  const upgraded = multiplier(content, world.teams[team]!, "unitHp");
  const hp = Math.round(def.hp * modifiers.unitHpMultiplier * hpMultiplier * upgraded);
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
    order: null,
    commanded: false,
    hp,
    maxHp: hp,
    armor: def.armor,
    radius: def.size,
    attackCooldown: 0,
    targetId: null,
  };
  world.entities.push(unit);
  ctx.byId.set(unit.id, unit);
  return unit;
}

/** Put a team's core on the map. Starts the horde's clocks if it was a player's. */
export function foundCore(world: World, content: Content, teamId: TeamId, col: number, row: number): Building {
  const team = world.teams[teamId]!;
  const core = placeBuilding(world, content, teamId, content.races[team.raceId]!.core, col, row, true);
  team.coreId = core.id;
  if (team.controller === "human") {
    team.users = content.economy.startingUsers;
    team.peakUsers = team.users;
    const { waves } = world;
    waves.nextTrickleTick = Math.min(waves.nextTrickleTick, world.tick + content.waves.firstWaveTicks);
    waves.nextWaveTick = Math.min(waves.nextWaveTick, world.tick + content.waves.firstIncidentTicks);
  }
  return core;
}

/** Give a guard a new home near `point`, spread out a little so they don't stack. */
export function sendHome(world: World, unit: Unit, point: Point, spread = RALLY_SPREAD): void {
  unit.homeAnchor =
    spread > 0 ? Math.floor(point.y / TILE) * world.terrain.cols + Math.floor(point.x / TILE) : undefined;
  unit.homeX = point.x + randomInt(world, -spread, spread);
  unit.homeY = point.y + randomInt(world, -spread, spread);
  if (!bodyFits(world.terrain, unit.homeX, unit.homeY, unit.radius)) {
    // Spread put it somewhere it can't stand: the point itself, or the
    // nearest spot to it that fits (a point on a building means beside it).
    const spot = nearestFit(world.terrain, point.x, point.y, unit.radius) ?? point;
    unit.homeX = spot.x;
    unit.homeY = spot.y;
  }
}
