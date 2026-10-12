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
  await page.keyboard.press("1");
  // The race's heroes come next: take the second.
  const heroes = await waitFor(() => page.$$eval(".hero-card", (c) => (c.length ? c.map((x) => x.dataset.hero) : null)));
  check(heroes?.length >= 3, `picking a race offers its heroes (${heroes?.join(", ")})`);
  await page.keyboard.press("2");

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

  // HUD: income, wave preview, the race's build bar.
  check(/^\+[\d.]+\/s$/.test(await page.textContent("#income")), "the HUD shows income");
  check((await page.textContent("#preview-title")).startsWith("Wave 1"), "the HUD previews the next wave");
  check((await page.$$eval(".build-btn", (b) => b.length)) >= 4, "the build bar shows the race's buildings");

  // Build a spawner with a number key and a click, then select it.
  const core = await home();
  const spot = await openNear(core.x, core.y, 2, 5);
  await page.keyboard.press("1");
  await click(spot);
  const spawner = await waitFor(() =>
    state(() => window.uptime.world.entities.find((e) => e.kind === "building" && window.uptime.content.buildings[e.defId].spawn)?.id),
  );
  check(Boolean(spawner), "a number key + click places a spawner");
  await click(spot);
  check(await waitFor(() => state((id) => window.uptime.selection.id === id, spawner)), "clicking a building selects it");

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

  // The hero you picked: Q selects it, + learns, right-click moves it, 1 casts.
  await page.keyboard.press("Escape");
  const hero = await state(() => {
    const t = window.uptime.session.team;
    const h = window.uptime.world.entities.find((e) => e.id === t.hero?.unitId);
    return h && { id: h.id, defId: h.defId, x: h.x, y: h.y };
  });
  check(hero?.defId === heroes[1], `the hero you picked is on the field (${hero?.defId})`);
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

  // The core's card researches.
  await page.keyboard.press("Escape");
  await state(() => (window.uptime.session.team.compute += 1000));
  await click(core);
  check(await waitFor(() => state((id) => window.uptime.selection.id === id, core.id)), "clicking the core selects it");
  // CI renders in software: the command card can take a while to redraw.
  await page.click(".upgrade-btn:not([disabled])", { timeout: 60000 });
  check(await waitFor(() => state(() => window.uptime.session.team.research !== null)), "the core's card starts research");

  // The Guide opens, pauses the match, and closes.
  await page.keyboard.press("g");
  const t0 = await state(() => window.uptime.world.tick);
  await page.waitForTimeout(1000);
  check(!(await page.$eval("#guide", (el) => el.hidden)) && t0 === (await state(() => window.uptime.world.tick)), "G opens the Guide and pauses");
  await page.keyboard.press("Escape");
  check(await page.$eval("#guide", (el) => el.hidden), "Esc closes the Guide");
});

server.close();
