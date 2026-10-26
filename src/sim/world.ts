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

import { tickRefits } from "./ranks";
import { tickBuildingAttacks } from "./combat";
import { applyCommands } from "./commands";
import { buildGrid, makeContext, type TickContext } from "./context";
import type { Content } from "./content";
import { tickConstruction, tickCooldowns, tickIncome, tickSpot, tickUsers } from "./economy";
import { foundCore, spawnUnit } from "./entities";
import { collapseHorde, fortify, raiseFarms } from "./fortress";
import { footprintCenter } from "./map";
import { teamCores } from "./placement";
import { allied, hordeTeam, humanTeams, rulesFor, startingAllies, type MatchMode, type MatchRules } from "./teams";
import { tickFunctions } from "./functions";
import { spawnCamps, tickNeutrals } from "./neutrals";
import { tickSites } from "./sites";
import { syncWalls } from "./walls";
import { tickSeparation } from "./separation";
import { tickRepair } from "./mechanics";
import { tickSpawners } from "./spawners";
import { MAX_PLAYERS, generateTerrain } from "./terrain";
import { BASE_INCOME, STARTING_MONEY } from "./tuning";
import type { TeamId, World } from "./types";
import { tickHealers, tickUnits } from "./units";
import { headPaid, tickResearch, waitingOf } from "./upgrades";
import { spawnHero, tickHeroes } from "./heroes";
import { tickWaveDirector } from "./waves";
import { tickTaunts } from "./traits";
import { tickAi } from "./ai";

export interface MatchSetup {
  seed: number;
  /**
   * One race per team, in team order: the human players (1 to MAX_PLAYERS)
   * and then the horde, e.g. ["open-source", "hyperscaler", "botnet"].
   * (The neutral team is added by createWorld, after all of these.)
   * Player n starts at terrain.starts[n].
   */
  races: string[];
  /** Hero unit per team (in team order); omitted or missing (null: sent as JSON) means the race's first. */
  heroes?: (string | null | undefined)[];
  /** Skip the builder phase: found every core at its start tile. */
  startWithCore?: boolean;
  /** A preset to start from: co-op (default) or ffa. `rules` overrides any part of it. */
  mode?: MatchMode;
  /** Who's on whose side, whether that can change, and what winning takes (teams.ts). */
  rules?: Partial<MatchRules>;
  /**
   * Per team (in team order): a difficulty id makes that player a computer
   * player; omitted, undefined or null (sent as JSON) is a person. Only
   * players can be computers.
   */
  ai?: (string | null | undefined)[];
}

