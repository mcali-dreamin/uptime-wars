// Top bar numbers, the status line, and the hint line over the map.

import { TICK_RATE, threatPermille, computeBalance, farmSpots, farmsStanding, hashWorld, hordeTeam, incomeRate, isCore, previewWave, rulesLabel, userCapacity } from "../sim";

const RULES_NAME = { coop: "Co-op", ffa: "Free-for-all", custom: "Custom rules" } as const;
import { groundOrderLabel, leftClickOrders, selectedEntity, type Selection } from "../game/selection";
import type { Session } from "../game/session";
import { $ } from "./dom";

/** Later incidents show the big countdown for their last this-many seconds. */
const COUNTDOWN_LAST = 15;

export function clock(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How long a churn number stays up after the last user left. */
const CHURN_SHOW_MS = 2500;

export class Hud {
  private readonly uptime = $("uptime");
  private readonly money = $("money");
  private readonly compute = $("compute");
  private readonly computeStat = $("compute-stat");
  private readonly users = $("users");
  private readonly income = $("income");
  private readonly churn = $("churn");
  /** Users last frame, and how many were lost recently, to flash churn. */
  private lastUsers = 0;
  private lost = 0;
  private lostAt = -Infinity;
  private readonly core = $("core");
  private readonly nest = $("nest");
  private readonly nestStat = $("nest-stat");
  private readonly nextWave = $("next-wave");
  private readonly status = $("status");
  private readonly threat = $("threat");
  private readonly countdown = $("countdown");
  private readonly countdownLabel = $("countdown-label");
  private readonly countdownTime = $("countdown-time");
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
    this.money.textContent = String(team.money);
    this.updateBanked();
    const waiting = team.waitingOnCompute === true;
    this.users.textContent =
      team.coreId === -1 ? "0" : `${team.users} / ${userCapacity(world, this.session.content, team)}${waiting ? " · need compute" : ""}`;
    this.users.title = waiting
      ? "New users are waiting for compute: your army's squads get theirs first. Build a generator (past the limit at the top core tier, at a price) or field fewer spawners."
      : "Users pay $ every second. They arrive toward your capacity (core + Web Apps) while you have compute free to serve them.";
    this.updateIncome();
    this.updateCompute();
    const cores = world.entities.filter((e) => e.hp > 0 && isCore(this.session.content, team, e)).length;
    this.core.textContent = core
      ? `${Math.max(0, Math.ceil(core.hp))} / ${core.maxHp}${cores > 1 ? ` · ${cores} up` : ""}`
      : this.session.builder()
        ? "not deployed"
        : "offline";
    this.uptime.textContent = clock((world.outcome?.tick ?? world.tick) / TICK_RATE);
    this.updateNest();
    this.nextWave.textContent = `in ${Math.max(0, Math.ceil((world.waves.nextWaveTick - world.tick) / TICK_RATE))}s`;
    this.updatePreview(world.waves.nextIndex + 1);
    this.updateThreat();
    this.updateCountdown();
    if (!world.outcome) {
      const waiting = this.session.waitingOn().filter((team) => team !== this.session.local);
      this.status.textContent = paused
        ? "PAUSED (P)"
        : waiting.length > 0
          ? `Waiting for ${waiting.map((team) => `Player ${team + 1}`).join(", ")}…`
          : this.session.net
            ? `${RULES_NAME[rulesLabel(world)]} · you're Player ${this.session.local + 1}`
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
    this.income.title = `$ from users ${rate.users.toFixed(1)}/s (${share}%) · base ${rate.base.toFixed(1)}/s`;
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

  /**
   * A pile of $ counts toward the botnet's threat just like buildings do, but
   * defends nothing. Past half the threat's reference worth, $ turns amber.
   */
  private updateBanked(): void {
    const team = this.session.team;
    const threshold = (this.session.content.waves.threat?.referenceWorth ?? Infinity) / 2;
    const banked = team.coreId !== -1 && team.money >= threshold;
    if (this.money.classList.contains("banked") === banked) return;
    this.money.classList.toggle("banked", banked);
    this.money.title = banked
      ? "Banked $ draws the botnet like buildings do (see Threat), but defends nothing. Spend it: build, research, or rank a spawner up (U)."
      : "";
  }

  /** Compute in use / supplied; red, with how much slower everything runs, when over. */
  private updateCompute(): void {
    const { world, content } = this.session;
    const team = this.session.team;
    if (team.coreId === -1) {
      this.compute.textContent = "-";
      this.computeStat.classList.remove("overloaded");
      return;
    }
    const { supply, demand } = computeBalance(world, content, team);
    const over = team.overload > 0;
    const capped = team.capped === true;
    this.compute.textContent = over
      ? `${demand} / ${supply} · over: users leaving, ${Math.max(1, Math.round(team.overload / 10))}% slow`
      : capped
        ? `${demand} / ${supply} · army cap: build compute`
        : `${demand} / ${supply}`;
    this.computeStat.classList.toggle("overloaded", over);
    this.computeStat.title =
      `In use / supplied. Each user uses ${content.economy.compute.perUser}, each unit about ${content.economy.compute.perUnit}. ` +
      "Compute is also your army cap: a spawner or a Function's burst only adds a unit if its upkeep fits in what's free, so more spawners reinforce faster but never field more. " +
      "Generators are limited per core tier: tech up the core to raise the cap, or rank spawners up (U) for better units per compute. " +
      "New users only take compute your squads don't need, so a bigger army means fewer users, never the other way round. " +
      "At the top core tier generators have no hard limit: each one past it just costs more. " +
      "Over capacity (a generator lost), users leave and your towers, spawners and research slow down.";
  }

  /** The win condition, always in view: farms left, then the nest's health. */
  private updateNest(): void {
    const { world, content } = this.session;
    const horde = hordeTeam(world);
    const nest = horde ? world.entities.find((e) => e.hp > 0 && isCore(content, horde, e)) : undefined;
    let text: string;
    if (!horde || !nest) text = "offline";
    else {
      const standing = farmsStanding(world, content, horde.id);
      const total = farmSpots(world.terrain).length;
      text = standing > 0 ? `shielded · ${total - standing}/${total} farms down` : `exposed · ${Math.ceil(nest.hp)} / ${nest.maxHp}`;
    }
    if (this.nest.textContent !== text) this.nest.textContent = text;
    this.nestStat.classList.toggle("exposed", text.startsWith("exposed"));
  }

  /** How much your base has raised the stakes, on the preview line. */
  private updateThreat(): void {
    const permille = threatPermille(this.session.world, this.session.content);
    const text = permille > 1050 ? `Threat ×${(permille / 1000).toFixed(1)}` : "";
    if (this.threat.textContent !== text) this.threat.textContent = text;
  }

  /** What the next wave brings: its name, its creeps (new ones marked), and any boss. */
  private updatePreview(wave: number): void {
    if (wave === this.previewed) return;
    this.previewed = wave;
    const { units } = this.session.content;
    const preview = previewWave(this.session.content, wave);
    this.previewTitle.textContent = `Next: ${preview.name}`;
    this.previewTitle.title = `Incident ${wave}`;
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

  /**
   * The clock you play against, big and centred: the whole run-up to the
   * first incident once your core is online, and the last seconds before
   * every one after it.
   */
  private updateCountdown(): void {
    const { world } = this.session;
    const left = Math.max(0, Math.ceil((world.waves.nextWaveTick - world.tick) / TICK_RATE));
    const first = world.waves.nextIndex === 0;
    const show = !world.outcome && !this.session.deploying && left > 0 && (first ? left <= 90 : left <= COUNTDOWN_LAST);
    this.countdown.hidden = !show;
    if (!show) return;
    const next = previewWave(this.session.content, world.waves.nextIndex + 1);
    this.countdownLabel.textContent = first ? `${next.name} hits your base in` : `Incident ${next.wave} · ${next.name} in`;
    this.countdownTime.textContent = clock(left);
    this.countdown.classList.toggle("urgent", left <= 10);
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
      return "Click inside the ring to build";
    }
    if (selection.kind === "spawners") {
      if (selection.armed) return "Click the ground: rally all of them · Esc to cancel";
      return "Right-click or T, then click: rally all of them · Shift-click a building: add or remove";
    }
    if (selection.kind === "army") {
      if (selection.armed) return `Click the ground: ${selection.armed === "move" ? "move (ignores enemies)" : "attack-move"} · Esc to cancel`;
      return "Right-click: attack-move · F then click: move · Shift: add · Z: whole army";
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
    // Your uptime ends when you go offline, even if others played on.
    const uptime = clock((this.session.team.downTick ?? outcome.tick) / TICK_RATE);
    const names = (teams: number[]) => teams.map((t) => `Player ${t + 1}`).join(" & ");
    const others = outcome.winners.filter((t) => t !== this.session.local);
    const hordeWon = outcome.winners.some((t) => world.teams[t]?.controller !== "human");
    if (outcome.reason === "last-standing" || (!won && !hordeWon && outcome.winners.length > 0)) {
      const together = others.length > 0 ? ` with ${names(others)}` : "";
      const summary = won
        ? `LAST ${others.length > 0 ? "ALLIANCE" : "CORE"} STANDING - you outlasted everyone${together}. Uptime ${uptime}.`
        : `OUTAGE - ${names(outcome.winners)} ${outcome.winners.length > 1 ? "are" : "is"} the last standing. You lasted ${uptime}.`;
      this.status.textContent = `${summary} Press R to pick a race for a new web. [${hashWorld(world)}]`;
      this.status.className = won ? "won" : "lost";
      return won ? "VICTORY · last standing" : `DEFEAT · ${names(outcome.winners)} ${outcome.winners.length > 1 ? "win" : "wins"}`;
    }
    const summary = won
      ? `NEST OFFLINE - you took down the botnet at ${uptime}.`
      : this.session.deploying
        ? "OUTAGE - your deploy agent was lost before the core came online."
        : `OUTAGE - uptime ${uptime}, incident ${world.waves.nextIndex}, peak ${this.session.team.peakUsers} users.`;
    this.status.textContent = `${summary} Press R to pick a race for a new web. [${hashWorld(world)}]`;
    this.status.className = won ? "won" : "lost";
    return won ? "NEST OFFLINE" : `OUTAGE · uptime ${uptime}`;
  }
}
