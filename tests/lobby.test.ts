// The lobby over an in-memory link: the host's rules reach the guest, and
// both build the same world.

import { describe, expect, it } from "vitest";
import { HostLobby, joinHost, lobbySetup, type NetMatch } from "../src/game/net/lobby";
import type { PeerLink } from "../src/game/net/rtc";
import { createWorld, hashWorld, rulesLabel } from "../src/sim";
import { content } from "./fixtures";

/** Two ends of a synchronous in-memory link (messages sent as JSON, like the wire: undefined in an array arrives as null). */
function pair(): [PeerLink, PeerLink] {
  const make = (): PeerLink & { other?: PeerLink } => ({
    send(message) {
      this.other!.onMessage(JSON.parse(JSON.stringify(message)));
    },
    onMessage: () => {},
    onClose: () => {},
    close() {},
  });
  const a = make();
  const b = make();
  a.other = b;
  b.other = a;
  return [a, b];
}

function lobbyWith(): { host: HostLobby; joined: () => NetMatch | null } {
  const host = new HostLobby(content);
  const [hostEnd, guestEnd] = pair();
  host.add(hostEnd);
  let match: NetMatch | null = null;
  joinHost(content, guestEnd, "hyperscaler", undefined, (m) => (match = m));
  return { host, joined: () => match };
}

describe("lobby rules", () => {
  it("co-op by default: humans plus the horde", () => {
    const { host, joined } = lobbyWith();
    const match = host.start("open-source", 77);
    expect(rulesLabel(match.world)).toBe("coop");
    expect(match.world.teams.map((t) => t.raceId)).toEqual(["open-source", "hyperscaler", "botnet", "neutral"]); // the neutral team always comes last
    expect(rulesLabel(joined()!.world)).toBe("coop");
    expect(hashWorld(joined()!.world)).toBe(hashWorld(match.world));
  });

  it("FFA reaches the guest, with or without the horde", () => {
    for (const horde of [true, false]) {
      const { host, joined } = lobbyWith();
      const match = host.start("open-source", 77, undefined, { mode: "ffa", horde });
      const guest = joined()!;
      expect(guest.local).toBe(1);
      expect(rulesLabel(guest.world)).toBe("ffa");
      expect(guest.world.teams.some((t) => t.raceId === "botnet")).toBe(horde);
      expect(hashWorld(guest.world)).toBe(hashWorld(match.world));
    }
  });

  it("co-op always keeps the horde", () => {
    const { host } = lobbyWith();
    const match = host.start("open-source", 77, undefined, { mode: "coop", horde: false });
    expect(match.world.teams.some((t) => t.raceId === "botnet")).toBe(true);
  });

  it("composed rules reach the guest: sides and open diplomacy", () => {
    const { host, joined } = lobbyWith();
    const match = host.start("open-source", 77, undefined, { horde: false, sides: [0, 1], diplomacy: "open" });
    const guest = joined()!;
    expect(guest.world.rules).toEqual({ sides: [0, 1], diplomacy: "open", nestMustFall: true });
    expect(guest.world.teams.some((t) => t.raceId === "botnet")).toBe(false);
    expect(hashWorld(guest.world)).toBe(hashWorld(match.world));
  });

  it("with nothing else to fight, the botnet plays", () => {
    const { host } = lobbyWith();
    const match = host.start("open-source", 77, undefined, { horde: false, sides: [2, 2], diplomacy: "locked" });
    expect(match.world.teams.some((t) => t.raceId === "botnet")).toBe(true);
  });
});

describe("computers in the lobby", () => {
  it("seats people first, then computers, then the botnet; sides cover everyone", () => {
    const setup = lobbySetup(9, [{ race: "open-source", hero: undefined }], [{ race: "serverless", difficulty: "hard" }, { race: "hyperscaler", difficulty: "easy" }], { horde: true, sides: [0, 0, 1], diplomacy: "locked", nestMustFall: false });
    expect(setup.races).toEqual(["open-source", "serverless", "hyperscaler", "botnet"]);
    expect(setup.ai).toEqual([undefined, "hard", "easy"]);
    const world = createWorld(content, setup);
    expect(world.rules.sides).toEqual([0, 0, 1]);
    expect(world.teams.map((t) => t.ai?.difficulty ?? null)).toEqual([null, "hard", "easy", null, null]); // ...the last null is the neutral team
  });

  it("a computer seat reaches the guest, and nobody waits on its turns", () => {
    const { host, joined } = lobbyWith();
    const match = host.start("open-source", 77, undefined, { mode: "ffa", horde: false }, [{ race: "serverless", difficulty: "hard" }]);
    const guest = joined()!;
    expect(guest.world.teams[2]!.ai?.difficulty).toBe("hard");
    expect(hashWorld(guest.world)).toBe(hashWorld(match.world));
    // A minute in lockstep: the people send turns, the computer just plays,
    // the same on both ends.
    let stalls = 0;
    while (match.world.tick < 60 * 20) {
      const a = match.lockstep.tryStep();
      const b = guest.lockstep.tryStep();
      if (!a && !b && ++stalls > 100) throw new Error(`stuck at tick ${match.world.tick}, waiting on ${match.lockstep.waitingOn()}`);
    }
    while (guest.world.tick < match.world.tick) guest.lockstep.tryStep();
    expect(match.lockstep.waitingOn()).not.toContain(2);
    expect(hashWorld(guest.world)).toBe(hashWorld(match.world));
    expect(match.world.entities.filter((e) => e.kind === "building" && e.team === 2).length).toBeGreaterThan(1);
  });
});