export function createWorld(content: Content, setup: MatchSetup): World {
  const terrain = generateTerrain(setup.seed);
  const teams = setup.races.map((race, id) => makeTeam(content, id, race, setup.heroes?.[id] ?? undefined, setup.ai?.[id] ?? undefined));
  // The camp guards' team goes after every setup team, so no team id shifts.
  teams.push(makeTeam(content, teams.length, "neutral", undefined, undefined));
  const players = teams.filter((team) => team.controller === "human").length;
  const rules: MatchRules = { ...rulesFor(setup.mode ?? "coop", players), ...setup.rules };
  const world: World = {
    rules,
    allies: startingAllies(teams, rules),
    offers: teams.map(() => 0),
    tick: 0,
    seed: setup.seed,
    rngState: setup.seed | 0,
    terrain,
    nav: { goals: new Map() },
    nextId: 1,
    teams,
    entities: [],
    commands: [],
    waves: {
      nextIndex: 0,
      nextWaveTick: content.waves.graceTicks + content.waves.firstIncidentTicks - content.waves.firstWaveTicks,
      nextTrickleTick: content.waves.graceTicks,
      trickleSince: -1,
      pending: [],
      nextPackId: 1,
      packs: {},
    },
    outcome: null,
    events: [],
    log: [],
  };

  const humans = humanTeams(world);
  if (humans.length < 1 || humans.length > MAX_PLAYERS) throw new Error(`A match needs 1 to ${MAX_PLAYERS} players`);
  if (humans.some((team, i) => team.id !== i)) throw new Error("Human teams come first");
  if (rules.sides.length !== humans.length || rules.sides.some((side) => !Number.isInteger(side) || side < 0)) {
    throw new Error("Every player needs a side");
  }
  // Something has to be the enemy: the botnet, another side, or a friend you can turn on.
  if (!hordeTeam(world) && new Set(rules.sides).size < 2 && rules.diplomacy !== "open") {
    throw new Error("A match needs an enemy: the botnet or another side");
  }
  for (const team of world.teams) {
    if (team.ai && team.controller !== "human") throw new Error(`Team ${team.id} isn't a player, so it can't be a computer player`);
  }
  for (const team of world.teams) {
    if (team.controller === "neutral") continue;
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
  if (horde) {
    fortify(world, content, horde.id, 1);
    raiseFarms(world, content, horde.id);
  }
  spawnCamps(makeContext(world, content));
  return world;
}

function makeTeam(content: Content, id: TeamId, raceId: string, heroId: string | undefined, difficulty: string | undefined) {
  const race = content.races[raceId];
  if (!race) throw new Error(`Unknown race ${raceId}`);
  if (difficulty !== undefined && !content.difficulties[difficulty]) throw new Error(`Unknown difficulty ${difficulty}`);
  if (heroId !== undefined && !(race.heroes ?? []).includes(heroId)) throw new Error(`${raceId} has no hero ${heroId}`);
  return {
    id,
    raceId,
    controller: race.controller,
    money: STARTING_MONEY + race.modifiers.startingMoneyBonus,
    incomeTimer: BASE_INCOME.intervalTicks,
    coreId: -1,
    builderId: -1,
    users: 0,
    overload: 0,
    peakUsers: 0,
    revenueCarry: 0,
    churnCarry: 0,
    upgrades: {},
    research: null,
    labResearch: null,
    researchQueue: [],
    labResearchQueue: [],
    downTick: null,
    spot: null,
    spotRentals: 0,
    heroId: heroId ?? race.heroes?.[0] ?? null,
    hero: null,
    ai:
      difficulty === undefined
        ? null
        : { difficulty, next: 0, casts: 0, phase: "gather" as const, group: [], launched: 0, goal: null, goalId: -1, checked: [], known: [], until: 0, coreHp: 0, camp: -1, creepKind: "camp" as const, creepSince: 0 },
  };
}

export function step(world: World, content: Content): void {
  if (world.outcome) return;
  world.events = [];
  // Computer players decide on the world as the last tick left it, then act this tick like anyone.
  tickAi(world, content);

  const ctx = makeContext(world, content);
  applyCommands(ctx);
  // A wall placed this tick blocks from this tick.
  syncWalls(world, content);
  ctx.grid = buildGrid(world.entities);
  tickCooldowns(ctx);
  tickIncome(ctx);
  tickUsers(ctx);
  tickSpot(ctx);
  tickResearch(ctx);
  tickRefits(ctx);
  tickHeroes(ctx);
  tickWaveDirector(ctx);
  tickSpawners(ctx);
  tickFunctions(ctx);
  tickBuildingAttacks(ctx);
  tickNeutrals(ctx);
  tickSites(ctx);
  tickUnits(ctx);
  tickSeparation(ctx);
  // Last, so a building that finishes this tick starts working next tick.
  tickRepair(ctx);
  tickHealers(ctx);
  tickTaunts(ctx);
  tickConstruction(ctx);
  checkOutcome(ctx);

  world.entities = world.entities.filter((entity) => entity.hp > 0);
  // A wall that fell this tick opens up for the next.
  syncWalls(world, content);
  world.tick += 1;
}

/**
 * Redundancy: when your primary core falls, the next one (lowest id) takes
 * over. A team goes offline when every core is down. Then see if the match
 * is decided (decide).
 */
function checkOutcome(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const team of world.teams) {
    // Camp guards never play: no core, no builder, nothing to lose.
    if (team.downTick !== null || team.controller === "neutral") continue;
    // A mid-match deploy agent that died is gone for good: the $ it cost
    // isn't refunded. (Match start, an agent death is the whole team's end.)
    if (team.coreId !== -1 && team.builderId !== -1) {
      const agent = ctx.byId.get(team.builderId);
      if (!agent || agent.kind !== "unit" || agent.hp <= 0) {
        team.builderId = -1;
        world.events.push({ type: "agentLost", team: team.id, x: agent?.x ?? 0, y: agent?.y ?? 0 });
      }
    }
    let alive: boolean;
    if (team.coreId === -1) {
      // Before founding, the team lives as long as its builder does.
      const builder = ctx.byId.get(team.builderId);
      alive = builder !== undefined && builder.hp > 0;
    } else {
      const primary = ctx.byId.get(team.coreId);
      if (!primary || primary.hp <= 0) {
        // A finished core takes over before an expansion still under construction.
        const cores = teamCores(world, content, team);
        const next = cores.find((core) => core.buildRemaining === 0) ?? cores[0];
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
      // Out of the match: both queues are cancelled and refunded (the entry
      // running included), then dropped.
      for (const slot of ["research", "labResearch"] as const) {
        if (team[slot]) team.money += headPaid(content, team, team[slot]!);
        for (const entry of waitingOf(team, slot)) team.money += entry.paid;
        team[slot] = null;
        waitingOf(team, slot).length = 0;
      }
      if (team.controller === "human") world.events.push({ type: "offline", team: team.id });
      if (team.controller === "wave-director") collapseHorde(world, team.id);
    }
  }
  decide(world);
  // No win by timer: the web never runs out of traffic. Your score is uptime.
}

/**
 * The match is won when the players still up are all allied with each other
 * and nothing hostile to them that counts is left: every other player is
 * down, and so is the nest if the rules say it must fall. There has to have
 * been something to beat (a player or the nest), so one side alone against a
 * botnet that needn't fall plays on for uptime. Winners are that alliance,
 * including allies who went down along the way. It's lost when every player
 * is down; then the horde, if it's still up, wins.
 */
function decide(world: World): void {
  const players = humanTeams(world);
  const up = players.filter((team) => team.downTick === null);
  const horde = hordeTeam(world);
  if (up.length === 0) {
    world.outcome = { winners: horde && horde.downTick === null ? [horde.id] : [], reason: "all-offline", tick: world.tick };
    return;
  }
  const lead = up[0]!;
  if (up.some((team) => !allied(world, lead.id, team.id))) return;
  const nestCounts = horde !== undefined && world.rules.nestMustFall;
  if (nestCounts && horde.downTick === null) return;
  const beaten = players.some((team) => team.downTick !== null && !allied(world, lead.id, team.id));
  if (!beaten && !(nestCounts && horde.downTick !== null)) return;
  world.outcome = {
    winners: players.filter((team) => allied(world, lead.id, team.id)).map((team) => team.id),
    reason: nestCounts ? "nest-offline" : "last-standing",
    tick: world.tick,
  };
}
