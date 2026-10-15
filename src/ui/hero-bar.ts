// The hero's card and command buttons.
//
// The card (top-left of the map) is always there once you have a hero: name,
// level, XP, skill points, or the respawn timer. Click it, or press Q, to
// select the hero; Q again centres on it. With the hero selected the command
// card shows its four abilities: number keys cast, Shift+number (or the +)
// spends a skill point.

import type { Session } from "../game/session";
import { TICK_RATE, type Team } from "../sim";
import { abilityAmount, castBlocker, heroOf, learnBlocker, levelForRank, skillPoints, xpForLevel } from "../sim/heroes";
import { $ } from "./dom";

export interface HeroBarEvents {
  select(): void;
  cast(ability: string): void;
  learn(ability: string): void;
  hover(ability: string | null): void;
}

export class HeroBar {
  private readonly card = $("hero-card");
  private readonly name = $("hero-name");
  private readonly level = $("hero-level");
  private readonly xp = $("hero-xp");
  private readonly status = $("hero-status");

  constructor(
    private readonly session: Session,
    private readonly events: HeroBarEvents,
  ) {
    this.card.addEventListener("click", () => this.events.select());
  }

  /** The hero's abilities, in hotkey order. */
  abilities(): string[] {
    const heroId = this.session.team.heroId;
    return heroId ? (this.session.content.heroes.heroes[heroId]?.abilities ?? []) : [];
  }

  update(): void {
    const { team, content, world } = this.session;
    const state = team.hero;
    if (!state || !team.heroId) {
      this.card.hidden = true;
      return;
    }
    this.card.hidden = false;
    this.name.textContent = content.units[team.heroId]!.name;
    this.level.textContent = `Lv ${state.level}`;
    const max = state.level >= content.heroes.maxLevel;
    const from = xpForLevel(content, state.level);
    const to = xpForLevel(content, state.level + 1);
    this.xp.style.setProperty("--xp", max ? "1" : String((state.xp - from) / (to - from)));
    const points = skillPoints(content, state);
    if (state.respawnAt !== null) {
      this.status.textContent = `Respawning in ${Math.ceil((state.respawnAt - world.tick) / TICK_RATE)}s`;
      this.card.classList.add("down");
    } else {
      this.card.classList.remove("down");
      this.status.textContent = points > 0 ? `${points} skill point${points > 1 ? "s" : ""} to spend · click` : max ? "Max level" : `${Math.floor(state.xp - from)} / ${to - from} XP`;
    }
    this.card.classList.toggle("points", points > 0);
  }

  /** Command-card buttons for the abilities. */
  buttons(): HTMLElement[] {
    const { content } = this.session;
    return this.abilities().map((id, index) => {
      const ability = content.heroes.abilities[id]!;
      const button = document.createElement("button");
      button.className = "build-btn ability-btn";
      button.dataset.ability = id;
      button.append(document.createTextNode(ability.name), document.createElement("small"));
      const learn = document.createElement("span");
      learn.className = "learn";
      learn.textContent = "+";
      learn.title = `Learn (Shift+${index + 1})`;
      learn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.events.learn(id);
      });
      button.append(learn);
      button.addEventListener("click", () => this.events.cast(id));
      button.addEventListener("pointerenter", () => this.events.hover(id));
      button.addEventListener("pointerleave", () => this.events.hover(null));
      return button;
    });
  }

  /** Refresh the ability buttons' state (call every frame while they're shown). */
  refresh(root: HTMLElement, aiming: string | null): void {
    const { content, team, world } = this.session;
    const state = team.hero;
    for (const button of root.querySelectorAll<HTMLButtonElement>(".ability-btn")) {
      const id = button.dataset.ability!;
      const ability = content.heroes.abilities[id]!;
      const index = this.abilities().indexOf(id) + 1;
      const rank = state?.ranks[id] ?? 0;
      const cooldown = state?.cooldowns[id] ?? 0;
      const blocked = castBlocker(world, content, team, id);
      button.disabled = blocked !== null && blocked !== "on cooldown";
      button.classList.toggle("selected", aiming === id);
      button.classList.toggle("cooling", cooldown > 0);
      button.style.setProperty("--progress", cooldown > 0 ? String(1 - cooldown / ability.cooldownTicks) : "0");
      const ranks = ability.maxRank > 1 ? ` · ${rank}/${ability.maxRank}` : rank ? "" : " · ult";
      button.querySelector("small")!.textContent =
        cooldown > 0 ? `${index} · ${Math.ceil(cooldown / TICK_RATE)}s` : rank === 0 ? `${index} · not learned${ranks}` : `${index}${ranks}`;
      const learn = button.querySelector<HTMLElement>(".learn")!;
      learn.hidden = learnBlocker(content, team, id) !== null;
      // A disabled button swallows clicks on its children; keep learning possible.
      if (!learn.hidden) button.disabled = false;
    }
  }

  /** Lines for the info card when hovering an ability. */
  describe(id: string): { title: string; lines: string[] } {
    const { content, team } = this.session;
    const ability = content.heroes.abilities[id]!;
    const rank = team.hero?.ranks[id] ?? 0;
    const lines = [ability.description];
    const shown = Math.max(1, rank);
    const amount = abilityAmount(ability, shown);
    const secs = Math.round((ability.durationTicks ?? 0) / TICK_RATE);
    const effect = (() => {
      switch (ability.effect) {
        case "blast":
          return `${Math.round(amount)} damage in a ${ability.radius}px area`;
        case "strike":
          return `${Math.round(amount)} damage to one target`;
        case "heal":
          return `Heals ${Math.round(amount)} within ${ability.radius}px`;
        case "decoy":
          return `Decoy with ${Math.round(amount)} hp for ${secs}s`;
        case "summon":
          return `${Math.round(amount)} × ${content.units[ability.unit!]!.name} for ${secs}s`;
        case "buff":
          return `Your units deal +${Math.round(amount * 100)}% damage for ${secs}s`;
        case "shield":
          return `Buildings within ${ability.radius}px take ${Math.round(amount / 10)}% less damage for ${secs}s`;
        case "build":
          return `Finishes construction and mends ${Math.round(amount)} within ${ability.radius}px`;
        case "trigger":
          return `Runs every function within ${ability.radius}px now, free`;
        case "discount":
          return `Function runs are free for ${secs}s`;
        case "funds":
          return `+$${Math.round(amount)}`;
        case "stun":
          return `Freezes creeps within ${ability.radius}px for ${secs}s${amount ? ` · ${Math.round(amount)} damage` : ""}`;
        case "users":
          return `Up to ${Math.round(amount)} users arrive now`;
      }
    })();
    lines.push(`${effect}${rank ? ` (rank ${rank})` : ""}`);
    lines.push(`Cooldown ${Math.round(ability.cooldownTicks / TICK_RATE)}s${ability.range ? ` · range ${ability.range}` : ""}`);
    if (rank < ability.maxRank) lines.push(`Rank ${rank + 1} needs hero level ${levelForRank(content, ability, rank + 1)}`);
    return { title: `${ability.name}${ability.maxRank === 1 ? " (ultimate)" : ""}`, lines };
  }
}

export function heroUnit(session: Session, team: Team = session.team) {
  return heroOf(session.world, team);
}
