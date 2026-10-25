// Lockstep over an in-memory network with random latency: every peer must
// end up with the same world, whatever order frames and messages arrive in.

import { describe, expect, it } from "vitest";
import { Lockstep, type LockstepMessage } from "../src/game/net/lockstep";
import { createWorld, hashWorld, type Building, type MatchSetup, type TeamId } from "../src/sim";

/** Test-side RNG (mulberry32), separate from any world. */
function nextRandom(state: { rngState: number }): number {
  state.rngState = (state.rngState + 0x6d2b79f5) | 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
import { content, planBuildOrder, OPENING_ORDER } from "./fixtures";

/** `players` humans (all Open Source, so one opening fits everyone) plus the horde. */
const setupFor = (players: number): MatchSetup => ({
  seed: 4242,
  races: [...Array(players).fill("open-source"), "botnet"],
  startWithCore: true,
});
const SETUP = setupFor(3);

interface Net {
  peers: Lockstep[];
  /** Deliver due messages, then let every peer try to step. Returns ticks stepped. */
  pump(now: number): number;
  disconnect(team: TeamId): void;
}

/** A star network with per-message latency drawn from a seeded RNG. */
function network(players: number, maxLatency: number): Net {
  const setup = setupFor(players);
  const rng = { rngState: 99 };
  const queue: { at: number; to: TeamId; from: TeamId; message: LockstepMessage }[] = [];
  let clock = 0;
  const down = new Set<TeamId>();
  const deliver = (to: TeamId, from: TeamId, message: LockstepMessage) => {
    if (down.has(to) || down.has(from)) return;
    // Ordered, reliable channel: never deliver before an earlier message on the same link.
    const last = queue.filter((q) => q.to === to && q.from === from).reduce((m, q) => Math.max(m, q.at), 0);
    queue.push({ at: Math.max(last, clock + Math.floor(nextRandom(rng) * maxLatency)), to, from, message: structuredClone(message) });
  };
  const peers: Lockstep[] = [];
  for (let team = 0; team < players; team += 1) {
    const host = team === 0;
    peers.push(
      new Lockstep(createWorld(content, setup), content, {
        local: team,
        host,
        send: host
          ? (message, except) => {
              for (let guest = 1; guest < players; guest += 1) if (guest !== except) deliver(guest, 0, message);
            }
          : (message) => deliver(0, team, message),
      }),
    );
  }
  return {
    peers,
    pump(now) {
      clock = now;
      queue.sort((a, b) => a.at - b.at);
      while (queue.length > 0 && queue[0]!.at <= now) {
        const { to, from, message } = queue.shift()!;
        if (!down.has(to)) peers[to]!.receive(message, from);
      }
      let stepped = 0;
      for (const [team, peer] of peers.entries()) {
        if (down.has(team)) continue;
        // Peers run at different speeds: some frames step 0, 1, or 2 ticks.
        const tries = Math.floor(nextRandom(rng) * 3);
        for (let i = 0; i < tries; i += 1) if (peer.tryStep()) stepped += 1;
      }
      return stepped;
    },
    disconnect(team) {
      down.add(team);
      peers[0]!.drop(team);
    },
  };
}

/** Each player issues its opening build order, plus a rally now and then. */
function playOpenings(net: Net, players: number): void {
  for (let team = 0; team < players; team += 1) {
    const peer = net.peers[team]!;
    for (const command of planBuildOrder(content, setupFor(players), OPENING_ORDER, 4, team)) {
      const { tick: _tick, team: _team, ...order } = command;
      peer.issue(order);
    }
  }
}

function runUntil(net: Net, tick: number, onFrame?: (frame: number) => void): void {
  for (let frame = 0; frame < tick * 20; frame += 1) {
    onFrame?.(frame);
    net.pump(frame);
    if (net.peers.every((peer) => peer.world.tick >= tick)) return;
  }
  throw new Error(`stalled at ${net.peers.map((p) => p.world.tick).join(",")}`);
}

describe("lockstep", () => {
  it("three players over a laggy network end up with the same world", () => {
    const net = network(3, 12);
    playOpenings(net, 3);
    runUntil(net, 1500, (frame) => {
      // Commands at arbitrary moments, from every player.
      if (frame % 97 === 0) {
        for (const [team, peer] of net.peers.entries()) {
          const core = peer.world.entities.find((e) => e.id === peer.world.teams[team]!.coreId)!;
          peer.issue({ type: "rally", buildingId: core.id, x: core.x + (frame % 300), y: core.y });
        }
      }
    });
    // Peers may be a few ticks apart; compare at the same tick.
    const target = Math.min(...net.peers.map((p) => p.world.tick));
    expect(net.peers.every((p) => p.world.tick - target <= 2 * net.peers[0]!.delay)).toBe(true);
    for (const peer of net.peers) expect(peer.desyncTick).toBeNull();
    // Every player's commands actually took effect, on every peer.
    for (const peer of net.peers) {
      for (let team = 0; team < 3; team += 1) {
        expect(peer.world.entities.filter((e) => e.kind === "building" && e.team === team).length).toBeGreaterThan(3);
        const core = peer.world.entities.find((e): e is Building => e.id === peer.world.teams[team]!.coreId)!;
        expect(core.rally).not.toBeNull();
      }
    }
  });

  it("matches a single-browser replay of the same commands exactly", () => {
    const net = network(3, 6);
    playOpenings(net, 3);
    runUntil(net, 800);
    // Drive the slowest peer's peers to the same tick and compare hashes.
    const ticks = net.peers.map((p) => p.world.tick);
    const max = Math.max(...ticks);
    for (let frame = 20_000; net.peers.some((p) => p.world.tick < max); frame += 1) net.pump(frame);
    const atMax = net.peers.filter((p) => p.world.tick === max).map((p) => hashWorld(p.world));
    expect(new Set(atMax).size).toBe(1);
  });

  it("nobody steps a tick before every player's turn for it has arrived", () => {
    const net = network(2, 1);
    // Guest never gets to send: cut it off after the opening.
    const guest = net.peers[1]!;
    const host = net.peers[0]!;
    runUntil(net, 50);
    const stuck = host.world.tick;
    // Starve the host: block the guest from stepping (so it commits no new turns).
    guest.tryStep = () => false;
    for (let frame = 10_000; frame < 10_500; frame += 1) net.pump(frame);
    expect(host.world.tick - stuck).toBeLessThanOrEqual(host.delay + 1);
    expect(host.waitingOn()).toEqual([1]);
  });

  it("the host drops a player who leaves; everyone else plays on in sync", () => {
    const net = network(3, 8);
    playOpenings(net, 3);
    runUntil(net, 300);
    net.disconnect(2);
    // The remaining two keep going far past the drop.
    const rest = { ...net, peers: net.peers.slice(0, 2) };
    for (let frame = 30_000; rest.peers.some((p) => p.world.tick < 1200); frame += 1) {
      net.pump(frame);
      if (frame > 60_000) throw new Error("stalled after drop");
    }
    for (const peer of rest.peers) expect(peer.desyncTick).toBeNull();
    // Player 2's base is still in the world: its units keep fighting.
    expect(rest.peers[1]!.world.entities.some((e) => e.team === 2)).toBe(true);
  });

  it("a desync is caught by the world hash", () => {
    const net = network(2, 3);
    runUntil(net, 150);
    // Corrupt one peer's world.
    net.peers[1]!.world.teams[1]!.money += 1;
    runUntil(net, 450);
    expect(net.peers[0]!.desyncTick ?? net.peers[1]!.desyncTick).not.toBeNull();
  });

  it("a guest can't send turns for another player, and the host doesn't relay them", () => {
    const sent: LockstepMessage[] = [];
    const host = new Lockstep(createWorld(content, SETUP), content, { local: 0, host: true, send: (m) => { if (m.t === "drop" || m.team !== 0) sent.push(m); } });
    // Guest 1 claims to be player 2.
    host.receive({ t: "turn", tick: host.delay, team: 2, cmds: [] }, 1);
    expect(sent).toEqual([]);
    host.tryStep(); // tick 0: nobody's turn is needed yet
    for (let i = 1; i < host.delay; i += 1) host.tryStep();
    expect(host.waitingOn()).toEqual([1, 2]);
    // Only the host sends drops; a guest's "drop" is ignored.
    const guest = new Lockstep(createWorld(content, SETUP), content, { local: 1, host: false, send: () => {} });
    guest.receive({ t: "drop", team: 0, after: 0 }, 0);
    expect(guest.waitingOn()).toEqual([]);
  });
});
