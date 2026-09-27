// The simulation. Pure data in, pure data out, fixed tick, no rendering and
// no wall clock. Given the same content, seed, and command log it produces the
// same world on every machine. That property is what lets us add lockstep
// multiplayer (only commands cross the wire) and server-side replay
// verification later without a rewrite.
//
// Determinism rules:
// - Entities are iterated in ascending id order.
// - Randomness only comes from the seeded RNG stored in the world.
// - Only IEEE-exact math: + - * / Math.sqrt Math.round Math.floor. No trig,
//   no Math.hypot, no Math.random, no Date.

import type { Content } from "./content";
import { BUILD_RADIUS_TILES, TILE, footprintCenter } from "./map";
import { flowField, hasLineOfSight, isWalkablePoint, moveToward, nextStep } from "./nav";
import { randomInt } from "./rng";
import { TILE_OPEN, generateTerrain, tileAt, type Terrain } from "./terrain";
import type { Building, Command, Entity, TeamId, Unit, World } from "./types";

export const STARTING_COMPUTE = 200;
export const BASE_INCOME = { amount: 3, intervalTicks: 20 };
/** Construction starts at this fraction of max hp and fills as it builds. */
const CONSTRUCTION_START_HP = 0.25;
/** A unit drops a target that runs this far past its aggro range. */
const LEASH_MULTIPLIER = 1.5;
/** Guards never chase further than this from where they spawned. */
const GUARD_RADIUS = 220;
/** Guards within this distance of home count as home. */
const HOME_SLACK = 24;

export interface MatchSetup {
  seed: number;
  races: [string, string];
}

interface TickContext {
  world: World;
  content: Content;
  byId: Map<number, Entity>;
}

export function createWorld(content: Content, setup: MatchSetup): World {
  const terrain = generateTerrain(setup.seed);
  const world: World = {
    tick: 0,
    seed: setup.seed,
    rngState: setup.seed | 0,
    terrain,
    nav: { toCore: [new Int32Array(0), new Int32Array(0)] },
    nextId: 1,
    teams: [makeTeam(content, 0, setup.races[0]), makeTeam(content, 1, setup.races[1])],
    entities: [],
    commands: [],
    waves: {
      nextIndex: 0,
      nextWaveTick: content.waves.firstWaveTicks,
      pending: [],
    },
    outcome: null,
    events: [],
  };

  const origins = [terrain.start, terrain.nest] as const;
  for (const team of world.teams) {
    const { col, row } = origins[team.id];
    const core = placeBuilding(world, content, team.id, content.races[team.raceId]!.core, col, row, true);
    team.coreId = core.id;
    world.nav.toCore[team.id] = flowField(terrain, footprintTiles(terrain, core));
  }

  return world;
}

function makeTeam(content: Content, id: TeamId, raceId: string) {
  const race = content.races[raceId];
  if (!race) throw new Error(`Unknown race ${raceId}`);
  return {
    id,
    raceId,
    controller: race.controller,
    compute: STARTING_COMPUTE,
    incomeTimer: BASE_INCOME.intervalTicks,
    coreId: -1,
  };
}

function footprintTiles(terrain: Terrain, building: Building): number[] {
  const tiles: number[] = [];
  for (let row = building.row; row < building.row + building.footprint; row += 1) {
    for (let col = building.col; col < building.col + building.footprint; col += 1) {
      tiles.push(row * terrain.cols + col);
    }
  }
  return tiles;
}

/**
 * Schedule a command. Commands must target the current tick or later; in
 * lockstep play they are scheduled a few ticks ahead to absorb latency.
 */
export function queueCommand(world: World, command: Command): boolean {
  if (command.tick < world.tick) return false;
  world.commands.push(command);
  // Stable sort: by tick, then team, then arrival order.
  world.commands.sort((a, b) => a.tick - b.tick || a.team - b.team);
  return true;
}

export function step(world: World, content: Content): void {
  if (world.outcome) return;
  world.events = [];

  const ctx: TickContext = {
    world,
    content,
    byId: new Map(world.entities.map((entity) => [entity.id, entity])),
  };

  applyCommands(ctx);
  tickCooldowns(ctx);
  tickIncome(ctx);
  tickWaveDirector(ctx);
  tickSpawners(ctx);
  tickBuildingAttacks(ctx);
  tickUnits(ctx);
  // Last, so a building that finishes this tick starts working next tick.
  tickConstruction(ctx);
  checkOutcome(ctx);

  world.entities = world.entities.filter((entity) => entity.hp > 0);
  world.tick += 1;
}

// --- commands --------------------------------------------------------------

