// Match reports: what the game sends, and what the server accepts.

import { describe, expect, it } from "vitest";
import server from "../zero/server/index";
import { MAX_LOG, parseMatch } from "../zero/server/matches";
import { buildReport } from "../src/game/telemetry";
import { createWorld, hashWorld, queueCommand, simulate, step } from "../src/sim";
import { content, OPENING, SETUP } from "./fixtures";

const PLAYER = "4f6c1d2e-9a7b-4c3d-8e1f-0a2b3c4d5e6f";

function playedWorld(ticks = 1200) {
  const world = createWorld(content, SETUP);
  for (const command of OPENING) queueCommand(world, command);
  while (world.tick < ticks && !world.outcome) step(world, content);
  return world;
}

/** The report as it travels: through JSON, like the wire. */
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

async function post(body: unknown) {
  const rows: Record<string, unknown>[] = [];
  const endpoint = Object.values(server.endpoints!).find((e) => e.method === "POST" && e.path === "/api/matches")!;
  const req = { method: "POST", path: "/api/matches", json: async () => body };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = { db: { matches: { insert: async (row: Record<string, unknown>) => rows.push(row) } } } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = (await endpoint.handler(ctx, req as any)) as { status: number; body: string };
  return { status: response.status, body: JSON.parse(response.body), rows };
}

describe("match reports", () => {
  it("the game's report says what happened from the player's side", () => {
    const world = playedWorld();
    const report = buildReport(content, world, 0, PLAYER, "1.2.3", false);
    expect(report).toMatchObject({ seed: SETUP.seed, mode: "coop", race: "open-source", team: 0, outcome: "abandoned", version: "1.2.3" });
    expect(report.survived).toBe(world.tick / 20);
    expect(Object.values(report.summary.built).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("a stored report replays the match exactly", async () => {
    const world = playedWorld(1500);
    const { status, rows } = await post(wire(buildReport(content, world, 0, PLAYER, "1.2.3", false)));
    expect(status).toBe(200);
    const row = rows[0]!;
    const replayed = simulate(
      content,
      { seed: row.seed as number, races: (row.races as string).split(","), startWithCore: true },
      JSON.parse(row.log as string),
      world.tick,
    );
    expect(hashWorld(replayed)).toBe(hashWorld(world));
  });

  it("the server stores a good report and turns away bad ones", async () => {
    const good = wire(buildReport(content, playedWorld(500), 0, PLAYER, "1.2.3", true));
    expect((await post(good)).rows).toHaveLength(1);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...good, player: "x" }, "bad_player"],
      [{ ...good, version: "latest" }, "bad_version"],
      [{ ...good, mode: "pvp" }, "bad_mode"],
      [{ ...good, race: "<script>" }, "bad_race"],
      [{ ...good, outcome: "cheated" }, "bad_outcome"],
      [{ ...good, survived: -1 }, "bad_stats"],
      [{ ...good, log: "nope" }, "bad_log"],
      [{ ...good, log: [{ pad: "a".repeat(MAX_LOG) }] }, "log_too_big"],
    ];
    for (const [body, error] of cases) {
      const response = await post(body);
      expect(response.status, error).toBe(400);
      expect(response.body.error).toBe(error);
      expect(response.rows).toHaveLength(0);
    }
    expect(parseMatch(null)).toBe("bad_body");
  });
});
