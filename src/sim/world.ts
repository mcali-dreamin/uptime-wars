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
import { bodyFits, flowField, hasClearPath, hasLineOfSight, moveToward, nextStep } from "./nav";
import { randomInt } from "./rng";
import { TILE_BLOCKED, TILE_OPEN, generateTerrain, tileAt, type Terrain } from "./terrain";
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
/** Roamers amble rather than march. */
const ROAM_SPEED = 0.6;
/** A pack member further than this from its leader catches up first. */
const PACK_SPREAD = 90;
/** Buildings are big: a roamer spots one from this far, further than a unit. */
const BUILDING_SIGHT = 700;

export interface MatchSetup {
  seed: number;
  races: [string, string];
  /** Skip the builder phase: found every core at its start tile. */
  startWithCore?: boolean;
}

interface TickContext {
  world: World;
  content: Content;
  byId: Map<number, Entity>;
  /**
   * Living entities bucketed by GRID_CELL-sized cells, built once per tick
   * from start-of-tick positions in id order. Target searches only look at
   * nearby cells instead of every entity on the map.
   */
  grid: Map<number, Entity[]>;
}

const GRID_CELL = 256;
const GRID_STRIDE = 1 << 16;

function buildGrid(entities: Entity[]): Map<number, Entity[]> {
  const grid = new Map<number, Entity[]>();
  for (const entity of entities) {
    if (entity.hp <= 0) continue;
    const key = Math.floor(entity.y / GRID_CELL) * GRID_STRIDE + Math.floor(entity.x / GRID_CELL);
    const cell = grid.get(key);
    if (cell) cell.push(entity);
    else grid.set(key, [entity]);
  }
  return grid;
}

export function createWorld(content: Content, setup: MatchSetup): World {
  const terrain = generateTerrain(setup.seed);
  const world: World = {
    tick: 0,
    seed: setup.seed,
    rngState: setup.seed | 0,
    terrain,
    nav: {
      builderOrder: [null, null],
      toRoam: terrain.roamPoints.map(() => null),
    },
    nextId: 1,
    teams: [makeTeam(content, 0, setup.races[0]), makeTeam(content, 1, setup.races[1])],
    entities: [],
    commands: [],
    waves: {
      nextIndex: 0,
      nextWaveTick: content.waves.graceTicks,
      pending: [],
      nextPackId: 1,
      packs: {},
    },
    outcome: null,
    events: [],
  };

  const origins = [terrain.start, terrain.nest] as const;
  for (const team of world.teams) {
    const { col, row } = origins[team.id];
    const race = content.races[team.raceId]!;
    if (race.builder && !setup.startWithCore) {
      const at = footprintCenter(col, row, 2);
      const ctx: TickContext = { world, content, byId: new Map(), grid: new Map() };
      const builder = spawnUnit(ctx, team.id, race.builder, { x: at.x, y: at.y } as Entity, at.x, at.y, "builder");
      team.builderId = builder.id;
    } else {
      foundCore(world, content, team.id, col, row);
    }
  }

  return world;
}

/** Put a team's core on the map. Starts the wave clock if it was a player's. */
function foundCore(world: World, content: Content, teamId: TeamId, col: number, row: number): Building {
  const team = world.teams[teamId];
  const core = placeBuilding(world, content, teamId, content.races[team.raceId]!.core, col, row, true);
  team.coreId = core.id;
  if (team.controller === "human") {
    world.waves.nextWaveTick = Math.min(world.waves.nextWaveTick, world.tick + content.waves.firstWaveTicks);
  }
  return core;
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
    builderId: -1,
  };
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
    grid: new Map(),
  };

  applyCommands(ctx);
  ctx.grid = buildGrid(world.entities);
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
    const reason = applyCommand(ctx, command);
    if (reason) world.events.push({ type: "rejected", command, reason });
  }
}

