# Uptime Wars

Survival on the open web, in the browser. Every match generates a fresh patch
of the internet from a seed: dead links, data wells, and a
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
  heavy iron: +$150 to start, 30% tougher units, slower spawners, and its
  own roster (Load Balancer tanks, long-range CDN Edge towers, Power Plants).
- You start with a **deploy agent**, already selected. Click (or right-click)
  the ground to walk it and scout through the fog. Press `C` (or the button) and
  click to choose where your core goes; the agent walks there and becomes the
  core. Lose the agent first and it's over. The hint line over the map always
  says what a click will do. Everything else is in the **Guide** (`G`).
- Click one of your buildings to select it. Right-click sets where its units
  gather; right-click with the **core** selected sets a global rally point for
  every spawner that doesn't have its own. Units fight whatever gets in their
  way there, then guard the spot. Right-click is any secondary click: a
  two-finger tap or click on a trackpad, Ctrl-click and Cmd-click work too. Or skip it:
  press `T` (or the button on the info card), then left-click the ground.
- **Command your army.** Drag a box over your units (Shift adds), click one,
  double-click to grab every one of its kind on screen, or press `Z` for all of
  them. Right-click the ground or an enemy to attack-move: they fight whatever
  they meet, then hold the spot. `F` then click is a plain move that ignores
  enemies (retreat). Units you've sent stay put when you change a rally.
- Select your **core** to research upgrades (one at a time): Hardened
  Containers, Exploit Kits, Anycast, Autoscaling, Edge Caching, Premium Tier.
  Tuning lives in `src/content/upgrades.json`.
- `1`-`5` or click: pick a building. Click near your core (the ring shows your
  build radius) to place it. Shift-click to place several.
- `WASD` / arrows, middle-drag or Alt-drag, or the very edge of the window: pan (`E` toggles edge
  scroll). Wheel or `+`/`-`: zoom. Click the minimap to jump. `Space` / `H`: back home.
- Right-click / `Esc`: cancel. `P`: pause. `R`: new map after a match.

**Graphics.** The web is drawn in 3D with Three.js, as WC3-style terrain under
an angled camera. Each height level has its own look: the deep web is violet
soil, the surface web teal moss with cyan circuit traces, and the backbone
steel plating. Cliffs are dark rock with glowing fibre strata, and ramps are
paved gateways with amber chevrons. Dead links are fields of black shards,
data wells are glowing crystals. Buildings
and units are procedural models in your team's colour; the botnet is spiky
and red. Software rendering automatically drops shadows and bloom. `?low`
forces that, `?hq` forces the full look, and `?2d` brings back the flat Pixi
view.

You know the map from the start: the whole terrain and where enemy buildings
stand (the nest and its C2 Servers) show, dimmed, on the map and the minimap.
Fog hides movement: you only see creeps within sight of your agent, units, and
buildings. `?reveal` in the URL turns the fog off.

**Heroes.** After your race, pick one of its three heroes. It appears at
your core when the core comes online and is the one unit you command
directly: `Q` selects it (again to centre on it), right-click moves it or
attacks an enemy, `1`-`4` cast, `Shift`+`1`-`4` (or the `+`) learn.

- Kills near your hero give it XP. Every level is a skill point and more hp
  and damage.
- Basic abilities have three ranks. The fourth is an ultimate, open at
  level 6.
- A fallen hero comes back at your core after a delay that grows with its
  level.

| Race | Hero | Plays as |
| --- | --- | --- |
| Open Source | Maintainer | ranged support: Code Review, Hotfix, Fork Bomb, ult Release Day |
| Open Source | Benevolent Dictator | melee bruiser: Veto, Merge Conflict, Flame War, ult Rewrite It in Rust |
| Open Source | Bug Bounty Hunter | ranged assassin: Fuzzing, Honeypot, Patch Tuesday, ult Zero-day |
| Hyperscaler | Site Reliability Engineer | tank: Rate Limit, Runbook, Canary Deploy, ult Autoscale |
| Hyperscaler | Solutions Architect | ranged nuker: Vendor Lock-in, Capacity Plan, SLA, ult Region Outage |
| Hyperscaler | Developer Evangelist | support: Keynote, Free Tier, Black Friday, ult Acquisition |

Heroes and abilities are JSON (`src/content/heroes.json`). An ability is one
of six effects: blast, strike, heal, decoy, summon, or buff.

**Height** matters. The web has three levels (deep web, surface web,
backbone). Cliffs separate them and ramps are the only way between. From below
you can't see up a cliff unless you're at its foot, and attacking downhill
deals 25% more damage. Hold a ramp and you hold the plateau.

**Network and redundancy.** You can build anywhere inside your network:
within reach of a core (7 tiles) or a network building. Open Source builds
cheap, fragile Mesh Nodes (reach 4); Hyperscaler builds armored Edge PoPs
(reach 7). Cores are buildable too ($300). If your main core falls, the
next takes over, and you only go down when every core is down.

