// Match reports: when a match ends (or is abandoned), tell the game's server
// how it went, so the game can be balanced on real play. Anonymous: a random
// player id kept in this browser, nothing else about you. The report carries
// the seed, setup and command log, which replay the match exactly.
//
// Off with the toggle on the race picker. Never sent from a dev machine, and
// silently dropped wherever there's no server (a plain static host).

import { rulesLabel, tierOf, type Content, type MatchRules, type World } from "../sim";

const OPT_OUT_KEY = "uptime:telemetry";
const PLAYER_KEY = "uptime:player";
/** Matches shorter than this aren't worth a report (game seconds). */
const MIN_SECONDS = 20;
const ENDPOINT = "api/matches";
/** This long (game seconds) with no input at all counts as looking away. */
export const IDLE_SECONDS = 60;

/**
 * How present the player was: are people still playing in minute 30, or did
 * they look away and get overrun? Bucketed per game minute.
 */
export interface Engagement {
  /** Commands the sim took from this player, per game minute: decisions. */
  commandsPerMinute: number[];
  /** Seconds with any mouse or key input, per game minute (0-60): presence. */
  activeSecondsPerMinute: number[];
  /** Game second of the last input, or -1 with none. */
  lastInput: number;
  /** Longest stretch without input, in game seconds (the tail counts too). */
  longestIdle: number;
  /** Stretches of IDLE_SECONDS or more without input. */
  idleSpells: number;
  /** Seconds from the last input to the end of the report. */
  idleAtEnd: number;
}

/**
 * Engagement from the command log and the game seconds that saw input
 * (ascending). Pure. Without input seconds (an old report), the commands
 * stand in for them.
 */
export function engagement(world: World, team: number, inputSeconds?: readonly number[]): Engagement {
  const end = Math.floor(world.tick / 20);
  const minutes = Math.floor(end / 60) + 1;
  const commandsPerMinute = new Array<number>(minutes).fill(0);
  const commandSeconds: number[] = [];
  for (const command of world.log) {
    if (command.team !== team) continue;
    const second = Math.floor(command.tick / 20);
    commandsPerMinute[Math.min(minutes - 1, Math.floor(second / 60))]! += 1;
    if (commandSeconds.at(-1) !== second) commandSeconds.push(second);
  }
  const seconds = (inputSeconds ?? commandSeconds).filter((second) => second >= 0 && second <= end);
  const activeSecondsPerMinute = new Array<number>(minutes).fill(0);
  for (const second of seconds) activeSecondsPerMinute[Math.min(minutes - 1, Math.floor(second / 60))]! += 1;
  let longestIdle = 0;
  let idleSpells = 0;
  let previous = 0;
  for (const second of [...seconds, end]) {
    const gap = second - previous;
    longestIdle = Math.max(longestIdle, gap);
    if (gap >= IDLE_SECONDS) idleSpells += 1;
    previous = second;
  }
  const lastInput = seconds.at(-1) ?? -1;
  return { commandsPerMinute, activeSecondsPerMinute, lastInput, longestIdle, idleSpells, idleAtEnd: end - Math.max(0, lastInput) };
}

export interface MatchReport {
  player: string;
  version: string;
  seed: number;
  /** The preset the rules match, or "custom" (then summary.rules has them). */
  mode: "coop" | "ffa" | "custom";
  race: string;
  hero: string;
  races: string[];
  team: number;
  outcome: "won" | "lost" | "abandoned";
  survived: number;
  wave: number;
  tier: number;
  peakUsers: number;
  summary: {
    built: Record<string, number>;
    ranked: number;
    researched: Record<string, number>;
    heroLevel: number;
    ticks: number;
    players: number;
    /** The rules, when they aren't a preset. Replays need them. */
    rules?: MatchRules;
    /** Computer players' difficulty per team (null = a person or the horde), when there are any. Replays need it. */
    ai?: (string | null)[];
    engagement: Engagement;
  };
  log: World["log"];
}

/** What a report says about a match, from the local player's side. Pure. */
export function buildReport(content: Content, world: World, team: number, player: string, version: string, ended: boolean, inputSeconds?: readonly number[]): MatchReport {
  const t = world.teams[team]!;
  const built: Record<string, number> = {};
  let ranked = 0;
  for (const command of world.log) {
    if (command.team === team && command.type === "build") built[command.building] = (built[command.building] ?? 0) + 1;
    if (command.team === team && command.type === "rank") ranked += 1;
  }
  const won = world.outcome?.winners.includes(team) ?? false;
  const upTo = t.downTick ?? world.outcome?.tick ?? world.tick;
  return {
    player,
    version,
    seed: world.seed,
    mode: rulesLabel(world),
    race: t.raceId,
    hero: t.heroId ?? "",
    races: world.teams.map((x) => x.raceId),
    team,
    outcome: !ended ? "abandoned" : won ? "won" : "lost",
    survived: upTo / 20,
    wave: world.waves.nextIndex,
    tier: tierOf(content, t),
    peakUsers: t.peakUsers,
    summary: {
      built,
      ranked,
      researched: { ...t.upgrades },
      heroLevel: t.hero?.level ?? 0,
      ticks: world.tick,
      engagement: engagement(world, team, inputSeconds),
      players: world.teams.filter((x) => x.controller === "human" && !x.ai).length,
      ...(rulesLabel(world) === "custom" ? { rules: world.rules } : {}),
      ...(world.teams.some((x) => x.ai) ? { ai: world.teams.map((x) => x.ai?.difficulty ?? null) } : {}),
    },
    log: world.log,
  };
}

export class Telemetry {
  private sent: World | null = null;
  /** The match the input seconds below belong to. */
  private watched: World | null = null;
  /** Game seconds that saw any input, ascending. */
  private inputSeconds: number[] = [];

  constructor(
    private readonly content: Content,
    private readonly version: string,
  ) {}

  get enabled(): boolean {
    return localStorage.getItem(OPT_OUT_KEY) !== "off";
  }

  set enabled(on: boolean) {
    localStorage.setItem(OPT_OUT_KEY, on ? "on" : "off");
  }

  /** The player touched the mouse or keyboard during this match. Cheap: called on every input event. */
  noteInput(world: World): void {
    if (this.watched !== world) {
      this.watched = world;
      this.inputSeconds = [];
    }
    const second = Math.floor(world.tick / 20);
    if (this.inputSeconds.at(-1) !== second) this.inputSeconds.push(second);
  }

  /** Report a match once: when it ends, or when it's left unfinished (new match, page closed). */
  report(world: World, team: number, ended: boolean, beacon = false): void {
    if (this.sent === world || !this.enabled || !reportable()) return;
    if (world.tick < MIN_SECONDS * 20 || world.teams[team]?.coreId === -1) return;
    this.sent = world;
    const body = JSON.stringify(buildReport(this.content, world, team, playerId(), this.version, ended, this.watched === world ? this.inputSeconds : []));
    try {
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
        return;
      }
      void fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
    } catch {
      // No server here; that's fine.
    }
  }
}

/** Real players only: not a dev server, not the test harness. */
function reportable(): boolean {
  const host = location.hostname;
  return host !== "localhost" && host !== "127.0.0.1" && host !== "" && !new URLSearchParams(location.search).has("debug");
}

function playerId(): string {
  let id = localStorage.getItem(PLAYER_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_KEY, id);
  }
  return id;
}
