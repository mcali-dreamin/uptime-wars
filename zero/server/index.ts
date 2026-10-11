// The game's server: a tiny signaling relay so co-op invites are short links.
//
// A host posts a WebRTC offer and gets a code (and a secret key). A friend
// opening `#join=CODE` reads the offer and posts back an answer. The host
// polls for the answer with its key. After that the browsers talk directly;
// nothing about the match ever touches this server.
//
// Everything else in this space is the static game build.

import { capsule, endpoint, json, string, table } from "@spacefast/zero/server";
import { KEY_LENGTH, codeFromPath, expired, makeCode, validBlob } from "./rules";

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

async function live(ctx: Ctx, code: string | null) {
  if (!code) return null;
  const invite = await find(ctx, code);
  return invite && !expired(invite.createdAt, Date.now()) ? invite : null;
}