function applyCommands(ctx: TickContext): void {
  const { world, content } = ctx;
  while (world.commands.length > 0 && world.commands[0]!.tick <= world.tick) {
    const command = world.commands.shift()!;
    const reason = canPlace(world, content, command.team, command.building, command.col, command.row);
    if (reason) {
      world.events.push({ type: "rejected", command, reason });
      continue;
    }
    const team = world.teams[command.team];
    team.compute -= buildCost(content, team.raceId, command.building);
    const building = placeBuilding(world, content, team.id, command.building, command.col, command.row, false);
    ctx.byId.set(building.id, building);
  }
}

export function buildCost(content: Content, raceId: string, buildingId: string): number {
  return Math.round(content.buildings[buildingId]!.cost * content.races[raceId]!.modifiers.costMultiplier);
}

/**
 * Why a building can't go here, or null when it can. Shared by the sim and
 * the placement preview so they never disagree.
 */
export function canPlace(
  world: World,
  content: Content,
  teamId: TeamId,
  buildingId: string,
  col: number,
  row: number,
): string | null {
  const team = world.teams[teamId];
  const race = content.races[team.raceId]!;
  const def = content.buildings[buildingId];
  if (!def || !race.buildings.includes(buildingId)) return "not in this race's roster";

  for (let r = row; r < row + def.footprint; r += 1) {
    for (let c = col; c < col + def.footprint; c += 1) {
      if (tileAt(world.terrain, c, r) !== TILE_OPEN) return "terrain is not buildable";
    }
  }

  const core = world.entities.find((entity) => entity.id === team.coreId);
  if (!core) return "no core";
  const center = footprintCenter(col, row, def.footprint);
  const dx = center.x - core.x;
  const dy = center.y - core.y;
  const reach = BUILD_RADIUS_TILES * TILE;
  if (dx * dx + dy * dy > reach * reach) return "too far from your core";

  if (isOccupied(world, col, row, def.footprint)) return "tile occupied";
  if (team.compute < buildCost(content, team.raceId, buildingId)) return "not enough compute";
  return null;
}

export function isOccupied(world: World, col: number, row: number, footprint: number): boolean {
  return world.entities.some(
    (entity) =>
      entity.kind === "building" &&
      entity.hp > 0 &&
      col < entity.col + entity.footprint &&
      col + footprint > entity.col &&
      row < entity.row + entity.footprint &&
      row + footprint > entity.row,
  );
}

function placeBuilding(
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
    spawnTimer: 0,
    incomeTimer: def.income?.intervalTicks ?? 0,
  };
  building.spawnTimer = spawnInterval(content, world.teams[team]?.raceId, defId);
  world.entities.push(building);
  return building;
}

function spawnInterval(content: Content, raceId: string | undefined, defId: string): number {
  const spawn = content.buildings[defId]?.spawn;
  if (!spawn) return 0;
  const multiplier = raceId ? content.races[raceId]!.modifiers.spawnIntervalMultiplier : 1;
  return Math.max(1, Math.round(spawn.intervalTicks * multiplier));
}

// --- economy & construction -----------------------------------------------

function tickCooldowns(ctx: TickContext): void {
  for (const entity of ctx.world.entities) {
    if (entity.attackCooldown > 0) entity.attackCooldown -= 1;
  }
}

function tickIncome(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const team of world.teams) {
    team.incomeTimer -= 1;
    if (team.incomeTimer <= 0) {
      team.compute += BASE_INCOME.amount;
      team.incomeTimer = BASE_INCOME.intervalTicks;
    }
  }
  for (const entity of world.entities) {
    if (entity.kind !== "building" || entity.buildRemaining > 0) continue;
    const income = content.buildings[entity.defId]!.income;
    if (!income) continue;
    entity.incomeTimer -= 1;
    if (entity.incomeTimer <= 0) {
      world.teams[entity.team].compute += income.amount;
      entity.incomeTimer = income.intervalTicks;
    }
  }
}

function tickConstruction(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const entity of world.entities) {
    if (entity.kind !== "building" || entity.buildRemaining <= 0) continue;
    const def = content.buildings[entity.defId]!;
    entity.hp = Math.min(entity.maxHp, entity.hp + (entity.maxHp * (1 - CONSTRUCTION_START_HP)) / def.buildTicks);
    entity.buildRemaining -= 1;
  }
}

// --- spawning --------------------------------------------------------------

/** Nearest walkable spot to (x, y), searching outward in a fixed pattern. */
function walkableSpot(terrain: Terrain, x: number, y: number, fallbackX: number, fallbackY: number) {
  if (isWalkablePoint(terrain, x, y)) return { x, y };
  for (let ring = 1; ring <= 4; ring += 1) {
    const d = ring * (TILE / 2);
    const offsets = [
      [0, -d], [d, 0], [0, d], [-d, 0], [d, -d], [d, d], [-d, d], [-d, -d],
    ] as const;
    for (const [ox, oy] of offsets) {
      if (isWalkablePoint(terrain, x + ox, y + oy)) return { x: x + ox, y: y + oy };
    }
  }
  return { x: fallbackX, y: fallbackY };
}

