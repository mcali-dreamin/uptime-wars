// Visits: the anonymous funnel of page opened, then match started. Kept free
// of the Zero SDK so it can be tested anywhere, like matches.ts.

const ID = /^[A-Za-z0-9-]{8,64}$/;
const HOST = /^[a-z0-9.-]*$/i;
const ENTRIES = ["direct", "join", "quick"] as const;

export interface VisitRow {
  player: string;
  /** Random per page load, from the player's browser. */
  visit: string;
  version: string;
  /** How they arrived: "direct", "join" (an invite link) or "quick". */
  entry: string;
  /** Hostname of the referring site, or "". */
  referrer: string;
  /** 1 once a match started in this visit. */
  started: number;
}

/** A visit ping from the game, checked field by field. Returns the row, or what's wrong with it. */
export function parseVisit(body: unknown): VisitRow | string {
  if (!body || typeof body !== "object") return "bad_body";
  const b = body as Record<string, unknown>;
  if (typeof b.player !== "string" || !ID.test(b.player)) return "bad_player";
  if (typeof b.visit !== "string" || !ID.test(b.visit)) return "bad_visit";
  if (typeof b.version !== "string" || !/^\d+\.\d+\.\d+$/.test(b.version)) return "bad_version";
  if (!ENTRIES.includes(b.entry as (typeof ENTRIES)[number])) return "bad_entry";
  if (typeof b.referrer !== "string" || b.referrer.length > 100 || !HOST.test(b.referrer)) return "bad_referrer";
  if (b.started !== 0 && b.started !== 1) return "bad_started";
  return { player: b.player, visit: b.visit, version: b.version, entry: b.entry as string, referrer: b.referrer, started: b.started };
}

/** A later ping of a stored visit: what to write, or null. `started` only goes up; other players' pings are ignored. */
export function mergeVisit(stored: VisitRow, incoming: VisitRow): Partial<VisitRow> | null {
  if (stored.player !== incoming.player) return null;
  return incoming.started > stored.started ? { started: 1 } : null;
}
