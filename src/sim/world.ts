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
import { fortify } from "./fortress";
import { footprintCenter } from "./map";
import { teamCores } from "./placement";
import { hordeTeam, humanTeams, type MatchMode } from "./teams";
import { tickSpawners } from "./spawners";
import { MAX_PLAYERS, generateTerrain } from "./terrain";
import { BASE_INCOME, STARTING_MONEY } from "./tuning";
import type { TeamId, World } from "./types";
import { tickUnits } from "./units";
import { tickResearch } from "./upgrades";
import { spawnHero, tickHeroes } from "./heroes";
import { tickWaveDirector } from "./waves";

export interface MatchSetup {
  seed: number;
  /**
   * One race per team, in team order: the human players (1 to MAX_PLAYERS)
   * and then the horde, e.g. ["open-source", "hyperscaler", "botnet"].
   * Player n starts at terrain.starts[n].
   */
  races: string[];
  /** Hero unit per team (in team order); omitted or missing means the race's first. */
  heroes?: (string | undefined)[];
  /** Skip the builder phase: found every core at its start tile. */
  startWithCore?: boolean;
  /** co-op (default) or ffa. FFA needs two or more players; the horde is optional. */
  mode?: MatchMode;
}

export function createWorld(content: Content, setup: MatchSetup): World {
  const terrain = generateTerrain(setup.seed);
  const world: World = {
    mode: setup.mode ?? "coop",
    tick: 0,
    seed: setup.seed,
    rngState: setup.seed | 0,
    terrain,
    nav: { goals: new Map() },
    nextId: 1,
    teams: setup.races.map((race, id) => makeTeam(content, id, race, setup.heroes?.[id])),
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

  const humans = humanTeams(world);
  if (humans.length < 1 || humans.length > MAX_PLAYERS) throw new Error(`A match needs 1 to ${MAX_PLAYERS} players`);
  if (humans.some((team, i) => team.id !== i)) throw new Error("Human teams come first");
  if (world.mode === "ffa" && humans.length < 2) throw new Error("Free-for-all needs at least 2 players");
  if (world.mode === "coop" && !hordeTeam(world)) throw new Error("Co-op needs the horde");
  for (const team of world.teams) {
    const { col, row } = team.controller === "human" ? terrain.starts[team.id]! : terrain.nest;
    const race = content.races[team.raceId]!;
    if (race.builder && !setup.startWithCore) {
      const at = footprintCenter(col, row, 2);
      const builder = spawnUnit(makeContext(world, content), team.id, race.builder, at, at.x, at.y, "builder");
      team.builderId = builder.id;
    } else {
      const core = foundCore(world, content, team.id, col, row);
      spawnHero(makeContext(world, content), team, core);
    }
  }
  const horde = hordeTeam(world);
  if (horde) fortify(world, content, horde.id, 1);
  return world;
}

function makeTeam(content: Content, id: TeamId, raceId: string, heroId: string | undefined) {
  const race = content.races[raceId];
  if (!race) throw new Error(`Unknown race ${raceId}`);
  if (heroId !== undefined && !(race.heroes ?? []).includes(heroId)) throw new Error(`${raceId} has no hero ${heroId}`);
  return {
    id,
    raceId,
    controller: race.controller,
    money: STARTING_MONEY + race.modifiers.startingMoneyBonus,
    incomeTimer: BASE_INCOME.intervalTicks,
    coreId: -1,
    builderId: -1,
    rally: null,
    users: 0,
    overload: 0,
    peakUsers: 0,
    revenueCarry: 0,
    churnCarry: 0,
    upgrades: {},
    research: null,
    downTick: null,
    heroId: heroId ?? race.heroes?.[0] ?? null,
    hero: null,
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
  tickHeroes(ctx);
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

/**
 * Redundancy: when your primary core falls, the next one (lowest id) takes
 * over. A team goes offline when every core is down. Co-op: the match is lost
 * when every human team is offline, and won by all of them when the nest is.
 */
function checkOutcome(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const team of world.teams) {
    if (team.downTick !== null) continue;
    let alive: boolean;
    if (team.coreId === -1) {
      // Before founding, the team lives as long as its builder does.
      const builder = ctx.byId.get(team.builderId);
      alive = builder !== undefined && builder.hp > 0;
    } else {
      const primary = ctx.byId.get(team.coreId);
      if (!primary || primary.hp <= 0) {
        const next = teamCores(world, content, team)[0];
        if (next) {
          team.coreId = next.id;
          world.events.push({ type: "failover", team: team.id, x: next.x, y: next.y });
        }
      }
      const core = ctx.byId.get(team.coreId);
      alive = core !== undefined && core.hp > 0;
    }
    if (!alive) {
      team.downTick = world.tick;
      team.research = null;
      if (team.controller === "human") world.events.push({ type: "offline", team: team.id });
    }
  }
  const humans = humanTeams(world);
  const horde = hordeTeam(world);
  if (world.mode === "ffa") {
    // Last core standing. The nest falling just removes one enemy.
    const up = humans.filter((team) => team.downTick === null);
    if (up.length === 1) world.outcome = { winners: [up[0]!.id], reason: "last-standing", tick: world.tick };
    else if (up.length === 0) world.outcome = { winners: horde && horde.downTick === null ? [horde.id] : [], reason: "all-offline", tick: world.tick };
    return;
  }
  if (horde && horde.downTick !== null) {
    world.outcome = { winners: humans.map((team) => team.id), reason: "nest-offline", tick: world.tick };
  } else if (humans.every((team) => team.downTick !== null)) {
    world.outcome = { winners: horde ? [horde.id] : [], reason: "all-offline", tick: world.tick };
  }
  // No win by timer: the web never runs out of traffic. Your score is uptime.
}
