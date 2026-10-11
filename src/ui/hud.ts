// Top bar numbers, the status line, and the hint line over the map.

import { TICK_RATE, hashWorld, isCore, previewWave, userCapacity } from "../sim";
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
  private readonly users = $("users");
  private readonly core = $("core");
  private readonly wave = $("wave");
  private readonly nextWave = $("next-wave");
  private readonly status = $("status");
  private readonly hint = $("hint");
  private readonly previewTitle = $("preview-title");
  private readonly previewCreeps = $("preview-creeps");
  /** Which wave the preview shows, so it's rebuilt only when that changes. */
  private previewed = -1;

  constructor(private readonly session: Session) {}

  update(selection: Selection, paused: boolean): void {
    const { world } = this.session;
    const team = this.session.team;
    const core = this.session.core();
    this.compute.textContent = String(team.compute);
    this.users.textContent = team.coreId === -1 ? "0" : `${team.users} / ${userCapacity(world, this.session.content, team)}`;
    const cores = world.entities.filter((e) => e.hp > 0 && isCore(this.session.content, team, e)).length;
    this.core.textContent = core
      ? `${Math.max(0, Math.ceil(core.hp))} / ${core.maxHp}${cores > 1 ? ` · ${cores} up` : ""}`
      : this.session.builder()
        ? "not deployed"
        : "offline";
    this.uptime.textContent = clock((world.outcome?.tick ?? world.tick) / TICK_RATE);
    this.wave.textContent = String(world.waves.nextIndex);
    this.nextWave.textContent = `${Math.max(0, Math.ceil((world.waves.nextWaveTick - world.tick) / TICK_RATE))}s`;
    this.updatePreview(world.waves.nextIndex + 1);
    if (!world.outcome) {
      this.status.textContent = paused ? "PAUSED (P)" : "";
      this.status.className = "";
    }
    this.hint.textContent = world.outcome ? "" : this.hintFor(selection);
  }

  /** What the next wave brings: its name, its creeps (new ones marked), and any boss. */
  private updatePreview(wave: number): void {
    if (wave === this.previewed) return;
    this.previewed = wave;
    const { units } = this.session.content;
    const preview = previewWave(this.session.content, wave);
    this.previewTitle.textContent = `Wave ${wave} · ${preview.name}`;
    const parts: HTMLElement[] = preview.creeps.map((id) => {
      const span = document.createElement("span");
      const fresh = preview.fresh.includes(id) && wave > 1;
      span.textContent = fresh ? `${units[id]!.name} (new)` : units[id]!.name;
      if (fresh) span.className = "new";
      return span;
    });
    if (preview.bosses > 0) {
      const boss = document.createElement("span");
      boss.className = "boss";
      boss.textContent = `${preview.bosses > 1 ? `${preview.bosses}× ` : ""}${units[preview.boss]!.name} BOSS`;
      parts.push(boss);
    }
    this.previewCreeps.replaceChildren(...parts.flatMap((part, i) => (i === 0 ? [part] : [document.createTextNode(" · "), part])));
  }

  /** One line telling the player what they can do right now. */
  private hintFor(selection: Selection): string {
    if (selection.kind === "found") return "Click to deploy your core";
    if (selection.kind === "place") return "Click inside the ring to build";
    if (!this.session.deploying) {
      const label = groundOrderLabel(this.session, selection);
      if (!label) return "";
      return leftClickOrders(this.session, selection)
        ? `Click the ground: ${label.toLowerCase()} · Esc to cancel`
        : `Right-click or T, then click: ${label.toLowerCase()}`;
    }
    if (groundOrderLabel(this.session, selection) && leftClickOrders(this.session, selection)) {
      return "Click to walk · C to deploy your core";
    }
    return "Click your agent to select it";
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
        : `OUTAGE - uptime ${uptime}, wave ${world.waves.nextIndex}, peak ${this.session.team.peakUsers} users.`;
    this.status.textContent = `${summary} Press R to pick a race for a new web. [${hashWorld(world)}]`;
    this.status.className = won ? "won" : "lost";
    return won ? "NEST OFFLINE" : `OUTAGE · uptime ${uptime}`;
  }
}
