// The lobby in real browsers: Play vs computer starts a local match against
// computers; invites connect over both signalling paths, then one match
// (with a computer seat) runs in lockstep, stays in sync, and survives a
// guest leaving. Last, two strangers press Quick Match and land in one
// match. Lockstep rules themselves are covered in tests/lockstep.test.ts
// and the relay handlers in tests/invites.test.ts.
//
//   npm run build && node e2e/coop.mjs dist
//
// Uses the flat 2D view: two browsers rendering 3D in software starve a CI
// runner, and the smoke test covers 3D. The invite link keeps the query.

import { game, run, serve, waitFor } from "./harness.mjs";

// The invite relay, same HTTP contract as zero/server. Off: the client's
// POST 404s and it falls back to copy-paste codes.
let relayOn = false;
const invites = new Map();
let nextCode = 0;
/** Quick Match listings: code -> { version, since }. Heartbeat freshness is the relay's job (tests/invites.test.ts). */
const queue = new Map();
const { server, url } = await serve(async (req, res, path) => {
  if (!path.startsWith("/api/invites") && !path.startsWith("/api/queue")) return false;
  const send = (status, body) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)), true);
  if (!relayOn) return send(404, { error: "not_found" });
  const body = async () => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return JSON.parse(raw || "{}");
  };
  if (path.startsWith("/api/queue")) {
    const b = await body();
    for (const [code] of queue) if (invites.get(code)?.answer) queue.delete(code);
    const oldest = (version, than) =>
      [...queue].filter(([c, l]) => l.version === version && c !== than?.code && (!than || l.since < than.since)).sort((a, z) => a[1].since - z[1].since)[0]?.[0] ?? null;
    if (path === "/api/queue/find") return send(200, { code: oldest(b.version) });
    if (invites.get(b.code)?.key !== b.key) return send(404, { error: "not_found" });
    if (path === "/api/queue/leave") return queue.delete(b.code), send(200, { ok: true });
    if (!queue.has(b.code)) queue.set(b.code, { version: b.version, since: Date.now() });
    return send(200, { ok: true, join: oldest(b.version, { code: b.code, ...queue.get(b.code) }) });
  }
  const [, , code, sub] = path.split("/").filter(Boolean);
  const invite = invites.get(code);
  if (req.method === "POST" && !code) {
    const fresh = `CODE${String(nextCode++).padStart(2, "2")}`.slice(-6).replace(/[01]/g, "A");
    invites.set(fresh, { offer: (await body()).offer, answer: "", key: `k${fresh}` });
    return send(200, { code: fresh, key: `k${fresh}` });
  }
  if (!invite) return send(404, { error: "not_found" });
  if (req.method === "GET" && !sub) return send(200, { offer: invite.offer, taken: invite.answer !== "" });
  if (req.method === "POST" && sub === "answer") {
    if (invite.answer) return send(409, { error: "taken" });
    invite.answer = (await body()).answer;
    return send(200, { ok: true });
  }
  if (req.method === "GET" && sub === "answer" && new URL(req.url, "http://x").searchParams.get("key") === invite.key) {
    return send(200, { answer: invite.answer || null });
  }
  return send(404, { error: "not_found" });
});

