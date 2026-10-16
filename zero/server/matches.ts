// Finished matches, as the game reports them: anonymous stats plus the
// command log that replays the match. Kept free of the Zero SDK so it can be
// tested anywhere. (The table lives in the space's WordPress, like invites.)

/** A log is a few KB; this is a long, busy match with room to spare. */
export const MAX_LOG = 400_000;
export const MAX_SUMMARY = 20_000;
const ID = /^[A-Za-z0-9-]{8,64}$/;
const SLUG = /^[a-z0-9-]{1,40}$/;
const OUTCOMES = ["won", "lost", "abandoned"] as const;

export interface MatchRow {
  player: string;
  version: string;
  seed: number;
  mode: string;
  race: string;
  hero: string;
  /** Every team's race in team order, comma-separated. */
  races: string;
  team: number;
  outcome: string;
  /** Game seconds the player's core was up. */
  survived: number;
  wave: number;
  tier: number;
  peakUsers: number;
  /** JSON: what was built and researched, and anything else worth counting. */
  summary: string;
  /** JSON: the command log (World.log). */
  log: string;
}

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isSlug = (v: unknown): v is string => typeof v === "string" && SLUG.test(v);

/** A report from the game, checked field by field. Returns the row, or what's wrong with it. */
export function parseMatch(body: unknown): MatchRow | string {
  if (!body || typeof body !== "object") return "bad_body";
  const b = body as Record<string, unknown>;
  if (typeof b.player !== "string" || !ID.test(b.player)) return "bad_player";
  if (typeof b.version !== "string" || !/^\d+\.\d+\.\d+$/.test(b.version)) return "bad_version";
  if (!isInt(b.seed, -(2 ** 31), 2 ** 32)) return "bad_seed";
  if (b.mode !== "coop" && b.mode !== "ffa" && b.mode !== "custom") return "bad_mode";
  if (!isSlug(b.race) || !(b.hero === "" || isSlug(b.hero))) return "bad_race";
  if (!Array.isArray(b.races) || b.races.length < 1 || b.races.length > 5 || !b.races.every(isSlug)) return "bad_races";
  if (!isInt(b.team, 0, 4)) return "bad_team";
  if (!OUTCOMES.includes(b.outcome as (typeof OUTCOMES)[number])) return "bad_outcome";
  if (!isNum(b.survived, 0, 24 * 3600) || !isInt(b.wave, 0, 10_000) || !isInt(b.tier, 0, 10) || !isInt(b.peakUsers, 0, 1e7)) return "bad_stats";
  const summary = JSON.stringify(b.summary ?? {});
  if (!b.summary || typeof b.summary !== "object" || summary.length > MAX_SUMMARY) return "bad_summary";
  if (!Array.isArray(b.log)) return "bad_log";
  const log = JSON.stringify(b.log);
  if (log.length > MAX_LOG) return "log_too_big";
  return {
    player: b.player,
    version: b.version,
    seed: b.seed,
    mode: b.mode,
    race: b.race,
    hero: b.hero as string,
    races: b.races.join(","),
    team: b.team,
    outcome: b.outcome as string,
    survived: Math.round(b.survived),
    wave: b.wave,
    tier: b.tier,
    peakUsers: b.peakUsers,
    summary,
    log,
  };
}
