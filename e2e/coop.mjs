// Two browsers, one co-op match: the host invites, the guest replies, they
// connect over WebRTC, and both play the same world.
//
//   npm run build && node e2e/coop.mjs dist            # copy-paste invites
//   npm run build && node e2e/coop.mjs dist --relay    # short codes via the invite relay
//
// --relay serves the same HTTP contract as zero/server (tested on the real
// handlers in tests/invites.test.ts) from this process.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? "dist");
const RELAY = process.argv.includes("--relay");
const invites = new Map();
let nextCode = 0;

async function relay(req, res, path) {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const body = async () => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return JSON.parse(raw || "{}");
  };
  const parts = path.split("/").filter(Boolean);
  const invite = invites.get(parts[2]);
  if (req.method === "POST" && parts.length === 2) {
    const code = `CODE${String(nextCode++).padStart(2, "2")}`.slice(-6).replace(/[01]/g, "A");
    invites.set(code, { offer: (await body()).offer, answer: "", key: "k" + code });
    return send(200, { code, key: "k" + code });
  }
  if (!invite) return send(404, { error: "not_found" });
  if (req.method === "GET" && parts.length === 3) return send(200, { offer: invite.offer, taken: invite.answer !== "" });
  if (req.method === "POST" && parts[3] === "answer") {
    if (invite.answer) return send(409, { error: "taken" });
    invite.answer = (await body()).answer;
    return send(200, { ok: true });
  }
  if (req.method === "GET" && parts[3] === "answer") {
    if (new URL(req.url, "http://x").searchParams.get("key") !== invite.key) return send(404, { error: "not_found" });
    return send(200, { answer: invite.answer || null });
  }
  send(404, { error: "not_found" });
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (RELAY && path.startsWith("/api/invites")) return relay(req, res, path);
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
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};
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

// Real host candidates instead of mDNS names, so two headless contexts can reach each other.
const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-features=WebRtcHideLocalIpsWithMdns"],
});
const errors = [];
const open = async (url) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.waitForSelector("canvas", { timeout: 20000 });
  return page;
};
const base = `http://127.0.0.1:${server.address().port}/?debug`;

try {
  // 1. Host opens co-op and gets an invite link.
  const host = await open(base);
  await page_key(host, "h");
  const invite = await waitFor(() => host.$eval("#coop-invite", (el) => (el.value.startsWith("http") ? el.value : null)), 15000);
  check(Boolean(invite), "host gets an invite link");

  const token = new URL(invite).hash.split("=")[1] ?? "";
  if (RELAY) check(/^[A-Z0-9]{6}$/.test(token), `the invite link carries a short code (${token})`);
  else check(token.length > 100, "the invite link carries the whole offer");

  // 2. Guest opens the link and picks a race.
  const guest = await open(invite);
  await guest.selectOption("#coop-race", "hyperscaler");
  if (RELAY) {
    // 3. The relay carries the answer back: nobody pastes anything.
    check(await guest.$eval("#coop-answer-row", (el) => el.hidden), "the guest isn't asked to send a reply code");
  } else {
    // 3. The guest gets a reply code; the host pastes it in.
    const answer = await waitFor(() => guest.$eval("#coop-answer", (el) => el.value || null), 15000);
    check(Boolean(answer), "guest gets a reply code");
    await host.fill("#coop-reply", answer);
    await host.click("#coop-connect");
  }
  const ready = await waitFor(() => host.$eval("#coop-start", (el) => !el.disabled), 20000);
  check(ready, "host sees the guest join");
  check(
    (await guest.textContent("#coop-status")).includes("Waiting for the host"),
    "guest is told to wait for the host",
  );

  // 4. Start: both browsers run the same match, each as its own player.
  await host.click("#coop-start");
  const started = await waitFor(
    () => guest.evaluate(() => window.uptime.session.net !== null && window.uptime.world.tick > 40),
    60000,
  );
  check(started, "the match starts on both browsers");
  const setup = (page) =>
    page.evaluate(() => ({
      local: window.uptime.session.local,
      seed: window.uptime.world.seed,
      races: window.uptime.world.teams.map((t) => t.raceId).join(","),
    }));
  const [h, g] = [await setup(host), await setup(guest)];
  check(h.local === 0 && g.local === 1, `each browser plays its own team (${h.local}, ${g.local})`);
  check(h.seed === g.seed && h.races === g.races, `same map and races (${h.races})`);

  // 5. Each player deploys its core with real input; both see both cores.
  for (const page of [host, guest]) {
    const at = await page.evaluate(() => {
      const { world, session, renderer } = window.uptime;
      const agent = world.entities.find((e) => e.id === world.teams[session.local].builderId);
      const c = renderer.camera;
      return { x: (agent.x - c.x) * c.zoom + renderer.app.screen.width / 2, y: (agent.y - c.y) * c.zoom + renderer.app.screen.height / 2 };
    });
    const box = await (await page.$("canvas")).boundingBox();
    await page.keyboard.press("c");
    await page.mouse.move(box.x + at.x, box.y + at.y);
    await page.mouse.click(box.x + at.x, box.y + at.y);
  }
  const cores = (page) => page.evaluate(() => window.uptime.world.teams.slice(0, 2).map((t) => t.coreId !== -1));
  const both = await waitFor(async () => (await cores(host)).every(Boolean) && (await cores(guest)).every(Boolean), 120000);
  check(both, "each player's deploy reaches the other's world");

  // 6. Their worlds agree: lockstep compares hashes every 100 ticks.
  const checked = await waitFor(
    // CI renders in software at a fraction of real time: budget generously.
    () => host.evaluate(() => window.uptime.session.net.hashChecks >= 3),
    240000,
  );
  const sync = async (page) => page.evaluate(() => ({ desync: window.uptime.session.net.desyncTick, checks: window.uptime.session.net.hashChecks }));
  const [hs, gs] = [await sync(host), await sync(guest)];
  check(Boolean(checked) && hs.desync === null && gs.desync === null, `worlds stay in sync (${hs.checks} + ${gs.checks} hash checks, no desync)`);
  check((await host.textContent("#status")).includes("Player 1"), "the HUD says you're in co-op");

  // 7. The guest leaves: the host plays on.
  await guest.context().close();
  const tick = await host.evaluate(() => window.uptime.world.tick);
  const playsOn = await waitFor(() => host.evaluate((t) => window.uptime.world.tick > t + 40, tick), 120000);
  const after = await host.evaluate(() => ({ tick: window.uptime.world.tick, waiting: window.uptime.session.waitingOn(), status: document.querySelector("#status").textContent }));
  check(playsOn, `the host plays on after the guest leaves (${JSON.stringify(after)})`);
} catch (error) {
  check(false, `co-op test crashed: ${error.message}`);
} finally {
  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  await browser.close();
  server.close();
}

async function page_key(page, key) {
  await page.waitForTimeout(500);
  await page.keyboard.press(key);
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`\ncoop test passed (${RELAY ? "relay" : "copy-paste"})`);
