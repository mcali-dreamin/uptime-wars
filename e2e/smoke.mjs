// Browser smoke test of the built game (dist/). Plays the opening with real
// clicks and keys and fails on any console error or broken step.
//
//   npm run build && npm run e2e
//
// Uses the ?debug hook (window.uptime) only to find where to click and to
// check results, never to drive the game.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? "dist");
const SEED = process.env.SEED ?? String(1 + Math.floor(Math.random() * 1e9));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = join(ROOT, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);

const failures = [];
/** Poll `fn` until it returns truthy or `ms` of wall time pass; returns the last value. */
const waitFor = async (fn, ms) => {
  const until = Date.now() + ms;
  let value;
  do {
    value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < until);
  return value;
};
/**
 * Poll `fn` until it returns truthy or the *game* advances `seconds` of game
 * time. CI renders in software and runs the game at a fraction of real time,
 * so budgets for things that happen in the game are counted in game ticks;
 * the wall-clock cap only stops a hung page.
 */
let tickOf = async () => 0;
const waitForGame = async (fn, seconds) => {
  const start = await tickOf();
  return waitFor(async () => (await fn()) || (await tickOf()) - start >= seconds * 20, 15 * 60 * 1000).then(async () => fn());
};
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

try {
  console.log(`seed ${SEED} (rerun with SEED=${SEED})`);
  await page.goto(`http://127.0.0.1:${server.address().port}/?debug&seed=${SEED}`);
  await page.waitForSelector("canvas", { timeout: 20000 });
  await page.waitForTimeout(800);
  const box = await (await page.$("canvas")).boundingBox();
  const state = (fn, arg) => page.evaluate(fn, arg);
  tickOf = () => state(() => window.uptime.world.tick);
  /** World point -> page point, through the live view (3D by default). */
  const toPage = (x, y) => state(([x, y]) => window.uptime.renderer.toScreen(x, y), [x, y]);
  /**
   * An open tile `min`..`max` tiles from (x, y), searched in a fixed pattern,
   * that you can actually click: in 3D, ground behind a higher plateau is
   * hidden, so the point must survive a screen round trip.
   */
  const openNear = (x, y, min, max) =>
    state(([x, y, min, max]) => {
      const { world, TILE, renderer } = window.uptime;
      const t = world.terrain;
      const clickable = (px, py) => {
        const s = renderer.toScreen(px, py);
        const back = renderer.toWorld(s.x, s.y);
        return Math.hypot(back.x - px, back.y - py) < 12;
      };
      for (let r = min; r <= max; r++)
        for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
          const px = x + dx * TILE, py = y + dy * TILE;
          if (t.tiles[Math.floor(py / TILE) * t.cols + Math.floor(px / TILE)] === 0 && clickable(px, py)) return { x: px, y: py };
        }
      return null;
    }, [x, y, min, max]);

  // 0. The Three.js view is the default: a WebGL canvas under the Pixi overlay.
  check((await page.$$eval("#stage canvas", (c) => c.length)) === 2, "the 3D view is drawn by default (WebGL canvas + overlay)");

  // 1. Race picker, then the deploy agent starts selected.
  check(await page.$eval("#race-picker", (el) => !el.hidden), "race picker is shown");
  await page.keyboard.press("1");
  const started = Date.now();
  await page.waitForTimeout(300);
  const agent = await state(() => {
    const w = window.uptime.world;
    const a = w.entities.find((e) => e.id === w.teams[0].builderId);
    return { id: a.id, x: a.x, y: a.y, selected: window.uptime.selection.kind === "entity" && window.uptime.selection.id === a.id };
  });
  check(agent.selected, "deploy agent starts selected");
  check((await page.textContent("#hint")).length > 0, "hint line is shown while deploying");

  // 2. Click the ground: the agent walks there.
  const walkTo = await openNear(agent.x, agent.y, 4, 8);
  let p = await toPage(walkTo.x, walkTo.y);
  await page.mouse.click(p.x, p.y);
  const distanceLeft = () =>
    state(([x, y]) => {
      const w = window.uptime.world;
      const a = w.entities.find((e) => e.id === w.teams[0].builderId);
      return Math.hypot(a.x - x, a.y - y);
    }, [walkTo.x, walkTo.y]);
  await waitForGame(async () => (await distanceLeft()) < 30, 30);
  const walked = await distanceLeft();
  check(walked < 30, `clicking the ground walks the agent (ended ${Math.round(walked)}px away)`);

  // 3. C, then click: the agent founds the core and the build bar switches.
  const here = await state(() => {
    const w = window.uptime.world;
    const a = w.entities.find((e) => e.id === w.teams[0].builderId);
    return { x: a.x, y: a.y };
  });
  await page.keyboard.press("c");
  p = await toPage(here.x, here.y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  const founded = await waitForGame(() => state(() => window.uptime.world.teams[0].coreId !== -1), 30);
  check(founded, "C + click founds the core");
  await waitFor(() => page.$$eval(".build-btn", (b) => !b.some((x) => x.dataset.building === "found")), 10000);
  const buttons = await page.$$eval(".build-btn", (b) => b.map((x) => x.dataset.building));
  check(buttons.length >= 4 && !buttons.includes("found"), `build bar shows the roster (${buttons.join(", ")})`);

  // 4. Build a spawner, select it, right-click a rally point: its units go there.
  const core = await state(() => {
    const w = window.uptime.world;
    const c = w.entities.find((e) => e.id === w.teams[0].coreId);
    return { x: c.x, y: c.y };
  });
  const spot = await openNear(core.x, core.y, 2, 5);
  await page.keyboard.press("1");
  p = await toPage(spot.x, spot.y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  const spawnerId = await waitForGame(
    () => state(() => window.uptime.world.entities.find((e) => e.kind === "building" && e.team === 0 && window.uptime.content.buildings[e.defId].spawn)?.id ?? null),
    10,
  );
  check(spawnerId !== null, "placing a spawner works");
  const spawned = await waitForGame(() => state((id) => window.uptime.world.entities.some((e) => e.kind === "unit" && e.spawnerId === id), spawnerId), 30);
  check(Boolean(spawned), "the spawner produces units");
  p = await toPage(spot.x, spot.y);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(200);
  check(await state((id) => window.uptime.selection.kind === "entity" && window.uptime.selection.id === id, spawnerId), "clicking a building selects it");
  const rally = await openNear(spot.x, spot.y, 5, 10);
  p = await toPage(rally.x, rally.y);
  await page.mouse.click(p.x, p.y, { button: "right" });
  const distances = () =>
    state(([id, x, y]) => {
      const units = window.uptime.world.entities.filter((e) => e.kind === "unit" && e.spawnerId === id);
      return units.map((u) => Math.round(Math.hypot(u.x - x, u.y - y)));
    }, [spawnerId, rally.x, rally.y]);
  await waitForGame(async () => {
    const d = await distances();
    return d.length > 0 && d.every((n) => n < 90);
  }, 60);
  const gathered = await distances();
  check(gathered.length > 0 && gathered.every((d) => d < 90), `right-click rallies the spawner's units (${gathered.join(", ")}px)`);

  // 4b. No right button (laptops): T then a left-click, or Ctrl-click, sets the rally too.
  const rallyOf = () =>
    state((id) => {
      const r = window.uptime.world.entities.find((e) => e.id === id)?.rally;
      return r ? { x: r.x, y: r.y } : null;
    }, spawnerId);
  const near = (a, b) => a !== null && Math.hypot(a.x - b.x, a.y - b.y) < 40;
  const viaKey = await openNear(spot.x, spot.y, 3, 8);
  await page.keyboard.press("t");
  check(await state(() => window.uptime.selection.armed === true), "T arms the rally order");
  p = await toPage(viaKey.x, viaKey.y);
  await page.mouse.click(p.x, p.y);
  check(near(await waitForGame(async () => { const r = await rallyOf(); return near(r, viaKey) ? r : null; }, 5), viaKey), "T + left-click sets the rally");
  check(await state((id) => window.uptime.selection.kind === "entity" && window.uptime.selection.id === id && !window.uptime.selection.armed, spawnerId), "the armed order is one-shot; the spawner stays selected");
  const viaCtrl = await openNear(spot.x, spot.y, 6, 12);
  p = await toPage(viaCtrl.x, viaCtrl.y);
  await page.keyboard.down("Control");
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up("Control");
  check(near(await waitForGame(async () => { const r = await rallyOf(); return near(r, viaCtrl) ? r : null; }, 5), viaCtrl), "Ctrl-click sets the rally");

  // 5. Select the core: the bar shows research; researching an upgrade starts it.
  await page.keyboard.press("Escape");
  await state(() => { window.uptime.world.teams[0].compute += 500; });
  p = await toPage(core.x, core.y);
  await page.mouse.click(p.x, p.y);
  const upgrades = await waitFor(() => page.$$eval(".upgrade-btn", (b) => b.length), 10000);
  check(upgrades >= 6, `selecting the core shows research (${upgrades} upgrades)`);
  await page.click(".upgrade-btn:not([disabled])");
  const researching = await waitForGame(() => state(() => window.uptime.world.teams[0].research?.upgrade ?? null), 10);
  check(Boolean(researching), `clicking an upgrade starts research (${researching})`);

  const ticks = await state(() => window.uptime.world.tick);
  console.log(`info ${ticks} ticks in ${((Date.now() - started) / 1000).toFixed(0)}s of wall time (${(ticks / 20 / ((Date.now() - started) / 1000)).toFixed(2)}x real time)`);

  // 6. The Guide opens, pauses the match, and closes.
  await page.keyboard.press("g");
  await page.waitForTimeout(200);
  check(await page.$eval("#guide", (el) => !el.hidden), "G opens the guide");
  const tabs = await page.$$eval("#guide-tabs button", (b) => b.length);
  check(tabs === 6, `guide has 6 tabs (${tabs})`);
  const t0 = await state(() => window.uptime.world.tick);
  await page.waitForTimeout(1500);
  check(t0 === (await state(() => window.uptime.world.tick)), "the match pauses while the guide is open");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check(await page.$eval("#guide", (el) => el.hidden), "Esc closes the guide");
} catch (error) {
  check(false, `smoke test crashed: ${error.message}`);
} finally {
  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  await browser.close();
  server.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke test passed");