await run(
  "co-op test",
  async ({ check, open }) => {
    /** Host invites, guest joins as Hyperscaler, host sees them. Returns both pages. */
    const connect = async (relay) => {
      relayOn = relay;
      const label = relay ? "relay" : "copy-paste";
      const host = await open(`${url}?debug&2d`);
      await host.waitForTimeout(500);
      await host.keyboard.press("h");
      const invite = await waitFor(() => host.$eval("#coop-invite", (el) => (el.value.startsWith("http") ? el.value : null)));
      const token = invite ? new URL(invite).hash.split("=")[1] ?? "" : "";
      check(relay ? /^[A-Z0-9]{6}$/.test(token) : token.length > 100, `${label}: the invite link carries ${relay ? "a short code" : "the whole offer"}`);
      const guest = await open(invite);
      await guest.selectOption("#coop-race", "hyperscaler");
      if (!relay) {
        const answer = await waitFor(() => guest.$eval("#coop-answer", (el) => el.value || null));
        await host.fill("#coop-reply", answer);
        await host.click("#coop-connect");
      }
      check(await waitFor(() => host.$eval("#coop-start", (el) => !el.disabled), 30000), `${label}: the host sees the guest join`);
      return { host, guest };
    };

    // Play vs computer: the same lobby, a computer in the next seat. With no
    // friend joined the match is played locally, so it can pause.
    {
      const solo = await open(`${url}?debug&2d`);
      await solo.waitForTimeout(500);
      await solo.keyboard.press("c");
      check(await waitFor(() => solo.$$eval(".coop-computer", (rows) => rows.length === 1)), "Play vs computer opens the lobby with a computer seated");
      await solo.selectOption(".coop-computer select[title='How well it plays']", "hard");
      await solo.click("#coop-add-computer");
      await solo.click("#coop-start");
      const seats = await waitFor(() =>
        solo.evaluate(() => (window.uptime.world.tick > 20 ? { net: window.uptime.session.net !== null, ai: window.uptime.world.teams.map((t) => t.ai?.difficulty ?? "-").join() } : null)),
      30000);
      check(seats && !seats.net && seats.ai.startsWith("-,hard,normal"), `you and two computers, played locally (${seats?.ai})`);
      check(await waitFor(async () => (await solo.textContent("#players")).includes("Computer 2 · Hard"), 10000), "the players panel names the computers");
      await solo.context().close();
    }

    // Copy-paste signalling (the handshake is the part that differs), then a
    // composed match: free-for-all, no horde, open alliances. The host's rules
    // reach the guest, and the two ally from the players panel.
    const paste = await connect(false);
    await paste.host.click('[data-preset="ffa"]');
    check(await paste.host.$eval("#coop-horde", (el) => !el.disabled), "with two sides, the horde is optional");
    await paste.host.uncheck("#coop-horde");
    await paste.host.check("#coop-open");
    await paste.host.click("#coop-start");
    const rules = (page) =>
      page.evaluate(() => ({ rules: JSON.stringify(window.uptime.world.rules), races: window.uptime.world.teams.map((t) => t.raceId).join() }));
    const ffa = await waitFor(async () => {
      const [h, g] = [await rules(paste.host), await rules(paste.guest)];
      return h.rules.includes('"open"') && h.rules === g.rules && h.races === g.races ? h : null;
    }, 60000);
    check(ffa && !ffa.races.includes("botnet"), `both browsers start the same composed match, no horde (${ffa?.races} ${ffa?.rules})`);
    check(await waitFor(async () => (await paste.guest.textContent("#status")).includes("Custom rules"), 30000), "the HUD names the rules");
    for (const page of [paste.host, paste.guest]) {
      await waitFor(() => page.$eval("#players", (el) => !el.hidden && el.querySelector("button") !== null), 30000);
      await page.click("#players button");
    }
    const allied = (page) => page.evaluate(() => window.uptime.world.allies.join());
    check(await waitFor(async () => (await allied(paste.host)) === "3,3" && (await allied(paste.guest)) === "3,3", 30000), "both click Ally: they're allied in both worlds");
    check(await waitFor(async () => (await paste.guest.textContent("#players")).includes("Ally"), 10000), "the players panel shows the alliance");
    await paste.host.context().close();
    await paste.guest.context().close();

    // Relay signalling, then the whole match.
    // A computer takes the third seat: every browser plays it the same.
    const { host, guest } = await connect(true);
    await host.click("#coop-add-computer");
    await host.click("#coop-start");
    check(await waitFor(() => guest.evaluate(() => window.uptime.world.tick > 20), 60000), "the match starts in both browsers");
    const who = (page) =>
      page.evaluate(() => ({ local: window.uptime.session.local, races: window.uptime.world.teams.map((t) => t.raceId).join(), ai: window.uptime.world.teams[2]?.ai?.difficulty }));
    const [h, g] = [await who(host), await who(guest)];
    check(h.local === 0 && g.local === 1 && h.races === g.races, `each browser plays its own team in the same match (${h.races})`);
    check(h.ai === "normal" && g.ai === "normal", "the computer seat reaches the guest");

    // Each player founds its core with real input; both worlds see both.
    for (const page of [host, guest]) {
      const { toPage, home } = game(page);
      const at = await home();
      const p = await toPage(at.x, at.y);
      await page.keyboard.press("c");
      await page.mouse.move(p.x, p.y);
      await page.mouse.click(p.x, p.y);
    }
    const cores = (page) => page.evaluate(() => window.uptime.world.teams.slice(0, 3).every((t) => t.coreId !== -1));
    check(await waitFor(async () => (await cores(host)) && (await cores(guest)), 120000), "each player's deploy (and the computer's) reaches both worlds");

    // Lockstep compares world hashes every 100 ticks.
    const synced = await waitFor(() => host.evaluate(() => window.uptime.session.net.hashChecks >= 1), 240000);
    const desync = await Promise.all([host, guest].map((p) => p.evaluate(() => window.uptime.session.net.desyncTick)));
    check(synced && desync.every((d) => d === null), "the worlds stay in sync");

    // The guest switches tabs: no frames there, but the match keeps going for
    // both, since the host can only step once the guest's turns arrive.
    await guest.evaluate(() => {
      window.uptime.renderer.app.ticker.stop();
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
    });
    const before = await Promise.all([host, guest].map((p) => p.evaluate(() => window.uptime.world.tick)));
    const onward = await waitFor(async () => {
      const now = await Promise.all([host, guest].map((p) => p.evaluate(() => window.uptime.world.tick)));
      return now[0] > before[0] + 100 && now[1] > before[1] + 100;
    }, 60000);
    check(onward, "a hidden tab keeps the co-op match running for everyone");
    await guest.evaluate(() => {
      delete document.hidden;
      window.uptime.renderer.app.ticker.start();
    });

    // The guest leaves: the host plays on.
    await guest.context().close();
    const tick = await host.evaluate(() => window.uptime.world.tick);
    check(await waitFor(() => host.evaluate((t) => window.uptime.world.tick > t + 40, tick), 120000), "the host plays on after the guest leaves");
    await host.context().close();

    // Quick Match: two strangers press Q. The first finds nobody and hosts;
    // the second finds them. Co-op against the botnet, started on its own.
    const first = await open(`${url}?debug&2d`);
    await first.waitForTimeout(500);
    await first.keyboard.press("q");
    check(await waitFor(async () => (await first.textContent("#coop-status"))?.includes("Waiting for players"), 30000), "quick match: nobody around, so the first player hosts");
    check(await waitFor(() => queue.size === 1, 15000), "quick match: the host is listed");
    const second = await open(`${url}?debug&2d`);
    await second.waitForTimeout(500);
    await second.keyboard.press("q");
    check(await waitFor(async () => (await first.textContent("#coop-status"))?.includes("Starting in"), 30000), "quick match: the second player joins the first, and a countdown starts");
    const playing = (page) => page.evaluate(() => ({ net: window.uptime.session.net !== null, tick: window.uptime.world.tick, local: window.uptime.session.local, races: window.uptime.world.teams.map((t) => t.raceId).join(), rules: JSON.stringify(window.uptime.world.rules) }));
    const both = await waitFor(async () => {
      const [a, b] = [await playing(first), await playing(second)];
      return a.net && b.net && a.tick > 20 && b.tick > 20 ? [a, b] : null;
    }, 60000);
    check(
      both && both[0].local === 0 && both[1].local === 1 && both[0].races === both[1].races && both[0].races.endsWith("botnet") && both[0].rules.includes('"sides":[0,0]'),
      `quick match: it starts on its own, one co-op match in both browsers (${both?.[0].races})`,
    );
  },
  {
    // Real host candidates instead of mDNS names, so two headless contexts reach each other.
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
    // With the relay off, the client learns it by its POST 404ing: that's the fallback working.
    ignoreError: (m) => !relayOn && m.location().url.includes("/api/invites"),
  },
);

server.close();
