# Uptime Wars

Survival on the open web, in the browser. Every match generates a fresh patch
of the internet from a seed: dead links, cliffs and ramps, and a malware nest
somewhere far off-screen. Build a base around your core, field an army, and
keep your uptime while the botnet escalates, or break its fortress and take
the nest offline. Solo or co-op, four races, one hero each.

**[Play it in your browser](https://dist-xrbnhsmrf.view.fast/)**: no install,
no account. Press `G` in a match for the Guide.

> Prototype. Balance, art, and much of the design are still moving.

## Play

Online: **https://dist-xrbnhsmrf.view.fast/** (always the latest release).
Locally:

```sh
npm install
npm run dev
```

- Pick a race first:
  - **Open Source Collective**: cheap swarms that spawn 15% faster. Fork any
    building for half price; buildings repair themselves when nothing's
    hitting them.
  - **Hyperscaler**: rich and tough, +$75 to start and units 15% tougher.
    Buildings packed into a region shield each other.
  - **Serverless**: an army that autoscales. Functions keep a small squad warm
    and burst it bigger when creeps show up; every burst costs $.
  - **Walled Garden**: real walls that block every path, with towers and
    Moderators firing over them. Loyal users, and no network nodes: you build
    around your cores.
- You start with a **deploy agent**, already selected. Click (or right-click)
  the ground to walk it and scout through the fog. Press `C` (or the button) and
  click to choose where your core goes; the agent walks there and becomes the
  core. Lose the agent first and it's over. The hint line over the map always
  says what a click will do. Everything else is in the **Guide** (`G`).
- Click one of your buildings to select it; double-click one (any but the
  core) to grab every one of its kind on screen, and Shift-click adds buildings
  to the selection. Right-click sets where its units
  gather; right-click with a **core** selected sets the rally point for every
  spawner without its own whose nearest core it is (each core rallies its own
  bubble). To rally several spawners at once,
  Shift-click them, double-click one (every one of its kind on screen), or drag
  a box with no units in it. Units fight whatever gets in their
  way there, then guard the spot. Right-click is any secondary click: a
  two-finger tap or click on a trackpad, Ctrl-click and Cmd-click work too. Or skip it:
  press `T` (or the button on the info card), then left-click the ground.
- **Command your army.** Drag a box over your units (Shift adds), click one,
  double-click to grab every one of its kind on screen, or press `Z` for all of
  them. Right-click the ground or an enemy to attack-move: they fight whatever
  they meet, then hold the spot. `F` then click is a plain move that ignores
  enemies (retreat). Units you've sent stay put when you change a rally.
- **Take things back.** Select your own buildings and press `Delete` (or
  `Backspace`, or the button on the info card) twice to decommission them: half
  of what you paid comes back (all of it while one is still deploying,
  `economy.json` → `decommissionRefundPermille`), and the next one of that kind
  costs less again. Cores can't be decommissioned. With units selected, `Delete`
  dismisses them: no refund, but their compute is free at once.
- **Every race fields three units of its own, one per core tier**, and earns a
  fixed perk at Data Center and at Region (see the Guide's Races tab):
  Open Source (Process, Inference Drone, Kernel; cheaper forks, faster
  repair), Hyperscaler (Load Balancer, CDN Swarm, Mainframe; stronger region
  shield, tougher units), Serverless (Lambda, Inference Call, Step Function,
  each kept warm as a small squad that bursts bigger when creeps come near;
  faster bursts, cheaper bursts), Walled Garden (Moderator, Gatekeeper, Legal
  Team; walls hit back, near-zero churn). Perks live in `races.json` →
  `tierPerks`.
- **Grow your core.** The first research, **Upgrade core**, takes it from
  Core to **Data Center** ($400) to **Region** ($800). Each tier hosts more Web
  Apps (2, then 4, then 6), unlocks stronger buildings (GPU Cluster, Inference
  Endpoint, App Review need a Data Center), adds compute, widens your cores'
  build radius, and toughens them. A bigger base also draws crawlers from
  further away. Tiers live in `economy.json` → `tiers`; gates are `tier` and
  `limitPerTier` on a building.
- **Two places research**, each with a queue of five: the one running plus
  four waiting. Your **core** upgrades the race and its base: core tier,
  building armor and HP, tower damage and range, users and revenue. Your
  race's **upgrade center** (Open Source: CI Server, Hyperscaler: R&D Lab,
  Serverless: Build Pipeline, Walled Garden: Design Studio; one per player)
  upgrades the army: weapons, unit armor, unit HP, spawn speed, unit
  movement speed in up to three
  levels (Core, Data Center, Region), and **three unit traits only your race
  has**, one per unit, unlocked with that unit's tier: Fork on Exit, Open
  Weights, Self-Hosting; Sticky Sessions, Edge Routing, Batch Jobs;
  Provisioned Concurrency, Batching, Parallel State; Shadowban, Hold the
  Line, Cease and Desist. Each race names the shared upgrades its own way.
  You pay when you queue (WC3 style), each upgrade can be in the queue once
  (its next level waits until that one finishes), and requirements are judged with
  everything queued at both buildings counted — queue the core tier, then the
  upgrade that needs it. An entry whose tier isn't there yet waits at the
  head, and clicking an entry on the building's card cancels it for a full
  refund. Tuning lives in `src/content/upgrades.json` (queue size in
  `src/sim/tuning.ts`).
- `1`-`5` or click: pick a building. Click near your core (the ring shows your
  build radius) to place it. Shift-click to place several.
- `WASD` / arrows, middle-drag or Alt-drag, or the very edge of the window: pan (`E` toggles edge
  scroll). Wheel or `+`/`-`: zoom. Click the minimap to jump. Right-click the minimap to send the selection there (`Z` then right-click the minimap sends your whole army). `Space` / `H`: back home. Alerts also fire when your army is fighting off-screen or is being wiped out.
- Right-click / `Esc`: cancel. `P`: pause. `R`: new map after a match.

**Graphics.** The web is drawn in 3D with Three.js, as WC3-style terrain under
an angled camera, set in 2075: the map is one arcology. Each height level has
its own look: the deep web is the undercity, wet black glass under violet neon;
the surface web is a graphite hex deck with cyan seams; the backbone is matte
titanium plating. Cliffs are monolith walls with light bands, and ramps are lit
gateways with amber chevrons. Dead links are derelict server towers. Buildings
and units are procedural models in your team's colour; the botnet is spiky
and red. Software rendering automatically drops shadows and bloom. `?low`
forces that, `?hq` forces the full look, and `?2d` brings back the flat Pixi
view.

You know the map from the start: the whole terrain and where enemy buildings
stand (the nest and its C2 Servers) show, dimmed, on the map and the minimap.
Fog hides movement: you only see creeps within sight of your agent, units, and
buildings. `?reveal` in the URL turns the fog off.

**Heroes.** Each race has one hero (kept to one while the core loop gets
its depth; the picker step comes back if a race gets more). It appears at
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
| Open Source | Maintainer | ranged support: Code Review, Hotfix (finishes construction), Fork Bomb, ult Release Day |
| Hyperscaler | Site Reliability Engineer | tank: Rate Limit, Runbook, Canary Deploy, ult Autoscale |
| Serverless | Function Author | caster: Cold Start, Fan-Out (runs nearby functions), Retry with Backoff, ult Event Storm |
| Walled Garden | Platform Owner | enforcer: Delist, Lockdown, Walled Off, ult Sherlocked |

Heroes and abilities are JSON (`src/content/heroes.json`). An ability is one
of six effects: blast, strike, heal, decoy, summon, or buff.

**Items.** The hero carries up to six items (`HeroState.items`), kept through
death and respawn. Passive stats — damage, armor, max HP, HP regen, move
speed, attack speed — stack over every copy carried and apply wherever the
hero's stats are computed.

- **Shop at your core.** While the hero stands within the core-heal radius of
  one of your cores, the shop is open: select the hero and its command card
  lists the basics with price and effect — click to buy. (Not the core's card:
  that one is full with upgrades, the deploy agent and Spot capacity.) No full inventory, no credit. Selling, from the inventory
  slots on the hero card, gives back half the price anywhere in range.
- **Drops reward pushing out.** A Botnet Farm, a C2 Server or an incident
  boss killed by a player leaves one item glowing where it fell, rolled from a
  table of drop-only rares (bigger stats, one with an active). Right-click a
  drop with the hero selected: it walks there and takes it, if a slot is free.
  Any allied hero can take it in co-op. Drops never spawn on their own: the
  sim only changes through explicit commands.
- **Consumables** (Patch Kit and the self-healing firmware) have charges:
  click the slot, or `Alt`+`1`-`6` with the hero selected, to use one.

Items are data (`src/content/items.json`, validated like the rest), the four
commands are `buyItem`, `sellItem`, `useItem` and `pickUp`, and they are all
deterministic and replayable like every other command. The drop roll is
derived from the match seed and the dead entity's id, never `world.rngState`,
so adding drops shifts no other random roll. The computer AI doesn't use
items.

**Army cap.** Compute caps your army: every unit uses some, and a spawner
only adds one if it fits in what's free. Users use compute too, so a bigger
army costs you users (income). Generators are limited per core tier (Solar
Arrays 2 / 4 / 7, and so on), so the way to a bigger army is teching up the
core, not building more spawners. More spawners reinforce faster; they
don't field more. At the top tier the limit turns soft: generators past it
cost +100% of their base price more each (`pastLimitGrowthPermille`), so late
$ still buys a bigger army.

The army gets its compute first. Arriving users only take compute that's
free after every spawner's standing squad is refilled, so users never push
you over capacity or starve the army you built. When users stall for that
reason, the HUD shows "need compute" next to Users.

**Spawner ranks.** At the cap, the other way up is better units, not more.
Select a spawner (or a Serverless function) and press `U` (or the button on
its card) to upgrade it in place: rank 1 at Data Center, rank 2 at Region.
It stops spawning while it refits, then everything it makes is tougher and
hits harder, for more compute each, so a ranked squad is worth more per
compute than a plain one. Units already out keep their old rank. Each race
ranks its own way (`races.json` -> `spawnerRanks`): Open Source cheap and
quick (Stable, LTS), Hyperscaler armored (Reserved, Dedicated), Serverless
bigger bursts (Warm, Provisioned), Walled Garden fewer, elite units
(Verified, Premium). So every $ is a choice: another spawner, or a better one.

**Sound.** Everything you hear is synthesised in the browser with Web Audio
(`src/audio/`): no audio files. Combat is positional and only plays for what
you can see, and busy sounds are rate-limited. Waves, bosses, your core
under attack, casts, and level-ups each have their own cue. The music is a
generative ambient loop that picks up when enemies close in on your base.
`M` (or the button in the top bar) cycles sound on, effects only, or off.

**Height** matters. The web has three levels (deep web, surface web,
backbone). Cliffs separate them and ramps are the only way between. From below
you can't see up a cliff unless you're at its foot, and attacking downhill
deals 25% more damage. Hold a ramp and you hold the plateau.

**Network and redundancy.** You can build anywhere inside your network:
within reach of a core (7 tiles) or a network building. Open Source builds
cheap, fragile Mesh Nodes (reach 4); Hyperscaler builds armored Edge PoPs
(reach 7). If your main core falls, the next finished one takes over, and
you only go down when every core is down. Every finished core supplies its
own compute (80), so extra cores add reach, users, caps and compute; the core
tier's compute bonus still counts once. A core still building adds nothing.

**Expansion.** Grow past your first base by founding new cores anywhere on
the map. Select a core and press `B` (or the Deploy agent button) to train a
deploy agent for the core's price ($300); it's selected for you. Walk it out,
press `C` and click open ground: it walks there and builds a core. One agent
at a time, no site within 12 tiles of a hostile building (nest, farm,
Infected Node, enemy core), and if the agent dies on the way the $ is gone,
so escort it. An expansion builds over its build time and is weak until it's
up. Every finished core raises your per-tier caps (Web Apps, generators) by
half your main core's allowance, rounded up; your upgrade center stays one
per team.

**Neutral camps.** Squads of legacy hardware (Legacy Terminals, Servers and
Mainframes) guard the open ground, placed from the seed: weak camps about 22
tiles from every start, stronger ones toward the middle (48 and 74 tiles out),
the same set for every start so the map is fair. They belong to a neutral team
that is hostile to everyone, the botnet included, but they never attack first:
hit one and the whole camp fights back inside its leash, then goes home. A camp
nobody is fighting mends back to full, so finish what you start. A cleared camp
stays cleared (you get a "Camp cleared" alert). Every unit pays more bounty than
an ordinary unit of its strength, plus hero XP. Near camps are a job for your
hero alone; mid camps cost a small army some units; far camps, with a Mainframe,
need a real mid-game army and pay like a Spot rental. The minimap marks every
standing camp with a diamond by tier (green, amber, red). The neutral team never plays: no income, no core, no scoreboard
line, and it never affects who wins. Numbers live in `src/content/neutrals.json`.

**Sites.** A Derelict Datacenter stands at the center of every far camp (4 on
the default seed, one per start), guarded by the camp. It is pure territory: it
pays its owner $1.5 a second and supplies 10 compute through the ordinary
building paths, and does nothing else (no production, research, upgrades or
decommissioning). Clear the camp, then stand your units (heroes and deploy
agents count) within 200 px of it for 10 seconds uncontested to capture it: two
hostile sides at once pause it, nobody there drains it, and a rival has to drain
your progress before building its own. An owned site can't be captured again;
knock it down and it doesn't die but goes neutral at 25% hp, mends, and is up
for grabs. Sites never count for winning or losing, core logic, caps or cost
growth. You get "Site captured" and "Site lost" alerts, a "Sites N" counter in
the HUD, and the minimap shows every explored site as a square in its owner's
colour. Every ownership change goes through `transferOwnership`
(`src/sim/ownership.ts`). Numbers live in `src/content/neutrals.json` and
`src/content/buildings.json`. Computer players (with rivals in the match) capture
cleared sites near their core and break a rival's capture they can see.

**Spot capacity.** Rent extra compute for a push or a boss. Select a core and
press `N` (or the Spot capacity button): +60 / 120 / 200 compute (by core tier)
for 90s, for $250 / 500 / 900. Each rental this match costs 25% of the base
price more than the last, and only one runs at a time. When it ends nothing is
deleted and nothing overloads: your compute shrinks to what the army above your
normal cap still needs, so those units aren't replaced and fade as they fall.
You can rent again once the tail is gone. The HUD shows `spot 0:45` while it
runs and `spot fading` after. The computer players don't use it.

**$ and compute** are two different things. **$** is money: users pay it
every second, and everything (buildings, research) is bought with it.
**Compute** is capacity: your core (80), Solar Arrays (60) and Power Plants
(150) supply it, and every user (1) and unit (about 2) uses it.
The HUD shows it as in use / supplied. It can go over, and the further over
you are the worse it gets: no new users arrive, users leave in proportion, and
your towers, spawners and research all slow by the same share.

**Spending is a choice.** Every building of a kind costs 10% more than the
last for each one you already own (network buildings and walls excepted), so
spamming one thing gets expensive fast. And the botnet notices a big base:
incidents grow with the square root of what you've built and banked
(`waves.json` → `threat`, up to ×3), shown as "Threat ×1.6" next to the
incident preview. Sitting on a pile of $ makes you a target.

**Buildings are solid.** Nobody walks through a building, your own units
included: they go round. So base layout matters. Pack it tight and creeps have
to chew through the outside to get in, but leave your army a way out: a
building that would wall ground in two is refused ("leave a way through").
Closing off a notch of a few tiles against a cliff is fine; it then counts as
built over, so nothing spawns into it. Walls and gates are the exception: they
exist to close gaps.

**Users** are why you're online. They arrive while your core is up and grow
toward your capacity (the core serves 40; each Web App adds 60), as long as
you have the compute to serve them. Every hit your core or a Web App takes
drives some away (towers and racks don't: they're what you put in between).
Numbers live in `src/content/economy.json`.

**You're on the clock from the moment your core is online.** A big countdown
gives you one minute; then the first incident comes out of the fog right
outside your base (toward the nest) and marches straight on your core, and
background traffic starts. Later incidents show the countdown for their last
15 seconds. (`waves.json` → `firstIncidentTicks`, `opening`.)

The malware nest sits in the middle of the web and you start out toward the
edge. The botnet never stops, and its pressure comes in two forms.
**Background traffic** is a small pack leaving the nest every 8 seconds,
growing as the match goes on, so there's always something out there.
**Incidents** (Port scan, Worm outbreak, DDoS, Ransomware...) are big surges
every couple of minutes. Each one is bigger and comes sooner, unlocks nastier
creeps (worms, then trojans), and bosses (ransomware) only come with
incidents. In co-op every player still online adds pressure: the trickle
scales strongly, since it spreads over everyone, and incidents gently,
since each lands on one base.

**Late incidents get tougher, not bigger.** Past 200 creeps an incident comes
as fewer **ranked** creeps worth the same: Hardened (worth 2), Polymorphic
(4), Persistent (8), Advanced (16), APT (32). A rank multiplies HP and damage
by the square root of its worth each, so a rank worth 8 fights like 8 plain
creeps, looks bigger, and pays 8× the bounty and XP. The botnet's alive cap
(500) counts worth, not heads, so ranks change the horde's shape without
multiplying it. Waves grow ×1.36 an incident up to incident 8 and ×1.05
after, so each incident arrives soon after it's announced instead of queuing
behind the last; every incident's creeps also carry its HP growth (+12% an
incident). (`waves.json` → `ranks`, `budget.lateFrom`, `budget.lateGrowth`.)
The top bar counts down to the next incident
and previews it: its name, the creeps it can bring (new ones marked), and
any boss. Every pack leaves the nest
as packs of random size that wander outward. Nobody tells them where you are,
but you make **traffic**: crawlers sense your cores from a radius that grows
with your buildings, your users, and time online, and packs that sense you
march on you. Build big and you're found sooner; stay small and you buy time,
but not forever. Trouble comes from
whichever side a pack is wandering in from. Your score
is **uptime**: how long your core stays online. Taking the nest offline ends
the run early, in your favor, but it's a **fortress**: the nest sits on a
backbone plateau ringed by cliffs, every ramp up is guarded by a C2 Server,
and more ring the nest itself. Every 2 incidents the botnet rebuilds the ones you
knocked down, tougher (`waves.json` → `fortress`). The nest is **shielded**
while its four **Botnet Farms** stand: break every farm (each one weakens later
incidents), then the nest. A shielded nest is invulnerable, like Warcraft III's: units
and towers ignore it and an attack order on it is refused, so nothing gets stuck on it.
Rebuilt farms shield it again, and the top bar's
Nest stat shows where you are. When the nest falls, the whole botnet collapses. Where they stand is a pure
function of the seed. Hover anything (buttons, buildings, units, terrain) to see what it does.
Add `?debug` to the URL to expose live state as `window.uptime`.
`await uptime.sim()` is the simulation module and `uptime.load(world)` watches
any world you build with it, such as a reported match replayed to some minute.