**Data wells** are glowing crystals scattered across the web. Build a **Data
Pump** on one (both races, $100) for 100 compute, more than a Solar Array. No well is inside your core's starting reach, though the nearest two
are always a short hop out, so your first pump means extending your network
toward it. Pumps sit out in the open, where wandering packs find them.

**$ and compute** are two different things. **$** is money: users pay it
every second, and everything (buildings, research) is bought with it.
**Compute** is capacity: your core (80), Solar Arrays (60), Power Plants (150)
and Data Pumps (100) supply it, and every user (1) and unit (about 2) uses it.
The HUD shows it as in use / supplied. It can go over, and the further over
you are the worse it gets: no new users arrive, users leave in proportion, and
your towers, spawners and research all slow by the same share.

**Users** are why you're online. They arrive while your core is up and grow
toward your capacity (the core serves 40; each Web App adds 60), as long as
you have the compute to serve them. Every hit your core or a Web App takes
drives some away (towers and racks don't: they're what you put in between).
Numbers live in `src/content/economy.json`.

The malware nest sits in the middle of the web and you start out toward the
edge. Waves never stop: each one is bigger, comes sooner, and unlocks nastier
creeps (worms, then trojans, then ransomware bosses). The top bar previews the next wave: its name, the creeps it can bring (new
ones marked), and any boss. Every wave leaves the nest
as packs of random size that wander outward. Nobody tells them where you are,
but you make **traffic**: crawlers sense your cores from a radius that grows
with your buildings, your users, and time online, and packs that sense you
march on you. Build big and you're found sooner; stay small and you buy time,
but not forever. Trouble comes from
whichever side a pack is wandering in from. Your score
is **uptime**: how long your core stays online. Taking the nest offline ends
the run early, in your favor, but it's a **fortress**: the nest sits on a
backbone plateau ringed by cliffs, every ramp up is guarded by a C2 Server,
and more ring the nest itself. Every 5 waves the botnet rebuilds the ones you
knocked down, tougher (`waves.json` → `fortress`). Where they stand is a pure
function of the seed. Hover anything (buttons, buildings, units, terrain) to see what it does.
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
    three/          the default 3D view: world3d (scene, camera, entities),
                    terrain3d (heightfield + doodads), models (procedural
                    buildings and units), effects (bolts, sparks, bars,
                    rings), fog3d (fog of war as a texture any material reads)
    pixi/world2d.ts the flat 2D view (?2d; plus glyphs, terrain art)
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

**Co-op is in the sim.** A match is 1 to 4 human teams plus the horde
(`races: ["open-source", "hyperscaler", "botnet"]`). Every map has four
starts, so the map is the same whoever plays it. Humans are allies: they never
target each other and share vision. Each has its own base, $, and race,
and either one's traffic draws the horde. A player whose cores are all down
goes offline and their commands stop, but the match goes on until every player
is offline (lost) or the nest is (won by all of them).

**Free-for-all.** The same match with `mode: "ffa"`: every team is everyone's
enemy, there's no shared vision, and the last player with a core up wins. The
horde is optional; with it, the nest is just one more enemy (taking it down
ends the waves, not the match). FFA needs at least two players.

**Playing with friends.** On the race picker press `H` (or **Play with
friends**) and pick **Co-op** or **Free-for-all** (with or without the horde).
Send a friend the invite link (it ends in a six-letter code); they open it,
pick a race, and you're connected. One link per friend, up to three. Press
**Start match** when everyone's in. The browsers connect directly over
WebRTC (public STUN, no TURN yet, so a few strict corporate or mobile networks
won't connect).

The only server is a tiny invite relay in the game's own Spacefast space
(`zero/server`, Spacefast Zero): it holds each invite's WebRTC offer and the
friend's answer for 30 minutes, and the answer is only readable with the
host's key. Nothing about a match goes through it. `npm run build` stages it
into `dist/` next to the static game. Where there's no relay (`npm run dev`, a
plain static host), co-op falls back to copy and paste: the link carries the
whole offer and the friend sends back a reply code.

Under the hood it's deterministic lockstep (`src/game/net/lockstep.ts`):
every browser runs the whole simulation, and each tick every player sends one
turn with its commands for 4 ticks later. A tick steps only once every turn
for it is in, so a slow connection stalls everyone rather than desyncing
anyone. The host relays all turns (a star), which lets it drop a player who
disconnects at a tick everyone agrees on; their base keeps fighting. Every
100 ticks turns carry a world hash, so a desync is caught right away. Co-op
can't pause. If the host leaves, the match is over.

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
- [x] Data wells feed the economy
- [x] Wandering creep packs that only attack what they see
- [x] Endless escalating waves from a nest in the middle; uptime score
- [x] Elevation: plateaus, cliffs, ramps; high-ground sight and damage
- [x] Rally points: per spawner, with a global default on the core
- [x] Upgrades researched at the core
- [x] Network expansion (per race) and redundant cores
- [x] Heroes: three per race, levels, skill points, four abilities each
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
npm run e2e       # browser smoke test + two-browser co-op against dist/ (needs: npx playwright install chromium)
```

CI runs all four on every pull request, and the deploy workflow runs them
again before publishing.