function spawnUnit(ctx: TickContext, team: TeamId, unitId: string, from: Entity, x: number, y: number): Unit {
  const { world, content } = ctx;
  const def = content.units[unitId]!;
  const race = content.races[world.teams[team].raceId]!;
  const hp = Math.round(def.hp * race.modifiers.unitHpMultiplier);
  const spot = walkableSpot(world.terrain, x, y, from.x, from.y);
  const unit: Unit = {
    kind: "unit",
    id: world.nextId++,
    team,
    defId: unitId,
    x: spot.x,
    y: spot.y,
    homeX: spot.x,
    homeY: spot.y,
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

function tickSpawners(ctx: TickContext): void {
  const { world, content } = ctx;
  // Snapshot: units spawned this tick are appended and must not be iterated.
  const buildings = world.entities.filter(
    (entity): entity is Building => entity.kind === "building" && entity.hp > 0,
  );
  for (const building of buildings) {
    const spawn = content.buildings[building.defId]!.spawn;
    if (!spawn || building.buildRemaining > 0) continue;
    building.spawnTimer -= 1;
    if (building.spawnTimer > 0) continue;
    for (let i = 0; i < spawn.count; i += 1) {
      const x = building.x + randomInt(world, -20, 20);
      const y = building.y + building.radius + 10 + randomInt(world, 0, 8);
      spawnUnit(ctx, building.team, spawn.unit, building, x, y);
    }
    building.spawnTimer = spawnInterval(content, world.teams[building.team].raceId, building.defId);
  }
}

/**
 * The horde is not special: it is a team whose controller is the wave
 * director instead of a human. Its core is the nest the waves pour out of.
 */
function tickWaveDirector(ctx: TickContext): void {
  const { world, content } = ctx;
  const team = world.teams.find((t) => t.controller === "wave-director");
  if (!team) return;
  const waves = content.waves;
  const state = world.waves;

  const wave = waves.waves[state.nextIndex];
  if (wave && world.tick >= state.nextWaveTick) {
    let at = world.tick;
    for (const group of wave.groups) {
      for (let i = 0; i < group.count; i += 1) {
        state.pending.push({ tick: at, unit: group.unit });
        at += waves.spawnSpacingTicks;
      }
    }
    world.events.push({ type: "wave", index: state.nextIndex, name: wave.name });
    state.nextIndex += 1;
    const next = waves.waves[state.nextIndex];
    if (next) state.nextWaveTick = world.tick + next.delayTicks;
  }

  const nest = ctx.byId.get(team.coreId);
  if (!nest || nest.hp <= 0) return;
  while (state.pending.length > 0 && state.pending[0]!.tick <= world.tick) {
    const spawn = state.pending.shift()!;
    const x = nest.x + randomInt(world, -70, 70);
    const y = nest.y + randomInt(world, -70, 70);
    spawnUnit(ctx, team.id, spawn.unit, nest, x, y);
  }
}

// --- combat & movement -----------------------------------------------------

function edgeDistance(a: Entity, b: Entity): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy) - a.radius - b.radius;
}

function canSee(ctx: TickContext, from: Entity, to: Entity): boolean {
  return hasLineOfSight(ctx.world.terrain, from.x, from.y, to.x, to.y);
}

