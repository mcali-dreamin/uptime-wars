// An interactive play harness: one Chromium page stays open, and a small HTTP
// control server on localhost takes commands, so a separate shell (curl) can
// drive a full solo match turn by turn through the real UI: pause, look
// (screenshot + visible text), act with real mouse/keyboard input, step the
// game forward N seconds, repeat. Debug-only: nothing here touches what
// normal players get.
//
//   node e2e/play.mjs [dist|URL]     (default dist; env: PORT, SHOTS, VIEWPORT)
//
//   curl "http://127.0.0.1:7357/start?race=open-source&seed=1234"
//   curl "http://127.0.0.1:7357/look"
//   curl "http://127.0.0.1:7357/advance?s=5"
//   curl "http://127.0.0.1:7357/click?x=700&y=430"
//   curl "http://127.0.0.1:7357/drag?x1=600&y1=300&x2=800&y2=500"
//   curl "http://127.0.0.1:7357/key?k=q"
//   curl "http://127.0.0.1:7357/quit"
//
// Every action answers with a look: a screenshot plus the text a player sees.
// Commands reach the game as real input only; window.uptime (?debug) is used
// for what a player can't do from outside: pause, advance, tick and outcome.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serve } from "./harness.mjs";

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const fail = (message) => {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
};

const PORT = Number(process.env.PORT ?? 7357);
const SHOTS = process.env.SHOTS ?? "shots/play";
const [width, height] = (process.env.VIEWPORT ?? "1440x900").split("x").map(Number);
if (!Number.isFinite(width) || !Number.isFinite(height)) fail(`bad VIEWPORT "${process.env.VIEWPORT}" (want WIDTHxHEIGHT, e.g. 1440x900)`);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) fail(`bad PORT "${process.env.PORT}"`);

// `dist` (or any directory) is served here; an http URL is driven as-is.
const target = process.argv[2] ?? "dist";
const direct = /^https?:\/\//.test(target);
const { server: staticServer, url: served } = direct ? { server: null, url: target } : await serve();
const base = direct ? target : served;
// `hq` keeps the full-quality 3D path under SwiftShader, so headless shots
// look like a real GPU's; `debug` exposes window.uptime for pause/advance.
const pageUrl = `${base}${base.includes("?") ? "&" : "?"}debug&hq`;

let turn = 0;
let leaving = false;
/** @type {import("playwright").Browser | undefined} */
let browser;
/** @type {import("playwright").Page | undefined} */
let page;

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
};

/** The look every action ends with: what's on screen, in pixels and in text. */
async function look() {
  turn += 1;
  const shot = join(SHOTS, `${turn}.png`);
  await page.screenshot({ path: shot });
  const seen = await page.evaluate(() => {
    const u = window.uptime;
    const text = (id) => (document.getElementById(id)?.innerText ?? "").trim();
    return {
      tick: u ? u.world.tick : null,
      time: text("uptime"),
      paused: u ? u.paused : null,
      outcome: u ? (u.world.outcome ?? null) : null,
      hud: text("hud"),
      info: text("info"),
      hint: text("hint"),
      // The banner is drawn in the game's canvas, not the DOM.
      banner: u ? u.renderer.bannerText : "",
      buildBar: text("build-bar"),
      heroBar: text("hero-card"),
      alerts: u ? u.alerts.recent.map((alert) => alert.text) : [],
      selection: u ? u.selection.kind : null,
    };
  });
  return { shot, ...seen };
}

const num = (params, name) => {
  const value = Number(params[name]);
  if (!Number.isFinite(value)) throw bad(`needs ?${name}= (a number, viewport pixels)`);
  return value;
};

/** Hold Shift/Ctrl under a real-input action, released even when it throws. */
async function withMods(params, fn) {
  const mods = [params.shift && "Shift", params.ctrl && "Control"].filter(Boolean);
  for (const mod of mods) await page.keyboard.down(mod);
  try {
    await fn();
  } finally {
    for (const mod of mods.reverse()) await page.keyboard.up(mod);
  }
}

