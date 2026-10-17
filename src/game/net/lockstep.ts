// Deterministic lockstep. Every browser runs the whole simulation; only
// player commands cross the network.
//
// Each tick, every player sends one *turn*: the commands it gives for a tick
// `delay` ticks ahead (often none). A tick is stepped only once every player's
// turn for it has arrived, and every peer queues those commands in the same
// order (team, then issue order), so every peer computes the same world.
//
// Topology is a star: guests talk only to the host, and the host relays every
// turn to every guest. That makes the host the single source of order, which
// is what lets it drop a player who disconnects at a tick everyone agrees on
// (a "drop" message in the same stream). Losing the host ends the match.
//
// Every HASH_EVERY ticks a turn carries the sender's world hash, so a desync
// is caught the tick it can first be detected rather than when it shows.
//
// No browser globals here: transports are plain callbacks, so tests can wire
// peers together in memory.

import { hashWorld, humanTeams, queueCommand, step, type Command, type Content, type Team, type TeamId, type World } from "../../sim";

/** Ticks between issuing a command and it taking effect: room for the network. */
export const NET_DELAY_TICKS = 4;
export const HASH_EVERY = 100;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Order = DistributiveOmit<Command, "tick" | "team">;

export type TurnMessage = {
  t: "turn";
  tick: number;
  team: TeamId;
  cmds: Command[];
  /** The sender's world hash at `hashTick`, every HASH_EVERY ticks. */
  hash?: string;
  hashTick?: number;
};
/** Host only: `team` sends no turns after tick `after`; nobody waits for it. */
export type DropMessage = { t: "drop"; team: TeamId; after: number };
export type LockstepMessage = TurnMessage | DropMessage;

export interface LockstepOptions {
  local: TeamId;
  host: boolean;
  /** Guest: send to the host. Host: send to every guest except `except`. */
  send(message: LockstepMessage, except?: TeamId): void;
  delay?: number;
}

export class Lockstep {
  readonly delay: number;
  /** tick -> team -> that team's commands for the tick. */
  private readonly turns = new Map<number, Map<TeamId, Command[]>>();
  /** Last tick each team has sent a turn for. */
  private readonly lastTurn = new Map<TeamId, number>();
  private readonly droppedAfter = new Map<TeamId, number>();
  private pending: Order[] = [];
  /** Highest tick we've sent our own turn for. */
  private committed: number;
  private readonly ownHashes = new Map<number, string>();
  private readonly peerHashes = new Map<number, { team: TeamId; hash: string }[]>();
  /** The first tick where a peer's world disagreed with ours, if any. */
  desyncTick: number | null = null;
  /** How many times a peer's hash was checked against ours. */
  hashChecks = 0;

  constructor(
    readonly world: World,
    private readonly content: Content,
    private readonly options: LockstepOptions,
  ) {
    this.delay = options.delay ?? NET_DELAY_TICKS;
    // Ticks before the first delay are empty for everyone.
    this.committed = this.delay - 1;
    for (const team of players(world)) this.lastTurn.set(team.id, this.delay - 1);
  }

  /** Queue a command; it goes out with our next turn. */
  issue(order: Order): void {
    this.pending.push(order);
  }

  /** Teams whose turn is still missing for the next tick, if any. */
  waitingOn(): TeamId[] {
    const tick = this.world.tick;
    if (tick < this.delay) return [];
    const have = this.turns.get(tick);
    return this.expected(tick).filter((team) => !have?.has(team));
  }

  /**
   * Step one tick if every player's turn for it is in. Sends our own turn
   * first, so peers waiting on us never wait longer than they must.
   */
  tryStep(): boolean {
    const tick = this.world.tick;
    this.commit(tick + this.delay);
    if (this.waitingOn().length > 0) return false;
    const turn = this.turns.get(tick);
    if (turn) {
      for (const team of [...turn.keys()].sort((a, b) => a - b)) {
        for (const command of turn.get(team)!) queueCommand(this.world, command);
      }
      this.turns.delete(tick);
    }
    step(this.world, this.content);
    return true;
  }

  /** A message from the network. Hosts relay guests' turns to everyone else. */
  receive(message: LockstepMessage, from: TeamId): void {
    if (message.t === "drop") {
      if (this.options.host) return; // Only the host decides drops.
      this.droppedAfter.set(message.team, message.after);
      return;
    }
    // A guest may only speak for itself; the host speaks for anyone it relays.
    if (this.options.host && message.team !== from) return;
    if (this.droppedAfter.has(message.team)) return;
    this.record(message);
    if (this.options.host) this.options.send(message, from);
  }

  /**
   * Host: a guest left. It sends nothing after the last turn we relayed, and
   * every guest learns that in order, after those turns.
   */
  drop(team: TeamId): void {
    if (!this.options.host || this.droppedAfter.has(team)) return;
    const after = this.lastTurn.get(team) ?? this.delay - 1;
    this.droppedAfter.set(team, after);
    this.options.send({ t: "drop", team, after });
  }

  private expected(tick: number): TeamId[] {
    return players(this.world)
      .map((team) => team.id)
      .filter((team) => {
        const after = this.droppedAfter.get(team);
        return after === undefined || tick <= after;
      });
  }

  private commit(upTo: number): void {
    while (this.committed < upTo) {
      const tick = (this.committed += 1);
      const { local } = this.options;
      const cmds = this.pending.map((order) => ({ ...order, tick, team: local }) as Command);
      this.pending = [];
      const message: TurnMessage = { t: "turn", tick, team: local, cmds };
      const now = this.world.tick;
      if (now % HASH_EVERY === 0) {
        const hash = hashWorld(this.world);
        this.ownHashes.set(now, hash);
        message.hash = hash;
        message.hashTick = now;
        this.compare(now);
      }
      this.record(message);
      this.options.send(message);
    }
  }

  private record(message: TurnMessage): void {
    let turn = this.turns.get(message.tick);
    if (!turn) this.turns.set(message.tick, (turn = new Map()));
    turn.set(message.team, message.cmds);
    this.lastTurn.set(message.team, Math.max(this.lastTurn.get(message.team) ?? -1, message.tick));
    if (message.hash !== undefined && message.hashTick !== undefined && message.team !== this.options.local) {
      const list = this.peerHashes.get(message.hashTick) ?? [];
      list.push({ team: message.team, hash: message.hash });
      this.peerHashes.set(message.hashTick, list);
      this.compare(message.hashTick);
    }
  }

  private compare(tick: number): void {
    const own = this.ownHashes.get(tick);
    const peers = this.peerHashes.get(tick);
    if (own === undefined || !peers) return;
    this.hashChecks += peers.length;
    if (peers.some((peer) => peer.hash !== own) && (this.desyncTick === null || tick < this.desyncTick)) {
      this.desyncTick = tick;
    }
    this.peerHashes.delete(tick);
  }
}

/**
 * Whose turns a tick waits on: the people. A computer player sends none;
 * every peer works its moves out inside step(), the same on each.
 */
function players(world: World): Team[] {
  return humanTeams(world).filter((team) => !team.ai);
}
