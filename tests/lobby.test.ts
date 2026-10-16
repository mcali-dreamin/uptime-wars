// The lobby over an in-memory link: the host's rules reach the guest, and
// both build the same world.

import { describe, expect, it } from "vitest";
import { HostLobby, joinHost, type NetMatch } from "../src/game/net/lobby";
import type { PeerLink } from "../src/game/net/rtc";
import { hashWorld, rulesLabel } from "../src/sim";
import { content } from "./fixtures";

/** Two ends of a synchronous in-memory link (messages cloned, like the wire). */
function pair(): [PeerLink, PeerLink] {
  const make = (): PeerLink & { other?: PeerLink } => ({
    send(message) {
      this.other!.onMessage(structuredClone(message));
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
    expect(match.world.teams.map((t) => t.raceId)).toEqual(["open-source", "hyperscaler", "botnet"]);
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
