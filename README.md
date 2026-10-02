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

- Pick a race first. **Open Source Collective** is cheap and fast: it forks
  swarms and its spawners run 15% quicker. **Hyperscaler** has deep pockets and
  heavy iron: +150 starting compute, 30% tougher units, slower spawners, and its
  own roster (Load Balancer tanks, long-range CDN Edge towers, Power Plants).
- You start with a **deploy agent**, already selected. Click (or right-click)
  the ground to walk it and scout through the fog. Press `C` (or the button) and
  click to choose where your core goes; the agent walks there and becomes the
  core. Lose the agent first and it's over. The hint line over the map always
  says what a click will do. Everything else is in the **Guide** (`G`).
- Click one of your buildings to select it. Right-click sets where its units
  gather; right-click with the **core** selected sets a global rally point for
  every spawner that doesn't have its own. Units fight whatever gets in their
  way there, then guard the spot.
- Select your **core** to research upgrades (one at a time): Hardened
  Containers, Exploit Kits, Anycast, Autoscaling, Edge Caching, Premium Tier.
  Tuning lives in `src/content/upgrades.json`.
- `1`-`5` or click: pick a building. Click near your core (the ring shows your
  build radius) to place it. Shift-click to place several.
- `WASD` / arrows, drag, or the very edge of the window: pan (`E` toggles edge
  scroll). Wheel or `+`/`-`: zoom. Click the minimap to jump. `Space` / `H`: back home.
- Right-click / `Esc`: cancel. `P`: pause. `R`: new map after a match.

**3D (experimental):** add `?3d` to the URL for a Three.js view of the same
game, with plateaus as real steps and a WC3-style angled camera. Everything
else (controls, UI, the simulation) is shared; Three.js only loads when asked
for.

The map starts black. You see what your agent, units, and buildings can see;
places you've been stay dimmed, with enemy buildings as you last saw them.
`?reveal` in the URL turns the fog off.

**Height** matters. The web has three levels (deep web, surface web,
backbone). Cliffs separate them and ramps are the only way between. From below
you can't see up a cliff unless you're at its foot, and attacking downhill
deals 25% more damage. Hold a ramp and you hold the plateau.

**Network and redundancy.** You can build anywhere inside your network:
within reach of a core (7 tiles) or a network building. Open Source builds
cheap, fragile Mesh Nodes (reach 4); Hyperscaler builds armored Edge PoPs
(reach 7). Cores are buildable too (300 compute). If your main core falls, the
next takes over, and you only go down when every core is down.

**Users** are why you're online. They arrive while your core is up and grow
toward your capacity (the core serves 40; each Web App adds 60). Every user
pays compute each second, and every hit your buildings take drives some away.
Numbers live in `src/content/economy.json`.

The malware nest sits in the middle of the web and you start out toward the
edge. Waves never stop: each one is bigger, comes sooner, and unlocks nastier
creeps (worms, then trojans, then ransomware bosses). Every wave leaves the nest
as packs of random size that wander outward. Nobody tells them where you are,
but you make **traffic**: crawlers can sense your cores from far away, more
so as you grow, and packs that sense you march on you. Trouble comes from
whichever side a pack is wandering in from. Your score
is **uptime**: how long your core stays online. Taking the nest offline ends
the run early, in your favor. Hover anything (buttons, buildings, units, terrain) to see what it does.
Add `?debug` to the URL to expose live state as `window.uptime`.

## How it's built

```
src/
  content/        JSON: races, buildings, units, waves, upgrades, economy, damage
  sim/            deterministic simulation (no DOM, no clock, no Math.random)
    world.ts        createWorld, step() (the order systems run in), outcome
    commands.ts     player commands: build, move, found, rally, research
    placement.ts    "can I build here", network reach, cores
    entities.ts     creating buildings, units, cores
    units/          one module per unit mode, dispatched from a registry:
                      guard, roam (packs + traffic), builder; engage = fighting
    movement.ts     walkTo: straight when clear, else a cached flow field
    combat.ts       targeting (spatial grid), high ground, damage
    economy.ts      income, users, revenue, churn, traffic
    upgrades.ts     research and stat multipliers
    spawners.ts / waves.ts
    terrain/        map generation: tiles, generate, elevation, scatter, grid
    content/        schema, load, validate
    nav.ts          flow fields, line of sight, walkability
  game/           the player's side: Session (match, issuing commands) and
                  Selection (what a click means for what you have selected)
  ui/             HUD, build bar, info panel, guide, race picker
  render/         reads the world, never writes it
    renderer.ts     shell: camera, fog, minimap, banner, interpolation, effects
    frame.ts        the Frame / WorldView contract every world view implements
    pixi/world2d.ts the default 2D view (plus glyphs, terrain art)
    three/world3d.ts the experimental 3D view (?3d)
    palette.ts      colours both views share
  input.ts        pointer + keys; camera controls, hands the rest to the game
  main.ts         wiring and the frame loop
tests/            one file per system, plus rule tests
```

**Layers only point one way**, and `tests/architecture-rules.test.ts` fails the
build if that changes: `sim` imports nothing outside itself (and can't touch
browser globals, so it can run headless for replays and lockstep peers);
`game` and `render` import `sim`; `ui` imports `game` and `sim`; `input.ts` and
`main.ts` wire everything together.

**Adding things.** A race, unit, building, upgrade, or wave rule is usually a
JSON edit. A new unit behaviour is a file in `sim/units/` plus one line in its
registry. A new way to draw the world is a `WorldView` (see `render/frame.ts`).

**The simulation is the game.** It runs at a fixed 20 ticks per second and,
given the same content, seed, and command log, produces the same world on
every machine (`hashWorld` checks this). That is deliberate:

- **Lockstep multiplayer later.** Every browser runs the sim; only commands
  (`build X at col,row on tick N`) cross the network. Input is already
  scheduled a couple of ticks ahead the way lockstep needs.
- **Replay verification.** A server can re-run a submitted command log and
  confirm a result before it touches a leaderboard.

Determinism rules live at the top of `src/sim/world.ts` and are enforced by
`tests/determinism-rules.test.ts`: no `Math.random`, no clock, and no
engine-approximated math (`Math.pow`, trig, `**`) anywhere in `src/sim`.

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
- [x] Users: capacity, revenue, and churn from damage
- [ ] Data wells feed the economy
- [x] Wandering creep packs that only attack what they see
- [x] Endless escalating waves from a nest in the middle; uptime score
- [x] Elevation: plateaus, cliffs, ramps; high-ground sight and damage
- [x] Rally points: per spawner, with a global default on the core
- [x] Upgrades researched at the core
- [x] Network expansion (per race) and redundant cores
- Heroes and security abilities (zero-day, RCE, ransomware, worm, DDoS, honeypot)
- [x] Race selection: Open Source Collective, Hyperscaler
- More races: Hacker crew, State actor / APT
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
npm test          # simulation tests + determinism rules for src/sim
npm run build
npm run e2e       # browser smoke test against dist/ (needs: npx playwright install chromium)
```

CI runs all four on every pull request, and the deploy workflow runs them
again before publishing.
