# Uptime Wars

Survival on the open web, in the browser. Every match generates a fresh patch
of the internet from a seed: dead links, data swamps, data wells, and a
malware nest somewhere far off-screen. Build around your core, let your racks
fork defenders, and keep your uptime while packs of crawlers wander the web.

> Prototype. Balance, art, and most of the design are placeholders.

## Play

```sh
npm install
npm run dev
```

- You start with a **deploy agent**, not a base. Right-click to move it and
  scout through the fog; press `C` (or the button) and click to choose where
  your core goes. The agent walks there and becomes the core. Lose the agent
  first and it's over.
- `1`-`4` or click: pick a building. Click near your core (the ring shows your
  build radius) to place it. Shift-click to place several.
- `WASD` / arrows, drag, or the very edge of the window: pan (`E` toggles edge
  scroll). Wheel: zoom. Click the minimap to jump. `Space` / `H`: back home.
- Right-click / `Esc`: cancel. `P`: pause. `R`: new map after a match.

The map starts black. You see what your agent, units, and buildings can see;
places you've been stay dimmed, with enemy buildings as you last saw them.
`?reveal` in the URL turns the fog off.

The malware nest sits in the middle of the web and you start out toward the
edge. Waves never stop: each one is bigger, comes sooner, and unlocks nastier
creeps (worms, then trojans, then ransomware bosses). Every wave leaves the nest
as packs of random size that wander outward. Nobody tells them where you are;
a pack attacks whatever it can see, so trouble comes from any side. Your score
is **uptime**: how long your core stays online. Taking the nest offline ends
the run early, in your favor. Hover anything (buttons, buildings, units, terrain) to see what it does.
Add `?debug` to the URL to expose live state as `window.uptime`.

## How it's built

```
src/
  content/   JSON: races, buildings, units, waves, damage table
  sim/       deterministic simulation (no DOM, no clock, no Math.random)
    terrain.ts   seeded map generation (noise, pockets sealed, nest placement)
    nav.ts       flow-field pathfinding, line of sight, wall sliding
  render/    PixiJS renderer + camera + minimap (reads the world, never writes it)
  main.ts    loop, input, HUD
tests/       simulation tests (vitest)
```

**The simulation is the game.** It runs at a fixed 20 ticks per second and,
given the same content, seed, and command log, produces the same world on
every machine (`hashWorld` checks this). That is deliberate:

- **Lockstep multiplayer later.** Every browser runs the sim; only commands
  (`build X at col,row on tick N`) cross the network. Input is already
  scheduled a couple of ticks ahead the way lockstep needs.
- **Replay verification.** A server can re-run a submitted command log and
  confirm a result before it touches a leaderboard.

Determinism rules live at the top of `src/sim/world.ts`. Break them and the
determinism tests fail.

**The map is a function of the seed.** Terrain and navigation are regenerated
from the seed on every machine, never sent over the wire, and kept out of the
state hash. Tests check 40 seeds for a clear start, a reachable far-off nest,
and room to build.

**Many units, few path searches.** Movement follows flow fields: one Dijkstra
pass outward from a destination that every unit heading there walks downhill.
Each map has ~24 roam points with a field each; a pack picks one, walks it,
and picks another. Guards hold near where they spawned and fight whatever
comes within reach.

**No hidden knowledge.** Creeps never read the player's position. A test fails
if any creep ever targets something beyond its sight.

**The horde is just a team.** Team 1 is the Botnet race, driven by the wave
director instead of a human.

**Races are data.** A race is a roster of buildings plus modifiers (the Open
Source Collective's spawners run 15% faster). New races, units, buildings, and
waves are content changes, not code changes. Content is validated on load.

## Roadmap

Direction: survival on a procedurally generated open web.

- [x] Big map, camera, minimap
- [x] Seeded terrain + flow-field pathfinding
- [x] Builder start: scout with a deploy agent and choose where your core goes
- [x] Fog of war
- [ ] Economy from what you build on data wells, replacing flat income
- [x] Wandering creep packs that only attack what they see
- [x] Endless escalating waves from a nest in the middle; uptime score
- [ ] Elevation: plateaus, cliffs, ramps; high-ground sight and range
- [ ] Rally points for spawned defenders
- Heroes and security abilities (zero-day, RCE, ransomware, worm, DDoS, honeypot)
- More races: Hyperscaler, Hacker crew, State actor / APT
- Content from WordPress, saves and leaderboards via Spacefast Zero

## Releases and deploys

Every push to `main` runs the Homeboy release pipeline
(`Extra-Chill/homeboy-action` `release.yml@v2`). Conventional commits decide
the bump: `feat:` minor, `BREAKING CHANGE` major, anything else (`fix:`,
`ci:`, `test:`, ...) patch. Only `chore:` and `docs:` skip a release.

When a release is cut, `deploy.yml` builds that tag, attaches
`uptime-wars-<tag>.zip` to the GitHub Release, and publishes exactly those
bytes to the production [Spacefast](https://spacefast.com) space. To redeploy
an existing tag, run the **Deploy** workflow by hand with that tag. Rollback is
promoting an older version in Spacefast.

Needs the `SPACEFAST_TOKEN` repository secret (a Spacefast API key with the
CI deploy preset).

## Checks

```sh
npm run typecheck
npm test
npm run build
```
