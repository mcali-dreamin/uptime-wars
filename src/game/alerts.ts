// Alerts: tell the player when something of theirs is in trouble, wherever
// the camera is. Pure: it turns each tick's sim events into alerts, rate
// limited per kind and place, so a long siege is one alert every few seconds,
// not one per shot. The UI shows the banner, flashes the minimap, plays the
// cue, and Space jumps the camera to the latest one.

import { allied, isCore, type Content, type Unit, type Point, type SimEvent, type TeamId, type World } from "../sim";

export type AlertKind = "attack" | "core" | "lost" | "hero" | "spread" | "agent" | "fighting" | "wiped" | "camp" | "site";

export interface Alert {
  kind: AlertKind;
  text: string;
  x: number;
  y: number;
  /** Seconds (caller's clock) when it was raised. */
  at: number;
}

/** Quiet time per kind (seconds) before the same kind, near the same place, alerts again. */
const QUIET: Record<AlertKind, number> = { attack: 12, core: 8, lost: 0, hero: 0, spread: 0, agent: 0, fighting: 20, wiped: 20, camp: 0, site: 0 };
/** Soldier deaths inside this window (seconds) count toward "wiped". */
const WIPE_WINDOW = 10;
/** Deaths in the window needed before an army counts as wiped. */
const WIPE_MIN_DEATHS = 4;
/** Two alerts of a kind closer than this (world px) count as the same place. */
const SAME_PLACE = 900;

export class Alerts {
  private readonly last: Alert[] = [];
  /** Most recent first, for jump-to and the minimap flash. */
  readonly recent: Alert[] = [];
  private deaths: { at: number; x: number; y: number }[] = [];
  /** Your soldiers as of the last update: a death counts toward "wiped" only if it was one (not a decoy, the hero or an agent). */
  private soldiers = new Set<number>();

  constructor(private readonly content: Content) {}

  reset(): void {
    this.last.length = 0;
    this.recent.length = 0;
    this.deaths = [];
    this.soldiers.clear();
  }

  /** The alerts this tick's events raise for `local`, at time `now` (seconds). */
  update(world: World, events: readonly SimEvent[], local: TeamId, now: number, onScreen: (p: Point) => boolean, canSee: (p: Point) => boolean = onScreen): Alert[] {
    const out: Alert[] = [];
    const raise = (kind: AlertKind, text: string, x: number, y: number, quietWhenVisible: boolean) => {
      // Fights you're watching don't need telling, but losses and the hero always do.
      if (quietWhenVisible && onScreen({ x, y })) return;
      const quiet = QUIET[kind];
      const prior = this.last.find((a) => a.kind === kind && Math.hypot(a.x - x, a.y - y) < SAME_PLACE);
      if (prior && now - prior.at < quiet) return;
      const alert = { kind, text, x, y, at: now };
      if (prior) this.last.splice(this.last.indexOf(prior), 1);
      this.last.push(alert);
      this.recent.unshift(alert);
      if (this.recent.length > 8) this.recent.pop();
      out.push(alert);
    };
    const team = world.teams[local];
    if (!team) return out;
    for (const event of events) {
      if (event.type === "shot") {
        const target = world.entities.find((e) => e.id === event.to);
        if (!target) continue;
        if (target.team === local && event.team !== local) {
          if (target.kind === "building" && isCore(this.content, team, target)) {
            raise("core", "Your core is under attack", target.x, target.y, false);
            continue;
          }
          if (target.kind === "building") {
            raise("attack", "Your base is under attack", target.x, target.y, true);
            continue;
          }
          if (target.kind === "unit" && target.mode === "guard") raise("fighting", "Your army is fighting", target.x, target.y, true);
        } else if (target.kind !== "building" && target.team !== local && !allied(world, local, target.team)) {
          const shooter = world.entities.find((e) => e.id === event.from);
          if (shooter && shooter.kind === "unit" && shooter.team === local && (shooter as Unit).mode === "guard") {
            raise("fighting", "Your army is fighting", shooter.x, shooter.y, true);
          }
        }
      } else if (event.type === "death" && event.team === local && event.kind === "unit") {
        if (this.soldiers.has(event.id)) this.deaths.push({ at: now, x: event.x, y: event.y });
      } else if (event.type === "death" && event.team === local && event.kind === "building") {
        raise("lost", `${this.content.buildings[event.defId]?.name ?? "A building"} lost`, event.x, event.y, false);
      } else if (event.type === "hero-down" && event.team === local) {
        raise("hero", "Your hero has fallen", event.x, event.y, false);
      } else if (event.type === "agentLost" && event.team === local) {
        raise("agent", "Your deploy agent was lost · the $ is gone", event.x, event.y, false);
      } else if (event.type === "campCleared" && event.team === local) {
        raise("camp", "Camp cleared", event.x, event.y, false);
      } else if (event.type === "siteCaptured") {
        if (event.team === local) raise("site", "Site captured", event.x, event.y, false);
        else if (!allied(world, local, event.team) && event.from !== event.team && canSee({ x: event.x, y: event.y })) {
          const botnet = world.teams[event.team]?.controller === "wave-director";
          raise("site", `${botnet ? "The botnet" : "An enemy"} took a site`, event.x, event.y, false);
        }
      } else if (event.type === "siteLost" && event.team === local) {
        raise("site", "Site lost", event.x, event.y, false);
      } else if (event.type === "infecting") {
        // Where it's headed, so Space takes you there to cut it off.
        raise("spread", "An Infector is heading out · stop it before it builds", event.x, event.y, false);
      } else if (event.type === "infected") {
        raise("spread", "The botnet is building an Infected Node", event.x, event.y, false);
      }
    }
    this.deaths = this.deaths.filter((d) => now - d.at <= WIPE_WINDOW);
    // Soldiers are units in guard mode, as in src/game/selection.ts isSoldier.
    this.soldiers.clear();
    for (const e of world.entities) if (e.kind === "unit" && e.team === local && e.hp > 0 && e.mode === "guard") this.soldiers.add(e.id);
    if (this.deaths.length >= WIPE_MIN_DEATHS) {
      if (this.deaths.length >= this.soldiers.size) {
        const n = this.deaths.length;
        const x = this.deaths.reduce((a, d) => a + d.x, 0) / n;
        const y = this.deaths.reduce((a, d) => a + d.y, 0) / n;
        raise("wiped", "Your army is being wiped out", x, y, false);
      }
    }
    return out;
  }

  /** The newest alert still worth jumping to (within `maxAge` seconds), if any. */
  latest(now: number, maxAge = 30): Alert | null {
    const a = this.recent[0];
    return a && now - a.at <= maxAge ? a : null;
  }
}
