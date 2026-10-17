// Getting the two WebRTC blobs (offer, answer) between browsers.
//
// On Spacefast, the game's own space runs a tiny invite relay (see zero/):
// the host posts its offer and shares a six-letter code; the friend reads it
// and posts an answer; the host polls for it. Anywhere the relay isn't there
// (vite dev, a plain static host), co-op falls back to copy-and-paste: the
// offer rides in the invite link and the friend sends back a reply code.

const POLL_MS = 1000;
/** A code is short; a pasted-in offer is kilobytes. */
const CODE = /^[A-Z0-9]{6}$/;

export interface HostedInvite {
  /** What the friend needs: a short code, or the whole offer in manual mode. */
  token: string;
  /** The secret that proves this host owns the invite (relay only). */
  key: string;
  /** Resolves with the friend's answer once they post it. Manual mode: never; paste it. */
  answer: Promise<string>;
  cancel(): void;
}

/** Host: publish an offer. Null if this host has no relay (use the manual flow). */
export async function publishOffer(offer: string): Promise<HostedInvite | null> {
  let created: { code: string; key: string };
  try {
    const response = await fetch("api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer }),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("json")) return null;
    created = (await response.json()) as { code: string; key: string };
    if (!CODE.test(created.code)) return null;
  } catch {
    return null;
  }
  let stopped = false;
  const answer = new Promise<string>((resolve, reject) => {
    const poll = async () => {
      if (stopped) return;
      try {
        const response = await fetch(`api/invites/${created.code}/answer?key=${encodeURIComponent(created.key)}`);
        if (response.status === 404) return reject(new Error("The invite expired."));
        const body = (await response.json()) as { answer: string | null };
        if (body.answer) return resolve(body.answer);
      } catch {
        // A blip; keep polling.
      }
      setTimeout(poll, POLL_MS);
    };
    void poll();
  });
  return { token: created.code, key: created.key, answer, cancel: () => (stopped = true) };
}

/** Guest: is this invite token a relay code (rather than a whole offer)? */
export function isCode(token: string): boolean {
  return CODE.test(token);
}

/** Guest: the offer behind a code. */
export async function fetchOffer(code: string): Promise<string> {
  const response = await fetch(`api/invites/${code}`);
  if (response.status === 404) throw new Error("This invite expired or doesn't exist. Ask for a new one.");
  if (!response.ok) throw new Error("Couldn't reach the invite server.");
  const body = (await response.json()) as { offer: string; taken: boolean };
  if (body.taken) throw new Error("Someone already used this invite. Ask for a new one.");
  return body.offer;
}

/** Guest: send our answer back through the relay. */
export async function postAnswer(code: string, answer: string): Promise<void> {
  const response = await fetch(`api/invites/${code}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer }),
  });
  if (response.status === 409) throw new Error("Someone already used this invite. Ask for a new one.");
  if (!response.ok) throw new Error("Couldn't reach the invite server.");
}

// --- Quick Match ------------------------------------------------------------

async function post<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok || !response.headers.get("content-type")?.includes("json")) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Looking for a match: the code of a host waiting on this version, or null. */
export async function findMatch(version: string): Promise<string | null> {
  const found = await post<{ code: string | null }>("api/queue/find", { version });
  return found?.code && CODE.test(found.code) ? found.code : null;
}

/**
 * Host: list an open invite for Quick Match, or refresh the listing. Resolves
 * with an older host's code if one should be joined instead; false if the
 * relay refused (no relay here, or the invite is gone).
 */
export async function listInvite(invite: HostedInvite, version: string): Promise<string | null | false> {
  const listed = await post<{ ok: boolean; join: string | null }>("api/queue", { code: invite.token, key: invite.key, version });
  if (!listed) return false;
  return listed.join && CODE.test(listed.join) ? listed.join : null;
}

/** Host: take the listing down. */
export async function unlistInvite(invite: HostedInvite): Promise<void> {
  await post("api/queue/leave", { code: invite.token, key: invite.key });
}
