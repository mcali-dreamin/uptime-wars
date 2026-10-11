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
