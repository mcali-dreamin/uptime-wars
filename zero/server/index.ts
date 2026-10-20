// The game's server: a tiny signaling relay so co-op invites are short links,
// and the place finished matches are reported to (anonymous stats + replay).
//
// A host posts a WebRTC offer and gets a code (and a secret key). A friend
// opening `#join=CODE` reads the offer and posts back an answer. The host
// polls for the answer with its key. After that the browsers talk directly;
// nothing about the match ever touches this server.
//
// Quick Match is the same thing in public: a host with nobody to invite lists
// its open invite under the game version, and a stranger looking for a match
// is handed the code of whoever has waited longest. From there it's an
// ordinary invite.
//
// Everything else in this space is the static game build.

import { capsule, endpoint, json, number, string, table } from "@spacefast/zero/server";
import { mergeMatch, parseMatch, type MatchRow } from "./matches";
import { KEY_LENGTH, codeFromPath, expired, fresh, makeCode, pickHost, validBlob, validCode, validVersion, type Listing } from "./rules";

const notFound = () => json({ error: "not_found" }, { status: 404 });
const bad = (error: string) => json({ error }, { status: 400 });
const random = () => Math.random();

export default capsule({
  name: "uptime-wars",
  schema: {
    invites: table({
      code: string(),
      key: string(),
      offer: string(),
      answer: string().default(""),
    }).index("by_code", ["code"]),
    // Quick Match: open invites from hosts waiting for strangers (see rules.ts).
    queue: table({
      code: string(),
      version: string(),
      since: number(),
      seen: number(),
    })
      .index("by_code", ["code"])
      .index("by_version", ["version"]),
    // One row per finished (or abandoned) match, as each player's browser reports it.
    matches: table({
      player: string(),
      match: string().default(""),
      version: string(),
      seed: number(),
      mode: string(),
      race: string(),
      hero: string(),
      races: string(),
      team: number(),
      outcome: string(),
      survived: number(),
      wave: number(),
      tier: number(),
      peakUsers: number(),
      summary: string(),
      log: string(),
    })
      .index("by_match", ["match"])
      .index("by_race", ["race"])
      .index("by_version", ["version"]),
  },
  endpoints: {
    // Host: publish an offer, get a code and the key to read the answer with.
    createInvite: endpoint({ method: "POST", path: "/api/invites" }, async (ctx, req) => {
      const body = await req.json<{ offer?: unknown }>().catch(() => ({}) as { offer?: unknown });
      if (!validBlob(body.offer)) return bad("bad_offer");
      // Sweep a few expired invites on the way in, so the table stays small.
      const now = Date.now();
      for (const old of await ctx.db.invites!.withIndex("by_creation").order("asc").take(20)) {
        if (expired(old.createdAt, now)) await ctx.db.invites!.delete(old.id);
      }
      let code = makeCode(random);
      for (let tries = 0; tries < 5 && (await find(ctx, code)); tries += 1) code = makeCode(random);
      const key = makeCode(random, KEY_LENGTH) + makeCode(random, KEY_LENGTH);
      await ctx.db.invites!.insert({ code, key, offer: body.offer, answer: "" });
      return json({ code, key });
    }),

    // The game: a match ended, or a long one checked in. Anonymous;
    // write-only from the outside. Reports with the same match id update one row.
    reportMatch: endpoint({ method: "POST", path: "/api/matches" }, async (ctx, req) => {
      const body = await req.json<unknown>().catch(() => null);
      const row = parseMatch(body);
      if (typeof row === "string") return bad(row);
      const stored = row.match ? ((await ctx.db.matches!.withIndex("by_match", (r: Ctx) => r.eq("match", row.match)).first()) as (MatchRow & { id: string }) | null) : null;
      if (!stored) await ctx.db.matches!.insert(row);
      else {
        const patch = mergeMatch(stored, row);
        if (patch) await ctx.db.matches!.update(stored.id, patch);
      }
      return json({ ok: true });
    }),

    // Host: list (or keep listing) an open invite for Quick Match. Called
    // every few seconds while waiting. Answers with an older host to join
    // instead, if there is one, so two searchers don't both sit and wait.
    listInvite: endpoint({ method: "POST", path: "/api/queue" }, async (ctx, req) => {
      const body = await req.json<{ code?: unknown; key?: unknown; version?: unknown }>().catch(() => ({}) as Record<string, unknown>);
      if (!validCode(body.code) || !validVersion(body.version)) return bad("bad_listing");
      const invite = await live(ctx, body.code);
      if (!invite || body.key !== invite.key) return notFound();
      const now = Date.now();
      const row = (await ctx.db.queue!.withIndex("by_code", (r: Ctx) => r.eq("code", body.code)).first()) as (Listing & { id: string }) | null;
      if (invite.answer !== "") {
        if (row) await ctx.db.queue!.delete(row.id);
        return json({ ok: true, join: null });
      }
      const mine: Listing = row ? { ...row, seen: now } : { code: body.code, version: body.version, since: now, seen: now };
      if (row) await ctx.db.queue!.update(row.id, { seen: now });
      else await ctx.db.queue!.insert(mine);
      const older = pickHost(await waiting(ctx, body.version, now), body.version, now, mine);
      return json({ ok: true, join: older?.code ?? null });
    }),

    // Host: stop listing (the match started, or they gave up).
    unlistInvite: endpoint({ method: "POST", path: "/api/queue/leave" }, async (ctx, req) => {
      const body = await req.json<{ code?: unknown; key?: unknown }>().catch(() => ({}) as Record<string, unknown>);
      const invite = validCode(body.code) ? await find(ctx, body.code) : null;
      if (!invite || body.key !== invite.key) return notFound();
      const row = await ctx.db.queue!.withIndex("by_code", (r: Ctx) => r.eq("code", body.code)).first();
      if (row) await ctx.db.queue!.delete(row.id);
      return json({ ok: true });
    }),

    // Looking for a match: the code of the host waiting longest on this
    // version, or null (then become a host and list yourself).
    findMatch: endpoint({ method: "POST", path: "/api/queue/find" }, async (ctx, req) => {
      const body = await req.json<{ version?: unknown }>().catch(() => ({}) as Record<string, unknown>);
      if (!validVersion(body.version)) return bad("bad_version");
      const now = Date.now();
      const host = pickHost(await waiting(ctx, body.version, now), body.version, now);
      return json({ code: host?.code ?? null });
    }),

    // Guest: read the offer behind a code.
    readOffer: endpoint({ method: "GET", path: "/api/invites/:code" }, async (ctx, req) => {
      const invite = await live(ctx, codeFromPath(req.path));
      return invite ? json({ offer: invite.offer, taken: invite.answer !== "" }) : notFound();
    }),

    // Guest: answer it. One answer per invite.
    postAnswer: endpoint({ method: "POST", path: "/api/invites/:code/answer" }, async (ctx, req) => {
      const invite = await live(ctx, codeFromPath(req.path));
      if (!invite) return notFound();
      if (invite.answer !== "") return json({ error: "taken" }, { status: 409 });
      const body = await req.json<{ answer?: unknown }>().catch(() => ({}) as { answer?: unknown });
      if (!validBlob(body.answer)) return bad("bad_answer");
      await ctx.db.invites!.update(invite.id, { answer: body.answer });
      return json({ ok: true });
    }),

    // Host: has anyone answered? Needs the key from createInvite.
    readAnswer: endpoint({ method: "GET", path: "/api/invites/:code/answer" }, async (ctx, req) => {
      const invite = await live(ctx, codeFromPath(req.path));
      if (!invite || req.query.get("key") !== invite.key) return notFound();
      return json({ answer: invite.answer || null });
    }),
  },
});

// Read and write handler contexts differ in type; these helpers only read, so
// they take either.
// deno-lint-ignore no-explicit-any
type Ctx = any;

async function find(ctx: Ctx, code: string) {
  return ctx.db.invites!.withIndex("by_code", (range: Ctx) => range.eq("code", code)).first();
}

/** Fresh listings on a version; sweeps the stale and the already-answered on the way. */
async function waiting(ctx: Ctx, version: string, now: number): Promise<Listing[]> {
  const rows = await ctx.db.queue!.withIndex("by_version", (r: Ctx) => r.eq("version", version)).take(50);
  const out: Listing[] = [];
  for (const row of rows) {
    const invite = fresh(row, now) ? await live(ctx, row.code) : null;
    if (invite && invite.answer === "") out.push(row);
    else await ctx.db.queue.delete(row.id);
  }
  return out;
}

async function live(ctx: Ctx, code: string | null) {
  if (!code) return null;
  const invite = await find(ctx, code);
  return invite && !expired(invite.createdAt, Date.now()) ? invite : null;
}

