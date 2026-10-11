// Top bar numbers, the status line, and the hint line over the map.

import { TICK_RATE, hashWorld, incomeRate, isCore, previewWave, userCapacity } from "../sim";
import { groundOrderLabel, leftClickOrders, selectedEntity, type Selection } from "../game/selection";
import type { Session } from "../game/session";
import { $ } from "./dom";

export function clock(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How long a churn number stays up after the last user left. */
const CHURN_SHOW_MS = 2500;

export class Hud {
  private readonly uptime = $("uptime");
  private readonly compute = $("compute");
  private readonly users = $("users");
  private readonly income = $("income");
  private readonly churn = $("churn");
  /** Users last frame, and how many were lost recently, to flash churn. */
  private lastUsers = 0;
  private lost = 0;
  private lostAt = -Infinity;
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
    this.updateIncome();
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
      const waiting = this.session.waitingOn().filter((team) => team !== this.session.local);
      this.status.textContent = paused
        ? "PAUSED (P)"
        : waiting.length > 0
          ? `Waiting for ${waiting.map((team) => `Player ${team + 1}`).join(", ")}…`
          : this.session.net
            ? `Co-op · you're Player ${this.session.local + 1}`
            : "";
      this.status.className = "";
    }
    this.hint.textContent = world.outcome ? "" : this.hintFor(selection);
  }

  /**
   * Compute per second and where it comes from, and a red "-N" when users
   * leave: the two things that make users feel like the economy they are.
   */
  private updateIncome(): void {
    const { world, content } = this.session;
    const team = this.session.team;
    const rate = incomeRate(world, content, team);
    const total = rate.base + rate.buildings + rate.users;
    this.income.textContent = `+${total.toFixed(1)}/s`;
    const share = total > 0 ? Math.round((100 * rate.users) / total) : 0;
    this.income.title = `Users ${rate.users.toFixed(1)}/s (${share}%) · buildings ${rate.buildings.toFixed(1)}/s · base ${rate.base.toFixed(1)}/s`;
    const now = performance.now();
    if (team.users < this.lastUsers) {
      this.lost = now - this.lostAt < CHURN_SHOW_MS ? this.lost + (this.lastUsers - team.users) : this.lastUsers - team.users;
      this.lostAt = now;
    }
    this.lastUsers = team.users;
    const showing = now - this.lostAt < CHURN_SHOW_MS && this.lost > 0;
    this.churn.textContent = showing ? `−${this.lost}` : "";
    this.users.classList.toggle("churning", showing);
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
    if (selection.kind === "cast") {
      const ability = this.session.content.heroes.abilities[selection.ability]!;
      return `${ability.name}: click ${ability.target === "enemy" ? "an enemy" : "where"} · right-click or Esc to cancel`;
    }
    const entity = selectedEntity(this.session, selection);
    if (entity?.kind === "unit" && entity.mode === "hero") {
      return leftClickOrders(this.session, selection)
        ? "Click the ground to move · Esc to cancel"
        : "Right-click: move, or attack an enemy · 1-4 abilities · Shift+1-4 learn";
    }
    if (selection.kind === "place") {
      return this.session.content.buildings[selection.building]?.onWell
        ? "Click a data well (glowing crystals) inside your network"
        : "Click inside the ring to build";
    }
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
    const won = outcome.winners.includes(this.session.local);
    // Co-op: your uptime ends when you go offline, even if your allies played on.
    const uptime = clock((this.session.team.downTick ?? outcome.tick) / TICK_RATE);
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
