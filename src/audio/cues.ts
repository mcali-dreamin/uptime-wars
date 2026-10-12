// What the game sounds like, decided from sim events. Pure: no audio APIs
// here, so the rules (what plays, how loud, how often) are testable.
//
// The director turns each tick's events into cues. Combat is positional:
// a cue is quieter the further it is from the middle of the screen, panned
// left/right, and enemy-side cues you can't see are dropped. Busy sounds
// (shots, deaths) are rate-limited so a 300-creep brawl is a texture, not
// a wall of noise.

import { hostile, type Content, type Point, type SimEvent, type TeamId, type World } from "../sim";

export type CueName =
  | "shot"
  | "hit-building"
  | "death"
  | "death-big"
  | "building-down"
  | "wave"
  | "boss"
  | "founded"
  | "alarm"
  | "failover"
  | "offline"
  | "cast-blast"
  | "cast-strike"
  | "cast-heal"
  | "cast-decoy"
  | "cast-summon"
  | "cast-buff"
  | "level-up"
  | "hero-down"
  | "hero-up"
  | "researched"
  | "error"
  | "victory"
  | "defeat"
  | "fortified";

export interface Cue {
  name: CueName;
  /** 0..1, after distance falloff. */
  volume: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
}

/** What the director needs to know about where the player is looking. */
export interface Listener {
  /** Centre of the screen, in world pixels. */
  center: Point;
  /** How much of the world is on screen across, in world pixels. */
  span: number;
  /** Whether a world point is in sight (fog). */
  visible(p: Point): boolean;
}

/** Minimum gap between two cues of the same name, in seconds. */
const GAP: Partial<Record<CueName, number>> = {
  shot: 0.06,
  "hit-building": 0.25,
  death: 0.08,
  alarm: 6,
  error: 0.3,
};
/** At most this many of a busy cue per tick. */
const PER_TICK: Partial<Record<CueName, number>> = { shot: 2, death: 2, "hit-building": 1 };

export class Director {
  private readonly last = new Map<CueName, number>();
  constructor(private readonly content: Content) {}

  /**
   * Cues for one tick's events. `now` is seconds of wall time (for rate
   * limits); `local` is the team this browser plays.
   */
  cues(world: World, events: readonly SimEvent[], local: TeamId, listener: Listener, now: number): Cue[] {
    const out: Cue[] = [];
    const count = new Map<CueName, number>();
    const push = (name: CueName, volume: number, at?: Point, always = false) => {
      if (!always) {
        // The gap is between ticks; within one tick the per-tick cap applies.
        const gap = GAP[name] ?? 0;
        const prev = this.last.get(name) ?? -Infinity;
        if (prev !== now && now - prev < gap) return;
        const cap = PER_TICK[name];
        if (cap !== undefined && (count.get(name) ?? 0) >= cap) return;
      }
      const placed = at ? this.place(at, listener) : { gain: 1, pan: 0 };
      if (placed.gain <= 0.02) return;
      this.last.set(name, now);
      count.set(name, (count.get(name) ?? 0) + 1);
      out.push({ name, volume: Math.min(1, volume * placed.gain), pan: placed.pan });
    };
    const mine = (team: TeamId) => team === local;
    const ally = (team: TeamId) => !hostile(world, team, local);

    for (const event of events) {
      switch (event.type) {
        case "shot": {
          const at = { x: event.x2, y: event.y2 };
          if (!listener.visible(at) && !listener.visible({ x: event.x1, y: event.y1 })) break;
          const target = world.entities.find((e) => e.id === event.to);
          if (target?.kind === "building" && mine(target.team)) {
            push("hit-building", 0.5, at);
            if (target.id === world.teams[local]?.coreId) push("alarm", 0.7);
          } else {
            push("shot", ally(event.team) ? 0.22 : 0.18, { x: event.x1, y: event.y1 });
          }
          break;
        }
        case "death": {
          const at = { x: event.x, y: event.y };
          if (!listener.visible(at)) break;
          // The entity is already gone from the world; the event says what it was.
          if (event.kind === "building") push("building-down", 0.8, at, true);
          else if ((this.content.units[event.defId]?.size ?? 0) >= 14) push("death-big", 0.6, at, true);
          else push("death", 0.3, at);
          break;
        }
        case "wave":
          push(event.boss ? "boss" : "wave", event.boss ? 0.8 : 0.55, undefined, true);
          break;
        case "fortified":
          push("fortified", 0.4, undefined, true);
          break;
        case "founded":
          push("founded", 0.7, undefined, true);
          break;
        case "failover":
          if (mine(event.team)) push("failover", 0.8, undefined, true);
          break;
        case "offline":
          push("offline", mine(event.team) ? 0.9 : 0.5, undefined, true);
          break;
        case "cast": {
          const ability = this.content.heroes.abilities[event.ability];
          if (!ability) break;
          const at = { x: event.x, y: event.y };
          if (!mine(event.team) && !listener.visible(at)) break;
          push(`cast-${ability.effect}` as CueName, mine(event.team) ? 0.8 : 0.45, at, true);
          break;
        }
        case "hero-level":
          if (mine(event.team)) push("level-up", 0.7, undefined, true);
          break;
        case "hero-down":
          if (mine(event.team)) push("hero-down", 0.7, undefined, true);
          break;
        case "hero-up":
          if (mine(event.team)) push("hero-up", 0.5, undefined, true);
          break;
        case "researched":
          if (mine(event.team)) push("researched", 0.6, undefined, true);
          break;
        case "rejected":
          if (mine(event.command.team)) push("error", 0.35);
          break;
      }
    }
    if (world.outcome && events.length > 0 && !this.last.has("victory") && !this.last.has("defeat")) {
      push(world.outcome.winners.includes(local) ? "victory" : "defeat", 0.9, undefined, true);
    }
    return out;
  }

  /** Forget rate limits (new match). */
  reset(): void {
    this.last.clear();
  }

  /** Volume and pan for a world point: full on screen, fading out over a screen's width beyond. */
  private place(at: Point, listener: Listener): { gain: number; pan: number } {
    const dx = at.x - listener.center.x;
    const dy = at.y - listener.center.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const half = listener.span / 2;
    const gain = d <= half ? 1 : Math.max(0, 1 - (d - half) / listener.span);
    const pan = Math.max(-1, Math.min(1, dx / half)) * 0.7;
    return { gain, pan };
  }
}

/**
 * How tense the moment is, 0..1: enemies near your cores. Drives the music.
 */
export function tension(world: World, local: TeamId, content: Content): number {
  const team = world.teams[local];
  if (!team || team.coreId === -1) return 0;
  const cores = world.entities.filter((e) => e.kind === "building" && e.team === local && e.defId === content.races[team.raceId]!.core);
  let near = 0;
  for (const e of world.entities) {
    if (e.kind !== "unit" || e.hp <= 0 || !hostile(world, e.team, local)) continue;
    for (const core of cores) {
      const dx = e.x - core.x;
      const dy = e.y - core.y;
      if (dx * dx + dy * dy < 900 * 900) {
        near += 1;
        break;
      }
    }
  }
  return Math.min(1, near / 20);
}
