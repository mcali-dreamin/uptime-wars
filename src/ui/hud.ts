// Top bar numbers, the status line, and the hint line over the map.

import { TICK_RATE, hashWorld } from "../sim";
import { groundOrderLabel, leftClickOrders, type Selection } from "../game/selection";
import { HUMAN, type Session } from "../game/session";
import { $ } from "./dom";

export function clock(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class Hud {
  private readonly uptime = $("uptime");
  private readonly compute = $("compute");
  private readonly core = $("core");
  private readonly wave = $("wave");
  private readonly nextWave = $("next-wave");
  private readonly status = $("status");
  private readonly hint = $("hint");

  constructor(private readonly session: Session) {}

  update(selection: Selection, paused: boolean): void {
    const { world } = this.session;
    const team = this.session.team;
    const core = this.session.core();
    this.compute.textContent = String(team.compute);
    this.core.textContent = core
      ? `${Math.max(0, Math.ceil(core.hp))} / ${core.maxHp}`
      : this.session.builder()
        ? "not deployed"
        : "offline";
    this.uptime.textContent = clock((world.outcome?.tick ?? world.tick) / TICK_RATE);
    this.wave.textContent = String(world.waves.nextIndex);
    this.nextWave.textContent = `${Math.max(0, Math.ceil((world.waves.nextWaveTick - world.tick) / TICK_RATE))}s`;
    if (!world.outcome) {
      this.status.textContent = paused ? "PAUSED (P)" : "";
      this.status.className = "";
    }
    this.hint.textContent = world.outcome ? "" : this.hintFor(selection);
  }

  /** One line telling the player what they can do right now. */
  private hintFor(selection: Selection): string {
    if (selection.kind === "found") return "Click open ground to deploy your core there · right-click or Esc to cancel";
    if (selection.kind === "place") return "Click inside the ring to build · Shift-click to build several · right-click or Esc to cancel";
    const order = groundOrderLabel(this.session, selection);
    if (order && leftClickOrders(this.session, selection)) {
      return "Click the ground to walk your deploy agent · press C to choose where your core goes";
    }
    if (order) return `Right-click the ground: ${order.toLowerCase()} · Esc to deselect`;
    if (this.session.deploying) return "Click your deploy agent (the green diamond) to select it · Space to find it";
    return "";
  }

  announce(): string {
    const { world } = this.session;
    const outcome = world.outcome!;
    const won = outcome.winner === HUMAN;
    const uptime = clock(outcome.tick / TICK_RATE);
    const summary = won
      ? `NEST OFFLINE - you took down the botnet at ${uptime}.`
      : this.session.deploying
        ? "OUTAGE - your deploy agent was lost before the core came online."
        : `OUTAGE - uptime ${uptime}, reached wave ${world.waves.nextIndex}.`;
    this.status.textContent = `${summary} Press R to pick a race for a new web. [${hashWorld(world)}]`;
    this.status.className = won ? "won" : "lost";
    return won ? "NEST OFFLINE" : `OUTAGE · uptime ${uptime}`;
  }
}