function nearestEnemy(
  ctx: TickContext,
  from: Entity,
  maxDistance: number,
  filter: (entity: Entity) => boolean = () => true,
): Entity | null {
  let best: Entity | null = null;
  let bestDistance = maxDistance;
  for (const entity of ctx.world.entities) {
    if (entity.team === from.team || entity.hp <= 0 || !filter(entity)) continue;
    const distance = edgeDistance(from, entity);
    // Strict < keeps the lowest id on ties: deterministic.
    if (distance < bestDistance || (best === null && distance <= maxDistance)) {
      if (from.kind === "unit" && !canSee(ctx, from, entity)) continue;
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
}

function dealDamage(
  ctx: TickContext,
  attacker: Entity,
  target: Entity,
  attackType: keyof Content["damage"],
  baseDamage: number,
): void {
  const { world, content } = ctx;
  const multiplier = content.damage[attackType][target.armorType];
  const damage = Math.max(1, Math.round(baseDamage * multiplier) - target.armor);
  const wasAlive = target.hp > 0;
  target.hp -= damage;
  world.events.push({
    type: "shot",
    from: attacker.id,
    to: target.id,
    x1: attacker.x,
    y1: attacker.y,
    x2: target.x,
    y2: target.y,
    team: attacker.team,
  });
  if (wasAlive && target.hp <= 0) {
    world.events.push({ type: "death", id: target.id, x: target.x, y: target.y, team: target.team });
    if (target.kind === "unit") {
      world.teams[attacker.team].compute += content.units[target.defId]!.bounty;
    }
  }
}

function tickBuildingAttacks(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const building of world.entities) {
    if (building.kind !== "building" || building.hp <= 0 || building.buildRemaining > 0) continue;
    const attack = content.buildings[building.defId]!.attack;
    if (!attack || building.attackCooldown > 0) continue;
    const target = nearestEnemy(ctx, building, attack.range, (entity) => entity.kind === "unit");
    if (!target) continue;
    dealDamage(ctx, building, target, attack.attackType, attack.damage);
    building.attackCooldown = attack.cooldownTicks;
  }
}

function distanceFromHome(unit: Unit): number {
  const dx = unit.x - unit.homeX;
  const dy = unit.y - unit.homeY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Two behaviors for now:
 * - Guards (human-controlled teams) hold near where they spawned and fight
 *   anything that comes within reach, then walk home.
 * - Raiders (the wave director) fight what they meet and otherwise follow the
 *   flow field to the nearest enemy core.
 */
function tickUnits(ctx: TickContext): void {
  const { world, content } = ctx;
  const { terrain } = world;
  for (const unit of world.entities) {
    if (unit.kind !== "unit" || unit.hp <= 0) continue;
    const def = content.units[unit.defId]!;
    const guard = world.teams[unit.team].controller === "human";
    const enemyTeam: TeamId = unit.team === 0 ? 1 : 0;

    let target = unit.targetId === null ? undefined : ctx.byId.get(unit.targetId);
    const keep =
      target !== undefined &&
      target.hp > 0 &&
      edgeDistance(unit, target) <= def.aggro * LEASH_MULTIPLIER &&
      (!guard || distanceFromHome(unit) <= GUARD_RADIUS) &&
      canSee(ctx, unit, target);
    if (!keep) target = nearestEnemy(ctx, unit, def.aggro) ?? undefined;
    if (guard && target && distanceFromHome(unit) > GUARD_RADIUS) target = undefined;
    unit.targetId = target?.id ?? null;

    if (target) {
      const distance = edgeDistance(unit, target);
      if (distance <= def.range) {
        if (unit.attackCooldown <= 0) {
          dealDamage(ctx, unit, target, def.attackType, def.damage);
          unit.attackCooldown = def.cooldownTicks;
        }
      } else {
        moveToward(terrain, unit, target.x, target.y, Math.min(def.speed, distance - def.range + 0.5));
      }
      continue;
    }

    if (guard) {
      if (distanceFromHome(unit) > HOME_SLACK) moveToward(terrain, unit, unit.homeX, unit.homeY, def.speed);
      continue;
    }

    // Raider with nothing in sight: attack the enemy core if it's in reach,
    // otherwise walk the flow field toward it.
    const core = ctx.byId.get(world.teams[enemyTeam].coreId);
    if (!core || core.hp <= 0) continue;
    const distance = edgeDistance(unit, core);
    if (distance <= def.range) {
      unit.targetId = core.id;
      if (unit.attackCooldown <= 0) {
        dealDamage(ctx, unit, core, def.attackType, def.damage);
        unit.attackCooldown = def.cooldownTicks;
      }
      continue;
    }
    const waypoint = canSee(ctx, unit, core) ? core : nextStep(terrain, world.nav.toCore[enemyTeam], unit.x, unit.y);
    if (waypoint) moveToward(terrain, unit, waypoint.x, waypoint.y, def.speed);
  }
}

// --- outcome ---------------------------------------------------------------

function checkOutcome(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const team of world.teams) {
    const core = ctx.byId.get(team.coreId);
    if (!core || core.hp <= 0) {
      world.outcome = { winner: team.id === 0 ? 1 : 0, reason: "core-destroyed", tick: world.tick };
      return;
    }
  }

  const horde = world.teams.find((team) => team.controller === "wave-director");
  if (!horde) return;
  const allWavesSent = world.waves.nextIndex >= content.waves.waves.length && world.waves.pending.length === 0;
  const hordeAlive = world.entities.some((e) => e.kind === "unit" && e.team === horde.id && e.hp > 0);
  if (allWavesSent && !hordeAlive) {
    world.outcome = { winner: horde.id === 0 ? 1 : 0, reason: "survived", tick: world.tick };
  }
}
