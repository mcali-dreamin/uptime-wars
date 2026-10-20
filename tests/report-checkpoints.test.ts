// Long matches check in every few minutes and each report updates one row,
// so closing the tab (where a request can carry at most 64 KB) loses at most
// the last few minutes, never the whole match. (#135)

import { describe, expect, it } from "vitest";
import server from "../zero/server/index";
import { mergeMatch, parseMatch, type MatchRow } from "../zero/server/matches";
import { buildReport, LEAVING_LIMIT, reportBody, type MatchReport } from "../src/game/telemetry";
import { createWorld, queueCommand, step } from "../src/sim";
import { content, OPENING, SETUP } from "./fixtures";

const PLAYER = "4f6c1d2e-9a7b-4c3d-8e1f-0a2b3c4d5e6f";
const MATCH = "0b9e2f4a-1c3d-4e5f-8a9b-7c6d5e4f3a2b";

function report(ticks: number, ended = false): MatchReport {
  const world = createWorld(content, SETUP);
  for (const command of OPENING) queueCommand(world, command);
  while (world.tick < ticks) step(world, content);
  return { ...buildReport(content, world, 0, PLAYER, "1.2.3", ended), match: MATCH };
}

/** A big log, like an hour of play: far past what a closing tab can send. */
function huge(r: MatchReport): MatchReport {
  const log = Array.from({ length: 1500 }, (_, i) => ({ type: "move" as const, tick: i, team: 0, x: 12345.678901234, y: 6789.0123456789 }));
  return { ...r, log };
}

/** The real endpoint over a little in-memory table. */
function serverWithTable() {
  const rows: (MatchRow & { id: string })[] = [];
  const matches = {
    insert: async (row: MatchRow) => rows.push({ ...row, id: String(rows.length + 1) }),
    update: async (id: string, patch: Partial<MatchRow>) => Object.assign(rows.find((r) => r.id === id)!, patch),
    withIndex: (_: string, where: (r: { eq: (f: string, v: unknown) => unknown }) => unknown) => {
      let field = "";
      let value: unknown;
      where({ eq: (f, v) => ((field = f), (value = v)) });
      return { first: async () => rows.find((r) => (r as unknown as Record<string, unknown>)[field] === value) ?? null };
    },
  };
  const endpoint = Object.values(server.endpoints!).find((e) => e.method === "POST" && e.path === "/api/matches")!;
  const post = async (body: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await endpoint.handler({ db: { matches } } as any, { method: "POST", path: "/api/matches", json: async () => JSON.parse(body) } as any)) as { status: number };
    return response.status;
  };
  return { rows, post };
}

describe("match report checkpoints", () => {
  it("reports of one match update its row instead of adding rows", async () => {
    const { rows, post } = serverWithTable();
    expect(await post(reportBody(report(400), false))).toBe(200);
    expect(await post(reportBody(report(800, true), false))).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.match).toBe(MATCH);
    expect(JSON.parse(rows[0]!.summary).ticks).toBe(800);
  });

  it("a late, older checkpoint doesn't overwrite the newer report", async () => {
    const { rows, post } = serverWithTable();
    await post(reportBody(report(800, true), false));
    await post(reportBody(report(400), false));
    expect(rows[0]!.outcome).toBe("lost"); // the final report, not the stale "abandoned" checkpoint
    expect(JSON.parse(rows[0]!.summary).ticks).toBe(800);
  });

  it("a report too big to send as the tab closes goes without its log, and keeps the checkpoint's", async () => {
    const { rows, post } = serverWithTable();
    const checkpoint = huge(report(400));
    await post(reportBody(checkpoint, false));
    const leaving = huge(report(800));
    const body = reportBody(leaving, true);
    expect(JSON.stringify(leaving).length).toBeGreaterThan(LEAVING_LIMIT);
    expect(body.length).toBeLessThanOrEqual(LEAVING_LIMIT);
    expect(JSON.parse(body).summary.logComplete).toBe(false);
    await post(body);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.log).toBe(JSON.stringify(checkpoint.log));
    expect(JSON.parse(rows[0]!.summary)).toMatchObject({ ticks: 800, logComplete: false });
  });

  it("small reports go whole, even as the tab closes", () => {
    const r = report(400);
    expect(reportBody(r, true)).toBe(JSON.stringify(r));
  });

  it("someone else's report can't take over a match's row", () => {
    const stored = parseMatch(JSON.parse(reportBody(report(400), false))) as MatchRow;
    const other = parseMatch(JSON.parse(reportBody({ ...report(800), player: "ffffffff-ffff-4fff-8fff-ffffffffffff" }, false))) as MatchRow;
    expect(mergeMatch(stored, other)).toBeNull();
  });

  it("match ids are checked, and reports without one still work", () => {
    expect(parseMatch(JSON.parse(reportBody({ ...report(400), match: "../x" }, false)))).toBe("bad_match");
    const { match: _, ...plain } = report(400);
    expect((parseMatch(JSON.parse(JSON.stringify(plain))) as MatchRow).match).toBe("");
  });
});