/** Returns a rejection reason, or null when the command was applied. */
function applyCommand(ctx: TickContext, command: Command): string | null {
  const { world, content } = ctx;
  if (command.type === "build") {
    const reason = canPlace(world, content, command.team, command.building, command.col, command.row);
    if (reason) return reason;
    const team = world.teams[command.team];
    team.compute -= buildCost(content, team.raceId, command.building);
    const building = placeBuilding(world, content, team.id, command.building, command.col, command.row, false);
    ctx.byId.set(building.id, building);
    return null;
  }

  const builder = ctx.byId.get(world.teams[command.team].builderId);
  if (!builder || builder.kind !== "unit" || builder.hp <= 0) return "no builder";
  if (command.type === "found") {
    const reason = canFound(world, content, command.team, command.col, command.row);
    if (reason) return reason;
    const at = footprintCenter(command.col, command.row, 2);
    builder.moveTo = at;
    builder.foundAt = { col: command.col, row: command.row };
  } else {
    if (tileAt(world.terrain, Math.floor(command.x / TILE), Math.floor(command.y / TILE)) === TILE_BLOCKED) {
      return "can't walk there";
    }
    builder.moveTo = { x: command.x, y: command.y };
    builder.foundAt = null;
  }
  const { cols } = world.terrain;
  world.nav.builderOrder[command.team] = flowField(world.terrain, [
    Math.floor(builder.moveTo.y / TILE) * cols + Math.floor(builder.moveTo.x / TILE),
  ]);
  return null;
}

