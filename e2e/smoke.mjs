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

  // The core's card researches.
  await page.keyboard.press("Escape");
  await state(() => (window.uptime.session.team.compute += 1000));
  await click(core);
  await page.click(".upgrade-btn:not([disabled])", { timeout: 10000 });
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
