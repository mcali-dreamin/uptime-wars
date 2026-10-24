// The hero's card and command buttons.
//
// The card (top-left of the map) is always there once you have a hero: name,
// level, XP, skill points, or the respawn timer. Click it, or press Q, to
// select the hero; Q again centres on it. Under it sit the six inventory
// slots: click a filled one to use a consumable or active (Alt+1..6 works
// too), and while the hero stands at the shop each slot grows a sell badge.
// With the hero selected the command card shows its four abilities: number
// keys cast, Shift+number (or the +) spends a skill point — and the shop's
// items, when the hero is in range.

import type { Session } from "../game/session";
import { MAX_ITEMS, TICK_RATE, atShop, type Team } from "../sim";
import { castBlocker, heroOf, learnBlocker, levelForRank, skillPoints, xpForLevel } from "../sim/heroes";
import { $ } from "./dom";
import { abilityEffect } from "./text";

export interface HeroBarEvents {
  select(): void;
  cast(ability: string): void;
  learn(ability: string): void;
  hover(ability: string | null): void;
  use(slot: number): void;
  sell(slot: number): void;
  hoverItem(item: { id: string; slot: number } | null): void;
}

export class HeroBar {
  private readonly card = $("hero-card");
  private readonly name = $("hero-name");
  private readonly level = $("hero-level");
  private readonly xp = $("hero-xp");
  private readonly status = $("hero-status");
  private readonly slots = $("hero-items");
  /** What the slot row was last built from, so it's rebuilt only when it changes. */
  private slotKey = "";

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

  /** The hero's inventory, with slot numbers. */
  inventory(team: Team = this.session.team): { item: string; charges?: number }[] {
    return team.hero?.items ?? [];
  }

  update(): void {
    const { team, content, world } = this.session;
    const state = team.hero;
    if (!state || !team.heroId) {
      this.card.hidden = true;
      this.slots.hidden = true;
      this.slotKey = "";
      return;
    }
    this.card.hidden = false;
    this.slots.hidden = false;
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
    this.updateSlots();
  }

  /** The six slots under the card: filled ones use on click, and sell while at the shop. */
  private updateSlots(): void {
    const { team, content } = this.session;
    const shop = atShop(this.session.world, content, team);
    const items = this.inventory();
    const key = `${items.map((s) => `${s.item}:${s.charges ?? "-"}`).join(",")}|${shop ? 1 : 0}`;
    if (key !== this.slotKey) {
      this.slotKey = key;
      this.slots.replaceChildren(
        ...Array.from({ length: MAX_ITEMS }, (_, slot) => {
          const stack = items[slot];
          const button = document.createElement("button");
          button.className = "hero-slot";
          button.dataset.slot = String(slot);
          if (stack) {
            const def = content.items.items[stack.item]!;
            button.classList.toggle("filled", true);
            button.classList.toggle("usable", def.active !== undefined);
            button.append(document.createTextNode(def.name), document.createElement("small"));
            button.title = `${def.name} · Alt+${slot + 1}`;
            button.addEventListener("click", () => this.events.use(slot));
            button.addEventListener("pointerenter", () => this.events.hoverItem({ id: stack.item, slot }));
            button.addEventListener("pointerleave", () => this.events.hoverItem(null));
            const sell = document.createElement("span");
            sell.className = "sell";
            sell.textContent = `$${Math.floor((def.cost * content.items.sellPermille) / 1000)}`;
            sell.title = "Sell (while at the shop)";
            sell.addEventListener("click", (event) => {
              event.stopPropagation();
              this.events.sell(slot);
            });
            button.append(sell);
          } else {
            button.title = `Empty slot · Alt+${slot + 1}`;
            button.disabled = true;
          }
          return button;
        }),
      );
    }
    this.slots.classList.toggle("at-shop", shop);
    for (const button of this.slots.querySelectorAll<HTMLButtonElement>(".hero-slot")) {
      const stack = items[Number(button.dataset.slot)];
      const def = stack ? content.items.items[stack.item]! : undefined;
      const small = button.querySelector("small");
      if (!small) continue; // An empty slot has no charge line.
      const text = stack ? (def!.charges ? `×${stack.charges ?? 1}` : "passive") : "";
      if (small.textContent !== text) small.textContent = text;
    }
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

  /** Drop the hovered ability: its button is being taken off the bar. */
  unhover(): void {
    this.events.hover(null);
  }

  /** Lines for the info card when hovering an ability. */
  describe(id: string): { title: string; lines: string[] } {
    const { content, team } = this.session;
    const ability = content.heroes.abilities[id]!;
    const rank = team.hero?.ranks[id] ?? 0;
    const lines = [ability.description];
    const effect = abilityEffect(content, ability, rank);
    lines.push(`${effect}${rank ? ` (rank ${rank})` : ""}`);
    lines.push(`Cooldown ${Math.round(ability.cooldownTicks / TICK_RATE)}s${ability.range ? ` · range ${ability.range}` : ""}`);
    if (rank < ability.maxRank) lines.push(`Rank ${rank + 1} needs hero level ${levelForRank(content, ability, rank + 1)}`);
    return { title: `${ability.name}${ability.maxRank === 1 ? " (ultimate)" : ""}`, lines };
  }
}

export function heroUnit(session: Session, team: Team = session.team) {
  return heroOf(session.world, team);
}