const actions = {
  /** From the home screen: colour, race, hero (if asked), solo vs the botnet, paused. */
  async start(params) {
    if (!params.race) throw bad("needs ?race=<id> (e.g. open-source)");
    if (params.seed !== undefined && !Number.isInteger(Number(params.seed))) throw bad(`bad ?seed=${params.seed} (want an integer)`);
    // The game picks its map seed from ?seed= in the URL; there's no seed
    // picker in the UI, so a seeded start reloads the home screen with it.
    await page.goto(params.seed === undefined ? pageUrl : `${pageUrl}&seed=${params.seed}`);
    await page.waitForSelector("#race-picker:not([hidden])", { timeout: 60000 });
    if (params.color) {
      const swatch = await page.$(`.color-swatch[data-color="${params.color}"]`);
      if (!swatch) throw bad(`unknown ?color=${params.color}`);
      await swatch.click();
    }
    const playable = await page.evaluate(() => window.uptime.session.playable);
    if (!playable.includes(params.race)) throw bad(`unknown ?race=${params.race} (playable: ${playable.join(", ")})`);
    await page.click(`.race-card[data-race="${params.race}"]`);
    const heroes = await page.evaluate((race) => window.uptime.content.races[race]?.heroes ?? [], params.race);
    if (params.hero !== undefined && !heroes.includes(params.hero)) throw bad(`unknown ?hero=${params.hero} (${params.race}: ${heroes.join(", ") || "one fixed hero"})`);
    // A race with several heroes asks which one; anything else starts as-is.
    const hero = params.hero ?? (heroes.length > 1 ? heroes[0] : undefined);
    const card = hero ? await page.$(`.hero-card[data-hero="${hero}"]`) : null;
    if (card) await card.click();
    await page.click("#play-solo");
    await page.waitForFunction(() => window.uptime && window.uptime.session.builder() !== undefined, undefined, { timeout: 60000 });
    await page.evaluate(() => window.uptime.pause());
    return look();
  },

  look: () => look(),

  /** Real mouse click at viewport pixel coords (same coords as the shot). */
  async click(params) {
    const [x, y] = [num(params, "x"), num(params, "y")];
    const button = params.button ?? "left";
    if (button !== "left" && button !== "right") throw bad(`bad ?button=${button} (left|right)`);
    await withMods(params, () => page.mouse.click(x, y, { button, clickCount: params.double ? 2 : 1 }));
    return look();
  },

  /** Real drag: a box select from (x1,y1) to (x2,y2). */
  async drag(params) {
    const [x1, y1, x2, y2] = [num(params, "x1"), num(params, "y1"), num(params, "x2"), num(params, "y2")];
    await withMods(params, async () => {
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      await page.mouse.move(x2, y2, { steps: 8 });
      await page.mouse.up();
    });
    return look();
  },

  /** Real pointer move: hover, for tooltips and cards. */
  async move(params) {
    await page.mouse.move(num(params, "x"), num(params, "y"));
    return look();
  },

  /** Real key press: a Playwright key (q, Digit1, Escape, Space, Shift+A…). */
  async key(params) {
    if (!params.k) throw bad("needs ?k=<Playwright key> (e.g. q, Digit1, Escape)");
    await withMods(params, () => page.keyboard.press(params.k));
    return look();
  },

  /** Step the paused match forward: default 5 seconds of game time, at most 60. */
  async advance(params) {
    const seconds = params.s === undefined ? 5 : Number(params.s);
    if (!Number.isFinite(seconds) || seconds < 0) throw bad(`bad ?s=${params.s} (want seconds as a number)`);
    await page.evaluate((s) => window.uptime.advance(s), Math.min(seconds, 60));
    return look();
  },

  async quit() {
    leaving = true;
    return { bye: `shots in ${resolve(SHOTS)}` };
  },
};

const control = createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url ?? "/", "http://x");
  const params = Object.fromEntries(searchParams);
  Promise.resolve()
    .then(() => {
      const action = actions[pathname.slice(1)];
      if (!action) throw bad(`unknown endpoint ${pathname} (try /start /look /click /drag /move /key /advance /quit)`);
      return action(params);
    })
    .then(
      (value) => json(res, 200, value),
      (error) => json(res, error?.status ?? 500, { error: String(error?.message ?? error) }),
    )
    .then(async () => {
      if (!leaving) return;
      await browser?.close().catch(() => {});
      staticServer?.close();
      process.exit(0);
    });
});

try {
  await mkdir(SHOTS, { recursive: true });
  // SwiftShader so WebGL works headless; `hq` in the URL keeps the quality up.
  browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
  await page.goto(pageUrl);
  await page.waitForSelector("#race-picker:not([hidden])", { timeout: 60000 });
  await new Promise((done) => control.listen(PORT, "127.0.0.1", done));
  console.log(`play harness on http://127.0.0.1:${PORT} · driving ${pageUrl} at ${width}x${height}`);
  console.log(`shots in ${resolve(SHOTS)} · endpoints: /start /look /click /drag /move /key /advance /quit`);
} catch (error) {
  fail(String(error?.message ?? error));
}

process.on("SIGINT", () => {
  browser?.close().finally(() => process.exit(0));
});
