// The co-op invite relay (zero/server), run against an in-memory database
// shaped like Zero's: the real handlers, a fake ctx.

import { describe, expect, it, vi } from "vitest";
import server from "../zero/server/index";
import { CODE_LENGTH, INVITE_TTL_MS, MAX_BLOB, QUEUE_FRESH_MS, codeFromPath, makeCode, pickHost, validCode } from "../zero/server/rules";

type Row = { id: string; createdAt: string; updatedAt: string; [field: string]: unknown };

function fakeDb() {
  return { invites: fakeTable({ answer: "" }), queue: fakeTable({}) };
}

function fakeTable(defaults: Record<string, unknown>) {
  const rows: Row[] = [];
  let next = 1;
  const range = (filters: [string, unknown][]) => ({ eq: (field: string, value: unknown) => (filters.push([field, value]), range(filters)) });
  return {
    rows,
    withIndex(_name: string, build?: (r: ReturnType<typeof range>) => unknown) {
      const filters: [string, unknown][] = [];
      build?.(range(filters));
      let list = rows.filter((row) => filters.every(([f, v]) => row[f] === v));
      const chain = {
        order(dir: "asc" | "desc") {
          list = [...list].sort((a, b) => (dir === "asc" ? 1 : -1) * a.createdAt.localeCompare(b.createdAt));
          return chain;
        },
        take: async (n: number) => list.slice(0, n),
        first: async () => list[0] ?? null,
        collect: async () => list,
      };
      return chain;
    },
    insert: async (value: Record<string, unknown>) => {
      const now = new Date().toISOString();
      const row = { ...defaults, ...value, id: String(next++), createdAt: now, updatedAt: now } as Row;
      rows.push(row);
      return row;
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      return row ?? null;
    },
    delete: async (id: string) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return i >= 0;
    },
  };
}