## How it's built

```
src/
  content/        JSON: races, buildings, units, waves, upgrades, items, economy,
                  computer-player difficulties
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
    ai/             computer players: decide inside step(), send ordinary commands
                    (index: economy and hero; army: gather, attack, retreat)
    nav.ts          flow fields, line of sight, walkability
  game/           the player's side: Session (match, issuing commands) and
                  Selection (what a click means for what you have selected)
  ui/             HUD, build bar, info panel, guide, home screen (race-picker.ts)
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

**Text is generated from the data.** A `description` in content JSON is a line
of flavor; every number the player reads (cards, the Guide, the race picker,
perks as before → after, what a rank does to its units) is written by
`ui/text.ts` and `ui/cards.ts` from the values the simulation runs on.
`tests/text.test.ts` fails if a description quotes a quantity or the UI
hardcodes one, so changing a number in JSON changes every place it's shown.
A new trait, creep role, or race mechanic won't typecheck until it has words.

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
Steps cost 10 or 14, so the search runs on a bucket queue rather than a heap,
over a walkable-tile mask cached per building layout. Fields are dropped when
a building goes up or comes down, since every building blocks.
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

**The home screen.** Pick a race (number keys or click; your last one is
picked already), then how to play: **Play solo** (`Enter`, or double-click a
race) is you against the botnet, **Quick Match** (`Q`) is co-op with
strangers, and **Custom match** (`C`) is the lobby for friends, computers,
free-for-all and teams. All three play the race you picked. Your colour, the
Guide (`G`) and the stats checkbox are underneath. While it's open, the
match's HUD steps aside and nothing behind it runs.

**Quick Match.** Press Q on the home screen to play co-op against the botnet
with strangers, as the race you picked. The game's relay (`zero/server`) hands you the invite of
whoever has waited longest on the exact same build; if nobody's waiting, you
host and your invite is listed. The match starts 15 s after the first player
joins, or at once with four. After that it's an ordinary co-op match, peer to
peer.

**Playing the computer.** A computer player is a player like any other: the
same economy and the same rules, only its commands come from `src/sim/ai`
instead of a mouse. It decides inside `step()` from the world alone, so it's
deterministic: co-op peers and replays all compute the same moves, which is
why its commands aren't written to the match log. Its skill is data
(`src/content/difficulty.json`): Easy, Normal, Hard, Insane set how quickly it
acts, how far it techs, and how freely it spends. The one bent rule is
Insane's, and it's in the open: `revenuePermille`, more $ per user.
Against other players a computer also attacks. It gathers an army, sends it
in waves and brings it home when the wave is spent or its base is in trouble.
Like you, it knows where the start spots are but not who's at them, so it
scouts. Its hero goes with the army and comes home to heal. When it attacks,
how big a wave it waits for and when it gives up are also difficulty
(`attack`). Between attacks, with rivals around, it also creeps: it clears the
nearest neutral camp of an allowed tier that its army's power beats (the
computer estimates a camp from what it's made of until it has seen it), takes
the site there, grabs cleared sites near its core, and sends its army to break a
rival's capture it can see (`creep`; Easy never does, Hard goes sooner and
farther). Alone against the horde or in co-op it only defends.

On the home screen press `C` (or **Custom match**) and **Add a computer**.
That's the same lobby as playing with friends. Each seat is
a friend or a computer, and each computer gets a difficulty, a race and a
starting side. Seat computers on your side for co-op, on their own for a
free-for-all, or mix people and computers in teams. Computers keep the side
they start on: they don't take alliance offers. With no friend joined, the
match is played on your machine and can pause. With friends, it's a network
match and every browser works out the computers' moves the same way, so
nobody waits on them. The address bar works too, for quick tests:

- `?ai=hard` · one Hard opponent, free-for-all with the horde
- `?ai=easy,insane:serverless` · two opponents, the second playing Serverless
- `&horde=0` · free-for-all without the horde
- `&mode=coop` · the computers join you against the horde

The balance runs (`npm run balance`, `BALANCE_DIFFICULTY=hard`) are a computer
player alone against the horde, so a better AI is also a better balance test.
`npm run balance:ffa` plays computers against each other
(`FFA="hard:serverless,normal:hyperscaler;..."`, `FFA_SEEDS`, `FFA_MINUTES`,
`FFA_HORDE=1`) and writes `balance-results/ffa/results.json`.

**Playing with friends.** On the home screen press `C` (or **Custom
match**) and start from **Co-op**, **Free-for-all** or **Teams**, then set
the sides, the botnet and alliances. Any seat can go to a computer instead.
Send a friend the invite link (it ends in a six-letter code); they open it,
pick a race, and you're connected. One link per friend, up to three. Press
**Start match** when everyone's in. The browsers connect directly over
WebRTC (public STUN, no TURN yet, so a few strict corporate or mobile networks
won't connect).

The only server is the game's own Spacefast space (`zero/server`, Spacefast
Zero, backed by the space's WordPress). It is a tiny invite relay: it holds
each invite's WebRTC offer and the friend's answer for 30 minutes, and the
answer is only readable with the host's key. Nothing about a match goes
through it while you play.

**Match stats.** When a match ends (or you leave it after the first 20
seconds), the game posts one anonymous report to `POST /api/matches`: a random
player id kept in your browser, the version, seed, mode, races and hero, the
outcome, uptime, incident, core tier and peak users, what was built and
researched, how present you were (commands and seconds with any mouse or key
input, per game minute, and the stretches with none: when do people stop
playing?), and the command log. Only that input happened is counted, never
what it was or where. Seed + setup + command log replays the match
exactly (`simulate`, `tests/replay.test.ts`), so any reported match can be
re-run and inspected. A long match also checks in every two game minutes
with a random match id, and each report updates that match's row: closing
the tab can only send 64 KB, so a long match's final report may go without
its log (`summary.logComplete: false`), and the row keeps the log from the
last check-in. Rows land in the `matches` table; the server only
accepts them, nothing reads them back from outside. Turn it off with the
checkbox on the home screen. Never sent from localhost or with `?debug`. `npm run build` stages it
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

Ticks normally run from the frame loop, but a hidden tab gets no frames, and in
lockstep one player's stalled turns freeze everyone. So in co-op a hidden tab
keeps stepping on a beat from a tiny inline Worker (`src/game/metronome.ts`;
browsers throttle a hidden tab's timers, not a Worker's). Solo, a hidden tab
just pauses.

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
- [x] Wandering creep packs that only attack what they see
- [x] Endless escalating pressure from a nest in the middle (background traffic + incidents); uptime score
- [x] Elevation: plateaus, cliffs, ramps; high-ground sight and damage
- [x] Rally points: per spawner, with a default on each core for its bubble, and several spawners at once
- [x] Upgrades researched at the core
- [x] Core tech tiers: Core, Data Center, Region
- [x] Network expansion (per race) and redundant cores
- [x] Expansion: found cores across the map with a deploy agent; each core raises the caps
- [x] Neutral camps: guarded legacy hardware at seeded spots, bounty and hero XP (#160)
- [x] Capturable sites: derelict datacenters at far camps, `transferOwnership` (#160)
- [x] Computer players creep camps and take/contest sites, only against rivals (#160)
- [x] Heroes: one per race, levels, skill points, four abilities each
- [x] Hero items: 6-slot inventory, a shop at your core, drops from farms, C2 Servers and bosses (#93)
- [x] Compute is the army cap; generators are limited per core tier (soft at the top tier)
- [x] Four races: Open Source Collective, Hyperscaler, Serverless, Walled Garden
- [x] Spawner ranks: upgrade a spawner in place for fewer, stronger units
- [x] Co-op over WebRTC (invite links, lockstep)
- [x] A win condition: break the Botnet Farms, then take the nest offline
- [x] Computer players with difficulties: they build, defend and attack, from a lobby seat or the address bar (#123)
- More races: Hacker crew, State actor / APT
- [x] Anonymous match reports (with replayable command logs) via Spacefast Zero
- [x] Public at https://dist-xrbnhsmrf.view.fast/, source at https://github.com/mcali-dreamin/uptime-wars
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

## Playing from a script

`node e2e/play.mjs [dist|URL]` keeps one Chromium page open and takes
commands on a localhost control server, so an agent (or a shell loop) can
play a full solo match turn by turn through the real UI: pause, look
(screenshot + visible text), act with real mouse/keyboard input, step the
game forward, repeat. Env: `PORT` (7357), `SHOTS` (`shots/play`), `VIEWPORT`
(1440x900). Every action answers with a look: the shot's path plus the
visible text of the HUD, info card, hint, banner, build bar and alerts.

```sh
npm run build && node e2e/play.mjs dist
curl "http://127.0.0.1:7357/start?race=open-source&seed=1234"  # pick, play solo, pause
curl "http://127.0.0.1:7357/advance?s=5"                       # step the paused match 5s
curl "http://127.0.0.1:7357/click?x=700&y=430"                 # real mouse click
curl "http://127.0.0.1:7357/drag?x1=600&y1=300&x2=800&y2=500"  # box select
curl "http://127.0.0.1:7357/key?k=q"                           # real key press
curl "http://127.0.0.1:7357/look"                              # shots/play/<n>.png + text
curl "http://127.0.0.1:7357/quit"
```

`/click` also takes `button=right`, `shift=1`, `ctrl=1`, `double=1`; `/move`
hovers for tooltips; `/advance` caps at 60s a call. Commands are real input
only — the `?debug` API is used just to pause, step (`uptime.advance`), and
read the tick and outcome — so the script sees what a player sees. It's a
debug tool: nothing changes for normal players.

## License

[MIT](LICENSE) © 2026 Chris Huber.
