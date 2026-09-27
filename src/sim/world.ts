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
import { HEIGHT, SIDES, TILE, WIDTH, footprintCenter, inZone } from "./map";
import { randomInt } from "./rng";
import type { Building, Command, Entity, TeamId, Unit, World } from "./types";

export const STARTING_COMPUTE = 200;
export const BASE_INCOME = { amount: 3, intervalTicks: 20 };
/** Construction starts at this fraction of max hp and fills as it builds. */
const CONSTRUCTION_START_HP = 0.25;
/** A unit drops a target that runs this far past its aggro range. */
const LEASH_MULTIPLIER = 1.5;

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
  const world: World = {
    tick: 0,
    seed: setup.seed,
    rngState: setup.seed | 0,
    nextId: 1,
    teams: [
      makeTeam(content, 0, setup.races[0]),
      makeTeam(content, 1, setup.races[1]),
    ],
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

  for (const team of world.teams) {
    const { col, row } = SIDES[team.id].core;
    team.coreId = placeBuilding(world, content, team.id, "core", col, row, true).id;
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
  const { world } = ctx;
  while (world.commands.length > 0 && world.commands[0]!.tick <= world.tick) {
    const command = world.commands.shift()!;
    const reason = applyBuild(ctx, command);
    if (reason) world.events.push({ type: "rejected", command, reason });
  }
}

/** Returns a rejection reason, or null when the build was placed. */
function applyBuild(ctx: TickContext, command: Command): string | null {
  const { world, content } = ctx;
  const team = world.teams[command.team];
  const race = content.races[team.raceId]!;
  const def = content.buildings[command.building];

  if (!def || !race.buildings.includes(command.building)) return "not in this race's roster";
  if (!inZone(SIDES[team.id].buildZone, command.col, command.row, def.footprint)) {
    return "outside build zone";
  }
  if (isOccupied(world, command.col, command.row, def.footprint)) return "tile occupied";

  const cost = Math.round(def.cost * race.modifiers.costMultiplier);
  if (team.compute < cost) return "not enough compute";

  team.compute -= cost;
  const building = placeBuilding(world, content, team.id, command.building, command.col, command.row, false);
  ctx.byId.set(building.id, building);
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

function spawnUnit(ctx: TickContext, team: TeamId, unitId: string, x: number, y: number): Unit {
  const { world, content } = ctx;
  const def = content.units[unitId]!;
  const race = content.races[world.teams[team].raceId]!;
  const hp = Math.round(def.hp * race.modifiers.unitHpMultiplier);
  const unit: Unit = {
    kind: "unit",
    id: world.nextId++,
    team,
    defId: unitId,
    x,
    y: clamp(y, def.size, HEIGHT - def.size),
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
    const direction = SIDES[building.team].direction;
    for (let i = 0; i < spawn.count; i += 1) {
      const x = building.x + direction * (building.radius + 10);
      const y = building.y + randomInt(world, -14, 14);
      spawnUnit(ctx, building.team, spawn.unit, x, y);
    }
    building.spawnTimer = spawnInterval(content, world.teams[building.team].raceId, building.defId);
  }
}

/**
 * The horde is not special: it is a team whose controller is the wave
 * director instead of a human. Swap the controller and you have PvP.
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

  const core = ctx.byId.get(team.coreId);
  if (!core || core.hp <= 0) return;
  const direction = SIDES[team.id].direction;
  while (state.pending.length > 0 && state.pending[0]!.tick <= world.tick) {
    const spawn = state.pending.shift()!;
    spawnUnit(ctx, team.id, spawn.unit, core.x + direction * (core.radius + 12), core.y + randomInt(world, -140, 140));
  }
}

// --- combat & movement -----------------------------------------------------

function edgeDistance(a: Entity, b: Entity): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy) - a.radius - b.radius;
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

function tickUnits(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const unit of world.entities) {
    if (unit.kind !== "unit" || unit.hp <= 0) continue;
    const def = content.units[unit.defId]!;

    let target = unit.targetId === null ? undefined : ctx.byId.get(unit.targetId);
    if (!target || target.hp <= 0 || edgeDistance(unit, target) > def.aggro * LEASH_MULTIPLIER) {
      target = nearestEnemy(ctx, unit, def.aggro) ?? ctx.byId.get(world.teams[unit.team === 0 ? 1 : 0].coreId);
    }
    if (!target || target.hp <= 0) {
      unit.targetId = null;
      continue;
    }
    unit.targetId = target.id;

    const distance = edgeDistance(unit, target);
    if (distance <= def.range) {
      if (unit.attackCooldown <= 0) {
        dealDamage(ctx, unit, target, def.attackType, def.damage);
        unit.attackCooldown = def.cooldownTicks;
      }
      continue;
    }

    const dx = target.x - unit.x;
    const dy = target.y - unit.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const stride = Math.min(def.speed, distance - def.range + 0.5);
    unit.x = clamp(unit.x + (dx / length) * stride, unit.radius, WIDTH - unit.radius);
    unit.y = clamp(unit.y + (dy / length) * stride, unit.radius, HEIGHT - unit.radius);
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

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