/** Why a core can't be founded on this 2x2 footprint, or null when it can. */
export function canFound(world: World, content: Content, teamId: TeamId, col: number, row: number): string | null {
  const team = world.teams[teamId];
  if (team.coreId !== -1) return "core already online";
  const def = content.buildings[content.races[team.raceId]!.core]!;
  for (let r = row; r < row + def.footprint; r += 1) {
    for (let c = col; c < col + def.footprint; c += 1) {
      if (tileAt(world.terrain, c, r) !== TILE_OPEN) return "terrain is not buildable";
    }
  }
  if (isOccupied(world, col, row, def.footprint)) return "tile occupied";
  return null;
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

/** Nearest spot where a body of radius r fits, searching outward in a fixed pattern. */
function walkableSpot(terrain: Terrain, x: number, y: number, r: number, fallbackX: number, fallbackY: number) {
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
  return { x: fallbackX, y: fallbackY };
}

function spawnUnit(
  ctx: TickContext,
  team: TeamId,
  unitId: string,
  from: Entity,
  x: number,
  y: number,
  mode: Unit["mode"],
  hpMultiplier = 1,
): Unit {
  const { world, content } = ctx;
  const def = content.units[unitId]!;
  const race = content.races[world.teams[team].raceId]!;
  const hp = Math.round(def.hp * race.modifiers.unitHpMultiplier * hpMultiplier);
  const spot = walkableSpot(world.terrain, x, y, def.size, from.x, from.y);
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

function tickSpawners(ctx: TickContext): void {
  const { world, content } = ctx;
  // Snapshot: units spawned this tick are appended and must not be iterated.
  const buildings = world.entities.filter(
    (entity): entity is Building => entity.kind === "building" && entity.hp > 0,
  );
  const alive = new Map<number, number>();
  for (const entity of world.entities) {
    if (entity.kind === "unit" && entity.hp > 0 && entity.spawnerId >= 0) {
      alive.set(entity.spawnerId, (alive.get(entity.spawnerId) ?? 0) + 1);
    }
  }
  for (const building of buildings) {
    const spawn = content.buildings[building.defId]!.spawn;
    if (!spawn || building.buildRemaining > 0) continue;
    building.spawnTimer -= 1;
    if (building.spawnTimer > 0) continue;
    const room = Math.min(spawn.count, spawn.maxAlive - (alive.get(building.id) ?? 0));
    for (let i = 0; i < room; i += 1) {
      const x = building.x + randomInt(world, -20, 20);
      const y = building.y + building.radius + 10 + randomInt(world, 0, 8);
      const unit = spawnUnit(ctx, building.team, spawn.unit, building, x, y, "guard");
      unit.spawnerId = building.id;
    }
    building.spawnTimer = spawnInterval(content, world.teams[building.team].raceId, building.defId);
  }
}

/**
 * The horde is not special: it is a team whose controller is the wave
 * director instead of a human. Waves never stop. Each is generated from a
 * growing budget, shuffled, cut into random-sized packs, and released from the
 * nest in the middle of the web. Nobody tells the packs where you are.
 */
function tickWaveDirector(ctx: TickContext): void {
  const { world, content } = ctx;
  const team = world.teams.find((t) => t.controller === "wave-director");
  if (!team) return;
  const waves = content.waves;
  const state = world.waves;
  const nest = ctx.byId.get(team.coreId);
  if (!nest) return;

  if (world.tick >= state.nextWaveTick) {
    const wave = state.nextIndex + 1;
    const plan = planWave(world, content, wave);
    let at = world.tick;
    let packs = 0;
    for (let i = 0; i < plan.units.length; ) {
      const size = randomInt(world, waves.packSize.min, waves.packSize.max);
      const packId = state.nextPackId++;
      packs += 1;
      for (const unit of plan.units.slice(i, i + size)) state.pending.push({ tick: at, unit, packId, wave });
      i += size;
      at += waves.spawnSpacingTicks;
    }
    world.events.push({ type: "wave", wave, name: plan.name, packs, units: plan.units.length, boss: plan.bosses > 0 });
    state.nextIndex = wave;
    state.nextWaveTick = world.tick + waveInterval(content, wave);
  }

  let alive = 0;
  for (const entity of world.entities) if (entity.kind === "unit" && entity.team === team.id) alive += 1;
  while (state.pending.length > 0 && state.pending[0]!.tick <= world.tick && alive < waves.maxAlive) {
    const spawn = state.pending.shift()!;
    const x = nest.x + randomInt(world, -60, 60);
    const y = nest.y + randomInt(world, -60, 60);
    const hp = 1 + waves.hpGrowthPerWave * (spawn.wave - 1);
    const unit = spawnUnit(ctx, team.id, spawn.unit, nest, x, y, "roam", hp);
    unit.packId = spawn.packId;
    alive += 1;
  }
}

/** Ticks between wave n and wave n + 1. */
export function waveInterval(content: Content, wave: number): number {
  const { startTicks, minTicks, shrinkPerWave } = content.waves.interval;
  return Math.max(minTicks, startTicks - shrinkPerWave * (wave - 1));
}

/**
 * What wave n contains. Bosses first, then the rest of the budget spent on
 * randomly chosen unlocked units, then shuffled so packs come out mixed.
 */
export function planWave(world: World, content: Content, wave: number) {
  const { budget, roster, bosses, names } = content.waves;
  let points = Math.round(budget.start * Math.pow(budget.growth, wave - 1));
  const units: string[] = [];

  const bossCount = wave >= bosses.fromWave && (wave - bosses.fromWave) % bosses.every === 0
    ? 1 + Math.floor((wave - bosses.fromWave) / (bosses.every * 3))
    : 0;
  for (let i = 0; i < bossCount; i += 1) units.push(bosses.unit);

  const unlocked = roster.filter((entry) => entry.fromWave <= wave);
  const totalWeight = unlocked.reduce((sum, entry) => sum + entry.weight, 0);
  const cheapest = Math.min(...unlocked.map((entry) => entry.cost));
  while (points >= cheapest) {
    let roll = randomInt(world, 1, totalWeight);
    let pick = unlocked[0]!;
    for (const entry of unlocked) {
      roll -= entry.weight;
      if (roll <= 0) {
        pick = entry;
        break;
      }
    }
    if (pick.cost > points) {
      // Can't afford this pick: spend what's left on the cheapest unit.
      pick = unlocked.find((entry) => entry.cost === cheapest)!;
    }
    units.push(pick.unit);
    points -= pick.cost;
  }

  for (let i = units.length - 1; i > 0; i -= 1) {
    const j = randomInt(world, 0, i);
    [units[i], units[j]] = [units[j]!, units[i]!];
  }
  const base = names[(wave - 1) % names.length]!;
  const cycle = Math.floor((wave - 1) / names.length);
  return { units, bosses: bossCount, name: cycle === 0 ? base : `${base} ${cycle + 1}` };
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

/** Largest entity radius, so the grid search never misses a big target's edge. */
const MAX_RADIUS = 48;

function nearestEnemy(
  ctx: TickContext,
  from: Entity,
  maxDistance: number,
  filter: (entity: Entity) => boolean = () => true,
  buildingDistance = maxDistance,
): Entity | null {
  const reach = Math.max(maxDistance, buildingDistance) + from.radius + MAX_RADIUS;
  const minCol = Math.floor((from.x - reach) / GRID_CELL);
  const maxCol = Math.floor((from.x + reach) / GRID_CELL);
  const minRow = Math.floor((from.y - reach) / GRID_CELL);
  const maxRow = Math.floor((from.y + reach) / GRID_CELL);

  let best: Entity | null = null;
  let bestDistance = Infinity;
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      const cell = ctx.grid.get(row * GRID_STRIDE + col);
      if (!cell) continue;
      for (const entity of cell) {
        if (entity.team === from.team || entity.hp <= 0 || !filter(entity)) continue;
        const limit = entity.kind === "building" ? buildingDistance : maxDistance;
        const distance = edgeDistance(from, entity);
        if (distance > limit) continue;
        // Closest wins; ties go to the lower id whatever order cells were visited in.
        const better =
          best === null || distance < bestDistance || (distance === bestDistance && entity.id < best.id);
        if (!better) continue;
        if (from.kind === "unit" && !canSee(ctx, from, entity)) continue;
        best = entity;
        bestDistance = distance;
      }
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
 * - Guards hold near where they spawned, fight anything within reach, then
 *   walk home.
 * - Roamers wander the map with their pack. They attack whatever they can
 *   see, chase it a little way, and otherwise keep wandering. There is no
 *   shared knowledge: every pack finds (or misses) you on its own.
 */
function tickUnits(ctx: TickContext): void {
  const { world, content } = ctx;
  const { terrain } = world;

  // Pack leader = lowest-id living member (entities are in id order).
  const leaders = new Map<number, Unit>();
  for (const entity of world.entities) {
    if (entity.kind === "unit" && entity.hp > 0 && entity.packId >= 0 && !leaders.has(entity.packId)) {
      leaders.set(entity.packId, entity);
    }
  }

  for (const unit of world.entities) {
    if (unit.kind !== "unit" || unit.hp <= 0) continue;
    const def = content.units[unit.defId]!;
    if (unit.mode === "builder") {
      tickBuilder(ctx, unit, def.speed);
      continue;
    }
    const guard = unit.mode === "guard";

    let target = unit.targetId === null ? undefined : ctx.byId.get(unit.targetId);
    const keep =
      target !== undefined &&
      target.hp > 0 &&
      edgeDistance(unit, target) <= (target.kind === "building" && !guard ? BUILDING_SIGHT : def.aggro) * LEASH_MULTIPLIER &&
      (!guard || distanceFromHome(unit) <= GUARD_RADIUS) &&
      canSee(ctx, unit, target);
    if (!keep) {
      target = nearestEnemy(ctx, unit, def.aggro, undefined, guard ? def.aggro : Math.max(def.aggro, BUILDING_SIGHT)) ?? undefined;
    }
    if (guard && target && distanceFromHome(unit) > GUARD_RADIUS) target = undefined;
    unit.targetId = target?.id ?? null;

    if (target) {
      const distance = edgeDistance(unit, target);
      if (distance <= def.range) {
        if (unit.attackCooldown <= 0) {
          dealDamage(ctx, unit, target, def.attackType, def.damage);
          unit.attackCooldown = def.cooldownTicks;
        }
        continue;
      }
      if (hasClearPath(terrain, unit.x, unit.y, target.x, target.y, unit.radius)) {
        moveToward(terrain, unit, target.x, target.y, Math.min(def.speed, distance - def.range + 0.5));
        continue;
      }
      // Seen but not straight-line reachable: keep wandering this tick.
    }

    if (guard) {
      if (distanceFromHome(unit) > HOME_SLACK) moveToward(terrain, unit, unit.homeX, unit.homeY, def.speed);
      continue;
    }

    roam(ctx, unit, leaders.get(unit.packId), def.speed * ROAM_SPEED);
  }
}

/**
 * Traffic flows outward from the middle of the web: a roam point's chance of
 * being picked grows with its distance from the nest. No knowledge of where
 * anyone lives, just which way the current runs.
 */
function pickRoamPoint(world: World): number {
  const { roamPoints, nest } = world.terrain;
  const weights = roamPoints.map((point) => {
    const dc = point.col - nest.col;
    const dr = point.row - nest.row;
    return 1 + Math.floor(Math.sqrt(dc * dc + dr * dr));
  });
  let roll = randomInt(world, 1, weights.reduce((sum, w) => sum + w, 0));
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i]!;
    if (roll <= 0) return i;
  }
  return weights.length - 1;
}

function roamField(world: World, index: number): Int32Array {
  let field = world.nav.toRoam[index];
  if (!field) {
    const point = world.terrain.roamPoints[index]!;
    field = flowField(world.terrain, [point.row * world.terrain.cols + point.col]);
    world.nav.toRoam[index] = field;
  }
  return field;
}

/** Follow the pack: straggle back to the leader, else walk the pack's route. */
function roam(ctx: TickContext, unit: Unit, leader: Unit | undefined, speed: number): void {
  const { world } = ctx;
  const { terrain } = world;
  const fields = world.nav.toRoam;
  if (fields.length === 0) return;

  if (leader && leader !== unit) {
    const dx = leader.x - unit.x;
    const dy = leader.y - unit.y;
    if (dx * dx + dy * dy > PACK_SPREAD * PACK_SPREAD && hasClearPath(terrain, unit.x, unit.y, leader.x, leader.y, unit.radius)) {
      moveToward(terrain, unit, leader.x, leader.y, speed * 1.3);
      return;
    }
  }

  let destination = world.waves.packs[unit.packId];
  let waypoint = destination === undefined ? null : nextStep(terrain, roamField(world, destination), unit.x, unit.y);
  if (!waypoint) {
    // Arrived, or new pack: wander somewhere else.
    destination = pickRoamPoint(world);
    world.waves.packs[unit.packId] = destination;
    waypoint = nextStep(terrain, roamField(world, destination), unit.x, unit.y);
  }
  if (waypoint) moveToward(terrain, unit, waypoint.x, waypoint.y, speed);
}

/** Walk to the order; on arrival at a founding site, become the core. */
function tickBuilder(ctx: TickContext, unit: Unit, speed: number): void {
  const { world, content } = ctx;
  const { terrain } = world;
  const goal = unit.moveTo;
  if (!goal) return;
  const dx = goal.x - unit.x;
  const dy = goal.y - unit.y;
  const arrived = dx * dx + dy * dy <= (unit.foundAt ? TILE * 1.5 : 6) ** 2;
  if (arrived) {
    unit.moveTo = null;
    world.nav.builderOrder[unit.team] = null;
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
    return;
  }
  const field = world.nav.builderOrder[unit.team];
  const waypoint = hasClearPath(terrain, unit.x, unit.y, goal.x, goal.y, unit.radius)
    ? goal
    : field
      ? nextStep(terrain, field, unit.x, unit.y)
      : null;
  if (waypoint) moveToward(terrain, unit, waypoint.x, waypoint.y, speed);
}

// --- outcome ---------------------------------------------------------------

function checkOutcome(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const team of world.teams) {
    const core = ctx.byId.get(team.coreId);
    const builder = ctx.byId.get(team.builderId);
    // Before founding, the team lives as long as its builder does.
    const alive = team.coreId === -1 ? builder !== undefined && builder.hp > 0 : core !== undefined && core.hp > 0;
    if (!alive) {
      world.outcome = { winner: team.id === 0 ? 1 : 0, reason: "core-destroyed", tick: world.tick };
      return;
    }
  }
  // No win by timer: the web never runs out of traffic. Your score is uptime.
}
