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

  // Army: drag a box over the spawner's units, right-click: they attack-move
  // there. F + click is a plain move; Q grabs the whole army.
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
  await page.keyboard.press("q");
  check(await state(() => window.uptime.selection.kind === "army" && window.uptime.selection.ids.length > 0), "Q selects the whole army");

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
