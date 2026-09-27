# Uptime

Tech-themed castle defense in the browser. Build compute, let your racks fork
processes into the lane, and keep your core data center online while the
botnet comes in waves. Warcraft III castle-fight mechanics, reskinned for
compute wars.

> Prototype. Balance, art, and most of the design are placeholders.

## Play

```sh
npm install
npm run dev
```

- `1`-`4` or click: pick a building. Click in your (green) build zone to place it.
  Shift-click to place several.
- Right-click / `Esc`: cancel. `Space`: pause. `R`: restart after a match.

You win by clearing every wave, or by taking the enemy core offline.

## How it's built

```
src/
  content/   JSON: races, buildings, units, waves, damage table
  sim/       deterministic simulation (no DOM, no clock, no Math.random)
  render/    PixiJS renderer (reads the world, never writes it)
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

**The horde is just a team.** Team 1 is the Botnet race, driven by the wave
director instead of a human. Swapping the controller is the path to PvP and to
mixed human/AI teams without a second ruleset.

**Races are data.** A race is a roster of buildings plus modifiers (the Open
Source Collective's spawners run 15% faster). New races, units, buildings, and
waves are content changes, not code changes. Content is validated on load.

## Roadmap

- Heroes: the one unit you control directly, with XP and abilities
- Security abilities: zero-day (one use, then the enemy is patched against it),
  RCE (take control), ransomware (lock a building until paid), worm (chain),
  DDoS (area slow), honeypot, backups
- More races: Hyperscaler, Hacker crew, State actor / APT
- Lane pathing and unit separation
- Content from WordPress: ability/unit/wave definitions as posts, read at build time
- Accounts, saves, leaderboards via Spacefast Zero
- Lockstep co-op and PvP over a small command relay

## Publish

```sh
npm run publish:spacefast
```

Builds and publishes `dist/` to [Spacefast](https://spacefast.com).

## Checks

```sh
npm run typecheck
npm test
npm run build
```
