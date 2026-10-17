// The invite rules, kept free of the Zero SDK so they can be tested anywhere.

/** No 0/O, 1/I/L: codes get read aloud and typed. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;
/** An offer or answer is a deflated, base64url SDP: a couple of KB. */
export const MAX_BLOB = 12_000;
/** An invite nobody used is gone after this long. */
export const INVITE_TTL_MS = 30 * 60 * 1000;
export const KEY_LENGTH = 24;

const BLOB = /^[A-Za-z0-9_-]+$/;

export function makeCode(random: () => number, length = CODE_LENGTH): string {
  let code = "";
  for (let i = 0; i < length; i += 1) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return code;
}

export function validCode(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== CODE_LENGTH) return false;
  for (const c of value) if (!CODE_ALPHABET.includes(c)) return false;
  return true;
}

export function validBlob(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_BLOB && BLOB.test(value);
}

export function expired(createdAt: string, now: number): boolean {
  const at = Date.parse(createdAt);
  return !Number.isFinite(at) || now - at > INVITE_TTL_MS;
}

/** `/api/invites/K7QF2M` or `/api/invites/K7QF2M/answer` -> the code, if well-formed. */
export function codeFromPath(path: string): string | null {
  const parts = path.split("?")[0]!.split("/").filter(Boolean);
  const code = parts[2]?.toUpperCase();
  return parts[0] === "api" && parts[1] === "invites" && validCode(code) ? code : null;
}

// --- Quick Match ------------------------------------------------------------
// A host waiting for strangers lists its open invite here, under the game
// version (lockstep needs the exact same build). It heartbeats while it
// waits; a listing it stops refreshing is gone.

/** A listing not refreshed for this long is a closed tab. */
export const QUEUE_FRESH_MS = 12_000;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

export function validVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

export interface Listing {
  code: string;
  version: string;
  /** When this host started waiting (ms): the earliest host is the one people join. */
  since: number;
  /** Last heartbeat (ms). */
  seen: number;
}

export function fresh(listing: Listing, now: number): boolean {
  return now - listing.seen <= QUEUE_FRESH_MS;
}

/** Waited longer: earlier `since`, ties broken by code so both sides agree. */
export function waitedLonger(a: Listing, b: Listing): boolean {
  return a.since !== b.since ? a.since < b.since : a.code < b.code;
}

/**
 * The host to join: the one waiting longest on this version. With `than`,
 * only hosts that have waited longer than it (a waiting host checks whether
 * it should give way and join someone else instead, so two people searching
 * at the same moment end up in one match, not two empty ones).
 */
export function pickHost(listings: Listing[], version: string, now: number, than?: Listing): Listing | null {
  let best: Listing | null = null;
  for (const l of listings) {
    if (l.version !== version || !fresh(l, now) || l.code === than?.code) continue;
    if (than && !waitedLonger(l, than)) continue;
    if (!best || waitedLonger(l, best)) best = l;
  }
  return best;
}
