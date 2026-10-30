// Visit pings: what the server accepts, and when the client sends them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import server from "../zero/server/index";
import { parseVisit, type VisitRow } from "../zero/server/visits";
import { Telemetry } from "../src/game/telemetry";
import { content } from "./fixtures";

const PLAYER = "4f6c1d2e-9a7b-4c3d-8e1f-0a2b3c4d5e6f";
const VISIT = "0b9e2f4a-1c3d-4e5f-8a9b-7c6d5e4f3a2b";
const good = { player: PLAYER, visit: VISIT, version: "1.2.3", entry: "direct", referrer: "example.com", started: 0 };

describe("parseVisit", () => {
  it("accepts a valid visit", () => {
    expect(parseVisit(good)).toEqual(good);
    expect(parseVisit({ ...good, entry: "quick", referrer: "", started: 1 })).toMatchObject({ entry: "quick", started: 1 });
  });
  it.each([
    ["bad_body", null],
    ["bad_player", { ...good, player: "x" }],
    ["bad_visit", { ...good, visit: "no spaces allowed!" }],
    ["bad_version", { ...good, version: "1.2" }],
    ["bad_entry", { ...good, entry: "other" }],
    ["bad_referrer", { ...good, referrer: "a/b" }],
    ["bad_referrer", { ...good, referrer: "a".repeat(101) }],
    ["bad_started", { ...good, started: 2 }],
    ["bad_started", { ...good, started: true }],
  ])("rejects %s", (error, body) => {
    expect(parseVisit(body)).toBe(error);
  });
});

describe("POST /api/visits", () => {
  function setup() {
    const rows: (VisitRow & { id: string })[] = [];
    const visits = {
      insert: async (row: VisitRow) => rows.push({ ...row, id: String(rows.length + 1) }),
      update: async (id: string, patch: Partial<VisitRow>) => Object.assign(rows.find((r) => r.id === id)!, patch),
      withIndex: (_: string, where: (r: { eq: (f: string, v: unknown) => unknown }) => unknown) => {
        let field = "";
        let value: unknown;
        where({ eq: (f, v) => ((field = f), (value = v)) });
        return { first: async () => rows.find((r) => (r as unknown as Record<string, unknown>)[field] === value) ?? null };
      },
    };
    const endpoint = Object.values(server.endpoints!).find((e) => e.method === "POST" && e.path === "/api/visits")!;
    const post = async (body: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = (await endpoint.handler({ db: { visits } } as any, { method: "POST", path: "/api/visits", json: async () => body } as any)) as { status: number };
      return r.status;
    };
    return { rows, post };
  }

  it("inserts, raises started, never lowers it, ignores other players", async () => {
    const { rows, post } = setup();
    expect(await post(good)).toBe(200);
    expect(await post({ ...good, started: 1 })).toBe(200);
    expect(await post(good)).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.started).toBe(1);
    await post({ ...good, player: "another-player-id", started: 0 });
    expect(rows).toHaveLength(1);
    const other = setup();
    await other.post(good);
    await other.post({ ...good, player: "another-player-id", started: 1 });
    expect(other.rows[0]!.started).toBe(0);
    expect(await other.post({ ...good, entry: "bad" })).toBe(400);
  });
});

describe("Telemetry visits", () => {
  const store = new Map<string, string>();
  let fetchMock: ReturnType<typeof vi.fn>;
  const stub = (hostname: string, extra: Record<string, unknown> = {}) => {
    vi.stubGlobal("location", { hostname, hash: "", search: "", ...extra });
    vi.stubGlobal("document", { referrer: "https://news.example.org/post" });
  };

  beforeEach(() => {
    store.clear();
    fetchMock = vi.fn(async () => ({}));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodies = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));

  it("pings on load, and once when a match starts", () => {
    stub("play.example.com", { hash: "#join=ABC" });
    const t = new Telemetry(content, "1.2.3");
    t.visit();
    t.matchStarted();
    t.matchStarted();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("api/visits");
    const [first, second] = bodies();
    expect(first).toMatchObject({ entry: "join", referrer: "news.example.org", started: 0, version: "1.2.3" });
    expect(second).toMatchObject({ visit: first.visit, started: 1 });
    expect(parseVisit(first)).not.toBeTypeOf("string");
  });

  it("sends nothing when opted out or on localhost", () => {
    stub("play.example.com");
    store.set("uptime:telemetry", "off");
    const off = new Telemetry(content, "1.2.3");
    off.visit();
    off.matchStarted();
    stub("localhost");
    store.clear();
    const local = new Telemetry(content, "1.2.3");
    local.visit();
    local.matchStarted();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
