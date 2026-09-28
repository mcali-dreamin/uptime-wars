// One match, from the player's side: which race, the world, and issuing
// commands. Commands are scheduled a couple of ticks ahead, as they will be
// in lockstep multiplayer.

import {
  createWorld,
  queueCommand,
  type Building,
  type Command,
  type Content,
  type TeamId,
  type Unit,
  type World,
} from "../sim";

export const HUMAN: TeamId = 0;
const HORDE_RACE = "botnet";
const INPUT_DELAY_TICKS = 2;
const RACE_KEY = "uptime:race";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command as the player issues it: the session fills in tick and team. */
export type Order = DistributiveOmit<Command, "tick" | "team">;

export class Session {
  readonly playable: string[];
  raceId: string;
  world: World;

  constructor(readonly content: Content) {
    this.playable = Object.entries(content.races)
      .filter(([, race]) => race.controller === "human")
      .map(([id]) => id);
    const saved = localStorage.getItem(RACE_KEY) ?? "";
    this.raceId = this.playable.includes(saved) ? saved : this.playable[0]!;
    this.world = this.newWorld();
  }

  start(raceId: string): void {
    this.raceId = raceId;
    localStorage.setItem(RACE_KEY, raceId);
    this.world = this.newWorld();
  }

  issue(order: Order): void {
    queueCommand(this.world, { ...order, tick: this.world.tick + INPUT_DELAY_TICKS, team: HUMAN } as Command);
  }

  get team() {
    return this.world.teams[HUMAN];
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
