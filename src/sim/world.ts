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
//
// Each system lives in its own module; step() is the order they run in.

import { tickBuildingAttacks } from "./combat";
import { applyCommands } from "./commands";
import { buildGrid, makeContext, type TickContext } from "./context";
import type { Content } from "./content";
import { tickConstruction, tickCooldowns, tickIncome, tickUsers } from "./economy";
import { foundCore, spawnUnit } from "./entities";
import { footprintCenter } from "./map";
import { tickSpawners } from "./spawners";
import { generateTerrain } from "./terrain";
import { BASE_INCOME, STARTING_COMPUTE } from "./tuning";
import type { TeamId, World } from "./types";
import { tickUnits } from "./units";
import { tickResearch } from "./upgrades";
import { tickWaveDirector } from "./waves";

export interface MatchSetup {
  seed: number;
  races: [string, string];
  /** Skip the builder phase: found every core at its start tile. */
  startWithCore?: boolean;
}

export function createWorld(content: Content, setup: MatchSetup): World {
  const terrain = generateTerrain(setup.seed);
  const world: World = {
    tick: 0,
    seed: setup.seed,
    rngState: setup.seed | 0,
    terrain,
    nav: { goals: new Map() },
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
      const builder = spawnUnit(makeContext(world, content), team.id, race.builder, at, at.x, at.y, "builder");
      team.builderId = builder.id;
    } else {
      foundCore(world, content, team.id, col, row);
    }
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
    compute: STARTING_COMPUTE + race.modifiers.startingComputeBonus,
    incomeTimer: BASE_INCOME.intervalTicks,
    coreId: -1,
    builderId: -1,
    rally: null,
    users: 0,
    peakUsers: 0,
    revenueCarry: 0,
    churnCarry: 0,
    upgrades: {},
    research: null,
  };
}

export function step(world: World, content: Content): void {
  if (world.outcome) return;
  world.events = [];

  const ctx = makeContext(world, content);
  applyCommands(ctx);
  ctx.grid = buildGrid(world.entities);
  tickCooldowns(ctx);
  tickIncome(ctx);
  tickUsers(ctx);
  tickResearch(ctx);
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

function checkOutcome(ctx: TickContext): void {
  const { world } = ctx;
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
