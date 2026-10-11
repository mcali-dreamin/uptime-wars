// What every browser test shares: serve dist/, launch Chromium, collect
// console errors, poll, and report checks.
//
// The rule for these tests: they prove the *browser wiring* (the page boots,
// real clicks and keys reach the game, the UI shows what it should, nothing
// throws). Game rules belong in tests/*.test.ts, where the simulation runs
// headless in milliseconds. So a check here waits for an order to land, never
// for the game to play it out (units walking, spawners spawning).

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

/** A fixed seed by default so a failure reproduces; SEED=n to try another. */
export const SEED = process.env.SEED ?? "1234";

/**
 * Serve `dist` (argv[2]) on a free port. `route(req, res, path)` can answer a
 * request first; return true when it did.
 */
export async function serve(route = async () => false) {
  const root = resolve(process.argv[2] ?? "dist");
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (await route(req, res, path)) return;
    const file = join(root, path === "/" ? "index.html" : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

/** Poll `fn` until it returns something truthy or `ms` pass; returns the last value. */
export async function waitFor(fn, ms = 15000) {
  const until = Date.now() + ms;
  let value;
  do {
    value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 150));
  } while (Date.now() < until);
  return value;
}

/** A test run: checks, console errors, and one browser. */
export async function run(name, body, { args = [], ignoreError = () => false } = {}) {
  const failures = [];
  const errors = [];
  const check = (ok, message) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
    if (!ok) failures.push(message);
  };
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", ...args] });
  /** A fresh page (own context, so own storage) that reports its errors. */
  const open = async (url, viewport = { width: 1280, height: 800 }) => {
    const page = await (await browser.newContext({ viewport })).newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !ignoreError(m) && errors.push(m.text()));
    await page.goto(url);
    await page.waitForSelector("canvas", { timeout: 60000 });
    return page;
  };
  try {
    await body({ check, open });
  } catch (error) {
    check(false, `${name} crashed: ${error.message}`);
  } finally {
    check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await browser.close();
  }
  if (failures.length > 0) {
    console.log(`\n${name}: ${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\n${name} passed`);
}

/** Game helpers on a page with `?debug` (window.uptime): read state and find where to click. */
export function game(page) {
  const state = (fn, arg) => page.evaluate(fn, arg);
  return {
    state,
    /** World point to page pixels through the live view (3D or 2D). */
    toPage: (x, y) => state(([x, y]) => window.uptime.renderer.toScreen(x, y), [x, y]),
    /** Your deploy agent, else your core. */
    home: () =>
      state(() => {
        const { world, session } = window.uptime;
        const team = world.teams[session.local];
        const e = world.entities.find((x) => x.id === (team.coreId !== -1 ? team.coreId : team.builderId));
        return { id: e.id, x: e.x, y: e.y };
      }),
    /**
     * The centre of an open tile `min`..`max` tiles from (x, y), not under a
     * building, that survives a screen round trip (in 3D, ground behind a
     * plateau can't be clicked).
     */
    openNear: (x, y, min, max) =>
      state(([x, y, min, max]) => {
        const { world, TILE, renderer } = window.uptime;
        const t = world.terrain;
        const free = (px, py) =>
          !world.entities.some((e) => e.kind === "building" && Math.abs(px - e.x) < (e.footprint * TILE) / 2 + 8 && Math.abs(py - e.y) < (e.footprint * TILE) / 2 + 8);
        const clickable = (px, py) => {
          const s = renderer.toScreen(px, py);
          const back = renderer.toWorld(s.x, s.y);
          return Math.hypot(back.x - px, back.y - py) < 12;
        };
        for (let r = min; r <= max; r++)
          for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
            const px = (Math.floor(x / TILE) + dx + 0.5) * TILE;
            const py = (Math.floor(y / TILE) + dy + 0.5) * TILE;
            if (t.tiles[Math.floor(py / TILE) * t.cols + Math.floor(px / TILE)] === 0 && free(px, py) && clickable(px, py)) return { x: px, y: py };
          }
        return null;
      }, [x, y, min, max]),
  };
}
