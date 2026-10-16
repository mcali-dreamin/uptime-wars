// Setting up a match with friends: the host collects guests over peer links,
// then starts everyone on the same seed with a team each, under the rules the
// host composed (sides, diplomacy, the botnet; see sim/teams.ts). From then
// on the links carry lockstep turns (see lockstep.ts).

import { MAX_PLAYERS, createWorld, rulesFor, type Content, type MatchMode, type MatchRules, type TeamId, type World } from "../../sim";
import { Lockstep, type LockstepMessage } from "./lockstep";
import type { PeerLink } from "./rtc";

const HORDE_RACE = "botnet";

type LobbyMessage =
  | { t: "hello"; race: string; hero?: string }
  | { t: "start"; seed: number; races: string[]; heroes: (string | undefined)[]; you: TeamId; mode?: MatchMode; rules?: MatchRules }
  | LockstepMessage;

/**
 * How the host set the match up: a preset to start from, whether the botnet
 * plays, and any rule on top (sides per seat, diplomacy, nest must fall).
 * With nothing else to fight (one side, alliances locked) the botnet always plays.
 */
export interface LobbyRules extends Partial<MatchRules> {
  mode?: MatchMode;
  horde: boolean;
}

export const COOP: LobbyRules = { mode: "coop", horde: true };

/** The rules a lobby setup comes to for `players` seats, and whether the botnet plays. */
export function composeRules(setup: LobbyRules, players: number): { rules: MatchRules; horde: boolean } {
  const base = rulesFor(setup.mode ?? "coop", players);
  const sides = setup.sides ? Array.from({ length: players }, (_, i) => setup.sides![i] ?? 0) : base.sides;
  const rules: MatchRules = {
    sides,
    diplomacy: setup.diplomacy ?? base.diplomacy,
    nestMustFall: setup.nestMustFall ?? base.nestMustFall,
  };
  const enemyBesides = new Set(sides).size > 1 || rules.diplomacy === "open";
  return { rules, horde: setup.horde || !enemyBesides };
}

export interface NetMatch {
  world: World;
  lockstep: Lockstep;
  local: TeamId;
}

interface Guest {
  link: PeerLink;
  race: string | null;
  hero: string | undefined;
}

export class HostLobby {
  readonly guests: Guest[] = [];
  /** Called whenever someone joins, leaves, or says hello. */
  onChange: () => void = () => {};
  /** After start: a guest left (its team keeps playing without orders). */
  onLeave: (team: TeamId) => void = () => {};
  private lockstep: Lockstep | null = null;

  constructor(private readonly content: Content) {}

  get full(): boolean {
    return this.guests.length >= MAX_PLAYERS - 1;
  }

  /** Add a guest over an open link. */
  add(link: PeerLink): void {
    const guest: Guest = { link, race: null, hero: undefined };
    this.guests.push(guest);
    link.onMessage = (raw) => {
      const message = raw as LobbyMessage;
      if (message.t === "hello" && !this.lockstep) {
        guest.race = this.content.races[message.race]?.controller === "human" ? message.race : null;
        // An unknown hero falls back to the race's default rather than breaking the match.
        guest.hero = guest.race && this.content.races[guest.race]!.heroes?.includes(message.hero ?? "") ? message.hero : undefined;
        this.onChange();
        return;
      }
      if (this.lockstep && (message.t === "turn" || message.t === "drop")) this.lockstep.receive(message, this.teamOf(guest));
    };
    link.onClose = () => {
      if (this.lockstep) {
        const team = this.teamOf(guest);
        this.lockstep.drop(team);
        this.onLeave(team);
        return;
      }
      this.guests.splice(this.guests.indexOf(guest), 1);
      this.onChange();
    };
    this.onChange();
  }

  /** Everyone who has said hello. */
  get ready(): Guest[] {
    return this.guests.filter((guest) => guest.race !== null);
  }

  /** Start the match for everyone who's ready. The host is player 1. */
  start(hostRace: string, seed: number, hostHero?: string, setup: LobbyRules = COOP): NetMatch {
    // Guests that never said hello don't get a seat.
    for (const guest of this.guests.filter((g) => g.race === null)) guest.link.close();
    this.guests.splice(0, this.guests.length, ...this.ready);
    const { rules, horde } = composeRules(setup, this.guests.length + 1);
    const races = [hostRace, ...this.guests.map((guest) => guest.race!), ...(horde ? [HORDE_RACE] : [])];
    const heroes = [hostHero, ...this.guests.map((guest) => guest.hero)];
    for (const [i, guest] of this.guests.entries()) guest.link.send({ t: "start", seed, races, heroes, you: i + 1, rules } satisfies LobbyMessage);
    const world = createWorld(this.content, { seed, races, heroes, rules });
    this.lockstep = new Lockstep(world, this.content, {
      local: 0,
      host: true,
      send: (message, except) => {
        for (const [i, guest] of this.guests.entries()) if (i + 1 !== except) guest.link.send(message);
      },
    });
    return { world, lockstep: this.lockstep, local: 0 };
  }

  close(): void {
    for (const guest of this.guests) guest.link.close();
    this.guests.length = 0;
  }

  private teamOf(guest: Guest): TeamId {
    return this.guests.indexOf(guest) + 1;
  }
}

/** A guest's side: say hello, wait for the host to start. */
export function joinHost(content: Content, link: PeerLink, race: string, hero: string | undefined, onStart: (match: NetMatch) => void): void {
  link.onMessage = (raw) => {
    const message = raw as LobbyMessage;
    if (message.t !== "start") return;
    const world = createWorld(content, { seed: message.seed, races: message.races, heroes: message.heroes ?? [], mode: message.mode ?? "coop", rules: message.rules });
    const lockstep = new Lockstep(world, content, { local: message.you, host: false, send: (m) => link.send(m) });
    link.onMessage = (next) => {
      const m = next as LobbyMessage;
      if (m.t === "turn" || m.t === "drop") lockstep.receive(m, 0);
    };
    onStart({ world, lockstep, local: message.you });
  };
  link.send({ t: "hello", race, hero } satisfies LobbyMessage);
}
