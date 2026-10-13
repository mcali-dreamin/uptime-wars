// Match reports: when a match ends (or is abandoned), tell the game's server
// how it went, so the game can be balanced on real play. Anonymous: a random
// player id kept in this browser, nothing else about you. The report carries
// the seed, setup and command log, which replay the match exactly.
//
// Off with the toggle on the race picker. Never sent from a dev machine, and
// silently dropped wherever there's no server (a plain static host).

import { tierOf, type Content, type World } from "../sim";

const OPT_OUT_KEY = "uptime:telemetry";
const PLAYER_KEY = "uptime:player";
/** Matches shorter than this aren't worth a report (game seconds). */
const MIN_SECONDS = 20;
const ENDPOINT = "api/matches";

export interface MatchReport {
  player: string;
  version: string;
  seed: number;
  mode: World["mode"];
  race: string;
  hero: string;
  races: string[];
  team: number;
  outcome: "won" | "lost" | "abandoned";
  survived: number;
  wave: number;
  tier: number;
  peakUsers: number;
  summary: { built: Record<string, number>; researched: Record<string, number>; heroLevel: number; ticks: number; players: number };
  log: World["log"];
}

/** What a report says about a match, from the local player's side. Pure. */
export function buildReport(content: Content, world: World, team: number, player: string, version: string, ended: boolean): MatchReport {
  const t = world.teams[team]!;
  const built: Record<string, number> = {};
  for (const command of world.log) {
    if (command.team === team && command.type === "build") built[command.building] = (built[command.building] ?? 0) + 1;
  }
  const won = world.outcome?.winners.includes(team) ?? false;
  const upTo = t.downTick ?? world.outcome?.tick ?? world.tick;
  return {
    player,
    version,
    seed: world.seed,
    mode: world.mode,
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
      researched: { ...t.upgrades },
      heroLevel: t.hero?.level ?? 0,
      ticks: world.tick,
      players: world.teams.filter((x) => x.controller === "human").length,
    },
    log: world.log,
  };
}

export class Telemetry {
  private sent: World | null = null;

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

  /** Report a match once: when it ends, or when it's left unfinished (new match, page closed). */
  report(world: World, team: number, ended: boolean, beacon = false): void {
    if (this.sent === world || !this.enabled || !reportable()) return;
    if (world.tick < MIN_SECONDS * 20 || world.teams[team]?.coreId === -1) return;
    this.sent = world;
    const body = JSON.stringify(buildReport(this.content, world, team, playerId(), this.version, ended));
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