function relay() {
  const db = fakeDb();
  const call = async (method: string, path: string, body?: unknown) => {
    const url = new URL(path, "https://game.example");
    const endpoint = Object.values(server.endpoints!).find((e) => {
      if (e.method !== method) return false;
      const want = e.path.split("/");
      const got = url.pathname.split("/");
      return want.length === got.length && want.every((part, i) => part.startsWith(":") || part === got[i]);
    });
    if (!endpoint) throw new Error(`no route ${method} ${path}`);
    const req = {
      method,
      path: url.pathname,
      url: url.toString(),
      headers: new Headers(),
      query: url.searchParams,
      text: async () => JSON.stringify(body ?? {}),
      json: async () => body ?? {},
      bytes: async () => new Uint8Array(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await endpoint.handler({ db } as any, req as any)) as { status: number; body: string };
    return { status: response.status, body: JSON.parse(response.body) };
  };
  return { db, call };
}

const OFFER = "eJy1V2" + "a".repeat(1500);
const ANSWER = "eJyFU" + "b".repeat(1500);

describe("invite relay", () => {
  it("host posts an offer; guest reads it and answers; host reads the answer with its key", async () => {
    const { call } = relay();
    const created = await call("POST", "/api/invites", { offer: OFFER });
    expect(created.status).toBe(200);
    const { code, key } = created.body as { code: string; key: string };
    expect(validCode(code)).toBe(true);

    expect((await call("GET", `/api/invites/${code}`)).body).toEqual({ offer: OFFER, taken: false });
    expect((await call("GET", `/api/invites/${code}/answer?key=${key}`)).body).toEqual({ answer: null });

    expect((await call("POST", `/api/invites/${code}/answer`, { answer: ANSWER })).status).toBe(200);
    expect((await call("GET", `/api/invites/${code}/answer?key=${key}`)).body).toEqual({ answer: ANSWER });
    // Codes are case-insensitive in links.
    expect((await call("GET", `/api/invites/${code.toLowerCase()}`)).body).toMatchObject({ taken: true });
  });

  it("the answer is only readable with the host's key", async () => {
    const { call } = relay();
    const { code } = (await call("POST", "/api/invites", { offer: OFFER })).body as { code: string };
    await call("POST", `/api/invites/${code}/answer`, { answer: ANSWER });
    expect((await call("GET", `/api/invites/${code}/answer`)).status).toBe(404);
    expect((await call("GET", `/api/invites/${code}/answer?key=nope`)).status).toBe(404);
  });

  it("an invite seats one guest", async () => {
    const { call } = relay();
    const { code } = (await call("POST", "/api/invites", { offer: OFFER })).body as { code: string };
    expect((await call("POST", `/api/invites/${code}/answer`, { answer: ANSWER })).status).toBe(200);
    expect((await call("POST", `/api/invites/${code}/answer`, { answer: "eJxOther" })).status).toBe(409);
  });

  it("rejects junk: bad offers, bad answers, unknown codes", async () => {
    const { call } = relay();
    for (const offer of [undefined, "", 42, "has spaces", "<script>", "a".repeat(MAX_BLOB + 1)]) {
      expect((await call("POST", "/api/invites", { offer })).status).toBe(400);
    }
    expect((await call("GET", "/api/invites/ZZZZZZ")).status).toBe(404);
    expect((await call("GET", "/api/invites/short")).status).toBe(404);
    const { code } = (await call("POST", "/api/invites", { offer: OFFER })).body as { code: string };
    expect((await call("POST", `/api/invites/${code}/answer`, { answer: "no spaces allowed" })).status).toBe(400);
  });

  it("invites expire, and creating one sweeps old ones", async () => {
    const { call, db } = relay();
    const { code } = (await call("POST", "/api/invites", { offer: OFFER })).body as { code: string };
    vi.useFakeTimers({ now: Date.now() + INVITE_TTL_MS + 1000, toFake: ["Date"] });
    try {
      expect((await call("GET", `/api/invites/${code}`)).status).toBe(404);
      await call("POST", "/api/invites", { offer: OFFER });
      expect(db.invites.rows.map((r) => r.code)).not.toContain(code);
      expect(db.invites.rows).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("codes are six unambiguous letters and digits", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i += 1) {
      const code = makeCode(random);
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).not.toMatch(/[01OIL]/);
      expect(validCode(code)).toBe(true);
    }
    expect(codeFromPath("/api/invites/k7qf2m/answer")).toBe("K7QF2M");
    expect(codeFromPath("/api/other/K7QF2M")).toBeNull();
  });
});

describe("quick match queue", () => {
  const V = "0.65.0";
  /** A host with an open invite, listed for Quick Match. */
  async function listed(call: ReturnType<typeof relay>["call"], version = V) {
    const { code, key } = (await call("POST", "/api/invites", { offer: OFFER })).body as { code: string; key: string };
    const res = await call("POST", "/api/queue", { code, key, version });
    return { code, key, res };
  }
  const later = async (ms: number, fn: () => Promise<void>) => {
    vi.useFakeTimers({ now: Date.now() + ms, toFake: ["Date"] });
    try {
      await fn();
    } finally {
      vi.useRealTimers();
    }
  };

  it("nobody waiting: find comes back empty; a listed host is found, on its version only", async () => {
    const { call } = relay();
    expect((await call("POST", "/api/queue/find", { version: V })).body).toEqual({ code: null });
    const host = await listed(call);
    expect(host.res.body).toEqual({ ok: true, join: null });
    expect((await call("POST", "/api/queue/find", { version: V })).body).toEqual({ code: host.code });
    expect((await call("POST", "/api/queue/find", { version: "0.64.0" })).body).toEqual({ code: null });
  });

  it("listing needs the invite's key", async () => {
    const { call } = relay();
    const { code } = (await call("POST", "/api/invites", { offer: OFFER })).body as { code: string };
    expect((await call("POST", "/api/queue", { code, key: "nope", version: V })).status).toBe(404);
    expect((await call("POST", "/api/queue", { code, key: "x", version: "has spaces" })).status).toBe(400);
    expect((await call("POST", "/api/queue/find", { version: V })).body).toEqual({ code: null });
  });

  it("an answered invite drops off the queue", async () => {
    const { call, db } = relay();
    const host = await listed(call);
    await call("POST", `/api/invites/${host.code}/answer`, { answer: ANSWER });
    expect((await call("POST", "/api/queue/find", { version: V })).body).toEqual({ code: null });
    expect(db.queue.rows).toHaveLength(0);
  });

  it("a host that stops heartbeating is gone; one that keeps it up stays", async () => {
    const { call } = relay();
    const gone = await listed(call);
    const staying = await listed(call);
    await later(QUEUE_FRESH_MS / 2, async () => {
      await call("POST", "/api/queue", { code: staying.code, key: staying.key, version: V });
    });
    await later(QUEUE_FRESH_MS + 1000, async () => {
      expect((await call("POST", "/api/queue/find", { version: V })).body).toEqual({ code: staying.code });
    });
    expect(gone.code).not.toBe(staying.code);
  });

  it("two searching at once: the later host is told to join the earlier one", async () => {
    const { call } = relay();
    const first = await listed(call);
    await later(50, async () => {
      const second = await listed(call);
      expect(second.res.body).toEqual({ ok: true, join: first.code });
      // ...and the earlier one is never told to give way.
      expect((await call("POST", "/api/queue", { code: first.code, key: first.key, version: V })).body).toEqual({ ok: true, join: null });
    });
  });

  it("leaving takes the listing down", async () => {
    const { call } = relay();
    const host = await listed(call);
    expect((await call("POST", "/api/queue/leave", { code: host.code, key: "nope" })).status).toBe(404);
    expect((await call("POST", "/api/queue/leave", { code: host.code, key: host.key })).status).toBe(200);
    expect((await call("POST", "/api/queue/find", { version: V })).body).toEqual({ code: null });
  });

  it("the longest wait wins; ties go by code, the same answer from both sides", () => {
    const at = (code: string, since: number) => ({ code, version: V, since, seen: 1000 });
    const a = at("AAAAAA", 10);
    const b = at("BBBBBB", 10);
    const c = at("CCCCCC", 5);
    expect(pickHost([a, b, c], V, 1000)?.code).toBe("CCCCCC");
    expect(pickHost([a, b], V, 1000, b)?.code).toBe("AAAAAA");
    expect(pickHost([a, b], V, 1000, a)).toBeNull();
  });
});

