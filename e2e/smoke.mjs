// Smoke test of the built game: boot the 3D view, then drive the opening
// with real clicks and keys and check each one reaches the game.
//
//   npm run build && node e2e/smoke.mjs dist      (SEED=n for another map)
//
// See harness.mjs for what belongs here and what doesn't.

import { SEED, game, run, serve, waitFor } from "./harness.mjs";

const { server, url } = await serve();

await run("smoke test", async ({ check, open }) => {
  console.log(`seed ${SEED}`);
  const page = await open(`${url}?debug&seed=${SEED}`, { width: 1600, height: 900 });
  const { state, toPage, home, openNear } = game(page);
  /** Click a world point; `hold` a modifier key while clicking (mouse.click has no modifiers option). */
  const click = async (point, options, hold) => {
    const p = await toPage(point.x, point.y);
    await page.mouse.move(p.x, p.y);
    if (hold) await page.keyboard.down(hold);
    await page.mouse.click(p.x, p.y, options);
    if (hold) await page.keyboard.up(hold);
  };

  // Boot: 3D by default, race picker with colours.
  check((await page.$$eval("#stage canvas", (c) => c.length)) === 2, "the 3D view boots (WebGL canvas + overlay)");
  await page.click('.color-swatch[data-color="purple"]');
  check(await state(() => window.uptime.session.color.id === "purple"), "a colour swatch picks the colour");
  // Home screen: the match's HUD steps aside; a race is picked, then how to play.
  check(await page.$eval("#hud", (el) => getComputedStyle(el).visibility === "hidden"), "the home screen hides the match HUD");
  await page.keyboard.press("2");
  check(
    await state(() => window.uptime.session.raceId === window.uptime.session.playable[1] && !document.querySelector("#race-picker").hidden),
    "a number key picks a race without starting anything",
  );
  check(await page.$eval(".race-card.chosen", (el) => el.dataset.race === window.uptime.session.playable[1]), "the picked race's card is marked");
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  // One hero per race: no hero step.
  check(await waitFor(() => state(() => window.uptime.session.builder() !== undefined && window.uptime.session.raceId === window.uptime.session.playable[0])), "Enter plays solo as the picked race");
  check(await page.$eval("#hud", (el) => getComputedStyle(el).visibility === "visible"), "the HUD is back in the match");
  const heroes = [await state(() => window.uptime.content.races[window.uptime.session.raceId].heroes[0])];

  // Deploy: the agent starts selected; a click walks it; C + click founds the core.
  const agent = await home();
  check(await state((id) => window.uptime.selection.id === id, agent.id), "the deploy agent starts selected");
  const known = await state(() => {
    const u = window.uptime;
    const nest = u.world.entities.find((e) => e.id === u.world.teams[u.world.teams.length - 1].coreId);
    const fog = u.renderer.fog;
    let dark = 0;
    for (let i = 0; i < u.world.terrain.tiles.length; i++) if (fog.stateAt(i) === 0) dark++;
    return dark === 0 && fog.isExplored(nest.x, nest.y) && !fog.isVisible(nest.x, nest.y);
  });
  check(known, "the whole map and the nest's spot are known, but the nest isn't in sight");
  const walk = await openNear(agent.x, agent.y, 4, 8);
  await click(walk);
  const heading = await waitFor(() => state(() => window.uptime.world.entities.find((e) => e.mode === "builder")?.moveTo));
  check(heading && Math.hypot(heading.x - walk.x, heading.y - walk.y) < 30, "clicking the ground walks the agent");
  await page.keyboard.press("c");
  await click(await home());
  check(await waitFor(() => state(() => window.uptime.session.core() !== undefined), 60000), "C + click founds the core");
  const countdown = await waitFor(() => page.$eval("#countdown", (el) => (el.hidden ? null : el.textContent)));
  check(/hits your base in\s*[01]:\d\d/.test(countdown ?? ""), `a countdown to the first incident shows (${countdown})`);

  // Sound: the first click unlocked audio, founding played its cue, M cycles on / effects / off.
  check(await waitFor(() => state(() => window.uptime.sound.running)), "audio starts after the first click");
  check(await waitFor(() => state(() => (window.uptime.sound.played.get("founded") ?? 0) > 0)), "founding the core plays a sound");
  const modes = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("m");
    modes.push(await page.textContent("#sound"));
  }
  check(modes.join() === "Sound: effects,Sound: off,Sound: on", `M cycles the sound mode (${modes.join(" → ")})`);

  // HUD: income, wave preview, the race's build bar.
  // Alerts: an off-screen hit on your core raises one, and Space jumps the camera to it.
  const alerted = await state(() => {
    const u = window.uptime;
    const core = u.session.core();
    u.renderer.camera.centerOn(core.x + 3000, core.y);
    u.alerts.update(u.world, [{ type: "shot", from: 999, to: core.id, x1: 0, y1: 0, x2: core.x, y2: core.y, team: 1 }], u.session.local, performance.now() / 1000, () => false);
    return u.alerts.recent.length;
  });
  check(alerted > 0, "an off-screen hit on your core raises an alert");
  await page.keyboard.press("Space");
  check(await waitFor(() => state(() => Math.abs(window.uptime.renderer.camera.x - window.uptime.session.core().x) < 50)), "Space jumps the camera to the alert");
  check(/^\+[\d.]+\/s$/.test(await page.textContent("#income")), "the HUD shows income");
  check(/^\d+ \/ \d+/.test(await page.textContent("#compute")), `the HUD shows compute in use / supplied (${await page.textContent("#compute")})`);
  // Laptop width with a late-game HUD (a long creep list, compute over): the
  // game still fits the window, minimap and build bar included.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => {
    document.querySelector("#preview-creeps").textContent = "Bot · Worm · Trojan · Port Scanner · Phisher · DDoS Node · Cryptominer · Rootkit · Ransomware BOSS";
  });
  const fit = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, bar: document.querySelector("#build-bar").getBoundingClientRect().height }));
  check(fit.page <= 1280 && fit.bar < 80, `the HUD fits a 1280px window on one row each (${fit.page}px wide, bar ${Math.round(fit.bar)}px)`);
  await page.setViewportSize({ width: 1600, height: 900 });
  check((await page.textContent("#preview-title")).startsWith("Next: ") && (await page.getAttribute("#preview-title", "title")) === "Incident 1", "the HUD previews the next incident");
  check((await page.$$eval(".build-btn", (b) => b.length)) >= 4, "the build bar shows the race's buildings");

  // Build a spawner with a number key and a click, then select it.
  const core = await home();
  const spot = await openNear(core.x, core.y, 2, 5);
  await page.keyboard.press("1");
  await click(spot);
  const spawner = await waitFor(() =>
    state(() => window.uptime.world.entities.find((e) => e.kind === "building" && e.team === window.uptime.session.local && window.uptime.content.buildings[e.defId].spawn)?.id),
  );
  check(Boolean(spawner), "a number key + click places a spawner");
  await click(spot);
  check(await waitFor(() => state((id) => window.uptime.selection.id === id, spawner)), "clicking a building selects it");

  // Open Source forks: X on a selected building, then a click places a half-price copy.
  const racks = () => state((def) => window.uptime.world.entities.filter((e) => e.kind === "building" && e.defId === def).length, "server-rack");
  const before = await racks();
  // Only a finished building can be forked.
  await waitFor(() => state((id) => window.uptime.world.entities.find((e) => e.id === id)?.buildRemaining === 0, spawner), 60000);
  await page.keyboard.press("x");
  check(await state(() => window.uptime.selection.kind === "place" && window.uptime.selection.fork !== undefined), "X starts forking the selected building");
  await click(await openNear(spot.x, spot.y, 2, 5));
  check(await waitFor(async () => (await racks()) === before + 1), "a click places the fork");
  await click(spot);
  await waitFor(() => state((id) => window.uptime.selection.id === id, spawner));

  // Every way to give a rally order: right-click, T then click, Ctrl-click, Cmd-click.
  const rallies = [
    ["right-click", (p) => click(p, { button: "right" })],
    ["T + click", async (p) => (await page.keyboard.press("t"), click(p))],
    ["Ctrl-click", (p) => click(p, {}, "Control")],
    ["Cmd-click", (p) => click(p, {}, "Meta")],
  ];
  for (const [i, [name, give]] of rallies.entries()) {
    const target = await openNear(spot.x, spot.y, 3 + i * 2, 12);
    await give(target);
    const set = await waitFor(() =>
      state(([id, x, y]) => {
        const r = window.uptime.world.entities.find((e) => e.id === id)?.rally;
        return r && Math.hypot(r.x - x, r.y - y) < 40;
      }, [spawner, target.x, target.y]),
    );
    check(set, `${name} sets the rally`);
  }

  // Several spawners at once: Shift-click the fork onto the selection, then one right-click rallies both.
  const fork = await state(
    (id) => {
      const f = window.uptime.world.entities.find((e) => e.kind === "building" && e.defId === "server-rack" && e.id !== id);
      return f && { id: f.id, x: f.x, y: f.y };
    },
    spawner,
  );
  await page.waitForTimeout(400);
  await click(fork, {}, "Shift");
  check(
    await waitFor(() => state((ids) => window.uptime.selection.kind === "buildings" && ids.every((id) => window.uptime.selection.ids.includes(id)), [spawner, fork.id])),
    "Shift-click adds a second spawner to the selection",
  );
  const both = await openNear(spot.x, spot.y, 9, 16);
  await click(both, { button: "right" });
  const rallied = await waitFor(() =>
    state(
      ([ids, x, y]) => ids.every((id) => {
        const r = window.uptime.world.entities.find((e) => e.id === id)?.rally;
        return r && Math.hypot(r.x - x, r.y - y) < 40;
      }),
      [[spawner, fork.id], both.x, both.y],
    ),
  );
  check(rallied, "right-click rallies every selected spawner");

  // Delete twice decommissions: the first press only asks.
  await page.keyboard.press("Escape");
  await click(fork);
  await waitFor(() => state((id) => window.uptime.selection.id === id, fork.id));
  const cash = await state(() => window.uptime.session.team.money);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  check(await state((id) => window.uptime.world.entities.some((e) => e.id === id), fork.id), "one Delete only asks to decommission");
  await page.keyboard.press("Delete");
  check(
    await waitFor(() => state(([id, before]) => !window.uptime.world.entities.some((e) => e.id === id) && window.uptime.session.team.money > before, [fork.id, cash])),
    "a second Delete decommissions the building and refunds part of it",
  );
  await click(spot);
  await waitFor(() => state((id) => window.uptime.selection.id === id, spawner));

  // The hero you picked: Q selects it, + learns, right-click moves it, 1 casts.
  await page.keyboard.press("Escape");
  const hero = await state(() => {
    const t = window.uptime.session.team;
    const h = window.uptime.world.entities.find((e) => e.id === t.hero?.unitId);
    return h && { id: h.id, defId: h.defId, x: h.x, y: h.y };
  });
  check(hero?.defId === heroes[0], `the race's hero is on the field (${hero?.defId})`);
  await page.keyboard.press("q");
  check(await waitFor(() => state((id) => window.uptime.selection.id === id, hero.id)), "Q selects the hero");
  const abilities = await waitFor(() => page.$$eval(".ability-btn", (b) => (b.length === 4 ? b.map((x) => x.dataset.ability) : null)), 60000);
  check(abilities?.length === 4, `the hero's card shows its 4 abilities (${abilities?.join(", ")})`);
  await page.click(`.ability-btn[data-ability="${abilities[0]}"] .learn`, { timeout: 60000 });
  check(await waitFor(() => state((a) => window.uptime.session.team.hero.ranks[a] === 1, abilities[0])), "the + learns an ability");
  const heroTo = await openNear(hero.x, hero.y, 3, 7);
  await click(heroTo, { button: "right" });
  const moving = await waitFor(() => state(([id, x, y]) => {
    const h = window.uptime.world.entities.find((e) => e.id === id);
    return h && ((h.moveTo && Math.hypot(h.moveTo.x - x, h.moveTo.y - y) < 30) || Math.hypot(h.x - x, h.y - y) < 20);
  }, [hero.id, heroTo.x, heroTo.y]));
  check(moving, "right-click moves the hero");
  await page.keyboard.press("1");
  // Aimed abilities want a click; an enemy-target one with nobody around just asks for an enemy.
  const kind = await state((a) => window.uptime.content.heroes.abilities[a].target, abilities[0]);
  if (await state(() => window.uptime.selection.kind === "cast")) await click(await openNear(heroTo.x, heroTo.y, 1, 3));
  const cast = kind === "enemy" || (await waitFor(() => state((a) => (window.uptime.session.team.hero.cooldowns[a] ?? 0) > 0, abilities[0])));
  check(cast, `1 casts the first ability (${kind})`);
  await page.keyboard.press("Escape");

  // Army: drag a box over the spawner's units, right-click: they attack-move
  // there. F + click is a plain move; Z grabs the whole army.
  await page.keyboard.press("Escape");
  // Wait until they've reached the rally and stopped, so the box lands on them.
  const unitsOf = () =>
    state((id) => window.uptime.world.entities.filter((e) => e.kind === "unit" && e.spawnerId === id).map((u) => ({ id: u.id, x: u.x, y: u.y })), spawner);
  let units = [];
  await waitFor(async () => {
    const before = await unitsOf();
    await page.waitForTimeout(1000);
    units = await unitsOf();
    return units.length > 0 && units.every((u) => before.some((b) => b.id === u.id && Math.hypot(b.x - u.x, b.y - u.y) < 2));
  }, 120000);
  const corners = await Promise.all(units.map((u) => toPage(u.x, u.y)));
  const [x1, y1] = [Math.min(...corners.map((c) => c.x)) - 40, Math.min(...corners.map((c) => c.y)) - 40];
  const [x2, y2] = [Math.max(...corners.map((c) => c.x)) + 40, Math.max(...corners.map((c) => c.y)) + 40];
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 6 });
  check(await page.$eval("#select-box", (el) => !el.hidden), "dragging draws a selection box");
  await page.mouse.up();
  const ids = await state(() => (window.uptime.selection.kind === "army" ? window.uptime.selection.ids : []));
  check(units.length > 0 && units.every((u) => ids.includes(u.id)), `a selection box grabs your units (${ids.length})`);
  const orders = (target) =>
    state(([ids, x, y]) => window.uptime.world.entities.filter((e) => ids.includes(e.id)).map((u) => ({ order: u.order, d: Math.hypot(u.homeX - x, u.homeY - y) })), [ids, target.x, target.y]);
  const there = await openNear(spot.x, spot.y, 6, 14);
  await click(there, { button: "right" });
  check(await waitFor(async () => (await orders(there)).length > 0 && (await orders(there)).every((u) => u.order === "attack" && u.d < 160)), "right-click attack-moves the group");
  await page.keyboard.press("f");
  const back = await openNear(core.x, core.y, 3, 6);
  await click(back);
  check(await waitFor(async () => (await orders(back)).length > 0 && (await orders(back)).every((u) => u.order === "move" && u.d < 160)), "F + click moves the group");
  await page.keyboard.press("Escape");
  await page.keyboard.press("z");
  check(await state(() => window.uptime.selection.kind === "army" && window.uptime.selection.ids.length > 0), "Z selects the whole army");
  // Control groups: Alt+1 saves the army, Esc clears, 1 brings it back. Shift+right-click queues.
  await page.keyboard.press("Alt+Digit1");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Digit1");
  check(await state(() => window.uptime.selection.kind === "army" && window.uptime.selection.ids.length > 0), "Alt+1 saves a group and 1 brings it back");
  const far = await openNear(spot.x, spot.y, 8, 16);
  await click(there, { button: "right" });
  await page.keyboard.down("Shift");
  await click(far, { button: "right" });
  await page.keyboard.up("Shift");
  check(
    await waitFor(() => state(() => window.uptime.world.entities.some((e) => window.uptime.selection.ids?.includes(e.id) && (e.waypoints?.length ?? 0) > 0))),
    "Shift+right-click queues an order",
  );

  // Spawner ranks: gated on Data Center, then U upgrades the selected spawner in place.
  await page.keyboard.press("Escape");
  await click(spot);
  await waitFor(() => state((id) => window.uptime.selection.id === id, spawner));
  const rankButton = () => page.evaluate(() => {
    const b = document.getElementById("info-rank");
    return b && !b.hidden ? { text: b.textContent, disabled: b.disabled } : null;
  });
  const gated = await waitFor(async () => (await rankButton())?.text.includes("needs Data Center") && (await rankButton()));
  check(Boolean(gated?.disabled), "a spawner's rank button waits for Data Center");
  await state(() => {
    const t = window.uptime.session.team;
    t.upgrades[Object.keys(window.uptime.content.upgrades).find((u) => window.uptime.content.upgrades[u].stat === "tier")] = 1;
    t.money += 2000;
  });
  check(Boolean(await waitFor(async () => (await rankButton())?.text.startsWith("Upgrade to") && !(await rankButton()).disabled)), "at Data Center the rank button offers the upgrade");
  await page.keyboard.press("u");
  check(await waitFor(() => state((id) => (window.uptime.world.entities.find((e) => e.id === id)?.refitRemaining ?? 0) > 0, spawner)), "U starts the rank-up");

  // The core's card researches.
  await page.keyboard.press("Escape");
  await state(() => (window.uptime.session.team.money += 1000));
  await click(core);
  check(await waitFor(() => state((id) => window.uptime.selection.id === id, core.id)), "clicking the core selects it");
  // CI renders in software: the command card can take a while to redraw.
  await page.click(".upgrade-btn:not([disabled])", { timeout: 60000 });
  check(await waitFor(() => state(() => window.uptime.session.team.research !== null)), "the core's card starts research");

  // The upgrade center: build it, select it, and its card researches the army at the same time.
  await page.keyboard.press("Escape");
  await state(() => (window.uptime.session.team.money += 2000));
  const centerId = await state(() => window.uptime.session.race.center);
  const centerKey = await state((id) => String(window.uptime.session.race.buildings.indexOf(id) + 1), centerId);
  const lab = await openNear(core.x, core.y, 3, 7);
  await page.keyboard.press(centerKey);
  await click(lab);
  const labId = await waitFor(
    () => state((id) => window.uptime.world.entities.find((e) => e.defId === id && e.buildRemaining <= 0)?.id, centerId),
    120000,
  );
  check(Boolean(labId), `a number key + click builds the upgrade center (${centerId})`);
  await click(lab);
  check(await waitFor(() => state((id) => window.uptime.selection.id === id, labId)), "clicking the upgrade center selects it");
  await page.click(".upgrade-btn:not([disabled])", { timeout: 60000 });
  check(
    await waitFor(() => state(() => window.uptime.session.team.labResearch !== null && window.uptime.session.team.research !== null)),
    "its card starts army research alongside the core's",
  );

  // The Guide opens, pauses the match, and closes.
  await page.keyboard.press("g");
  const t0 = await state(() => window.uptime.world.tick);
  await page.waitForTimeout(1000);
  check(!(await page.$eval("#guide", (el) => el.hidden)) && t0 === (await state(() => window.uptime.world.tick)), "G opens the Guide and pauses");
  await page.keyboard.press("Escape");
  check(await page.$eval("#guide", (el) => el.hidden), "Esc closes the Guide");
});

server.close();
