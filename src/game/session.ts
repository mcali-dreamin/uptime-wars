// One match, from the player's side: which race, the world, issuing
// commands, and advancing the clock. Solo, commands are scheduled a couple of
// ticks ahead and the world steps freely. In co-op, both go through lockstep:
// commands travel as turns, and a tick steps once every player's turn is in.

import type { Lockstep } from "./net/lockstep";
import type { NetMatch } from "./net/lobby";
import {
  createWorld,
  queueCommand,
  step,
  type Building,
  type Command,
  type Content,
  type TeamId,
  type Unit,
  type World,
} from "../sim";

import { playerColor, type PlayerColor } from "./colors";

const HORDE_RACE = "botnet";
const INPUT_DELAY_TICKS = 2;
const RACE_KEY = "uptime:race";
const COLOR_KEY = "uptime:color";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command as the player issues it: the session fills in tick and team. */
export type Order = DistributiveOmit<Command, "tick" | "team">;

export class Session {
  readonly playable: string[];
  raceId: string;
  /** The team this browser plays. Player n in a co-op match is team n. */
  local: TeamId = 0;
  /** The player's colour. Render-only: the simulation never sees it. */
  color: PlayerColor;
  world: World;
  /** Set in a co-op match. */
  net: Lockstep | null = null;

  constructor(readonly content: Content) {
    this.playable = Object.entries(content.races)
      .filter(([, race]) => race.controller === "human")
      .map(([id]) => id);
    const saved = localStorage.getItem(RACE_KEY) ?? "";
    this.raceId = this.playable.includes(saved) ? saved : this.playable[0]!;
    this.color = playerColor(localStorage.getItem(COLOR_KEY) ?? "");
    this.world = this.newWorld();
  }

  start(raceId: string): void {
    this.pick(raceId);
    this.net = null;
    this.local = 0;
    this.world = this.newWorld();
  }

  setColor(id: string): void {
    this.color = playerColor(id);
    localStorage.setItem(COLOR_KEY, this.color.id);
  }

  /** Remember the race for next time, without starting anything. */
  pick(raceId: string): void {
    this.raceId = raceId;
    localStorage.setItem(RACE_KEY, raceId);
  }

  /** Play a co-op match someone (maybe us) set up. */
  startNet(match: NetMatch): void {
    this.world = match.world;
    this.net = match.lockstep;
    this.local = match.local;
    this.raceId = this.team.raceId;
  }

  issue(order: Order): void {
    if (this.net) return this.net.issue(order);
    queueCommand(this.world, { ...order, tick: this.world.tick + INPUT_DELAY_TICKS, team: this.local } as Command);
  }

  /** Advance one tick if we can. In co-op that waits on every player's turn. */
  tryStep(): boolean {
    if (this.net) return this.net.tryStep();
    step(this.world, this.content);
    return true;
  }

  /** In co-op: who we're waiting on right now, if anyone. */
  waitingOn(): TeamId[] {
    return this.net?.waitingOn() ?? [];
  }

  get team() {
    return this.world.teams[this.local]!;
  }

  get race() {
    return this.content.races[this.team.raceId]!;
  }

  /** Before the core is online, the player is in the deploy phase. */
  get deploying(): boolean {
    return this.team.coreId === -1;
  }

  entity(id: number) {
    return id === -1 ? undefined : this.world.entities.find((entity) => entity.id === id && entity.hp > 0);
  }

  core(): Building | undefined {
    const core = this.entity(this.team.coreId);
    return core?.kind === "building" ? core : undefined;
  }

  builder(): Unit | undefined {
    const builder = this.entity(this.team.builderId);
    return builder?.kind === "unit" ? builder : undefined;
  }

  /** Your core, or your deploy agent before there is one. */
  home() {
    return this.core() ?? this.builder();
  }

  private newWorld(): World {
    // `?seed=N` replays a specific map (tests, bug reports); otherwise random.
    const fixed = Number(new URLSearchParams(location.search).get("seed"));
    const seed = Number.isInteger(fixed) && fixed !== 0 ? fixed : (Math.random() * 2 ** 31) | 0;
    return createWorld(this.content, { seed, races: [this.raceId, HORDE_RACE] });
  }
}
