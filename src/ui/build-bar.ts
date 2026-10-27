// The bottom bar, a command card in the WC3 sense: what it shows depends on
// the phase and on what you have selected.
//
// - deploy:   "Deploy core"
// - build:    the race's buildings
// - research: the core is selected, so its upgrades (the race and its base)
// - armory:   the upgrade center is selected, so its army upgrades and traits
// - hero:     the hero is selected, so its abilities (see hero-bar.ts)
// - shop:     a finished Package Registry is selected: the item stock, with
//             prices (number keys buy). Buying needs the hero standing near it;
//             the buttons stay visible and show "locked" when it isn't.

import { affordable, tierLock } from "../game/selection";
import type { Session } from "../game/session";
import { TICK_RATE, buildCost, canResearch, levelOf, nextLevel, nextQueued, projectedTier, queuedCount, slotOf, spotCost, spotState, tierOf, upgradeName, upgradesAt, shopBlocker, type Content } from "../sim";
import { $ } from "./dom";
import type { HeroBar } from "./hero-bar";

export const FOUND_BUTTON = "found";
/** The core card's "Deploy agent" button (trained with A; see InfoPanel's card). */
export const AGENT_BUTTON = "agent";
/** The core card's "Spot capacity" button (rents compute; see InfoPanel's card). */
export const SPOT_BUTTON = "spot";
const UPGRADE_PREFIX = "upgrade:";
const ITEM_PREFIX = "item:";

export type BarMode = "deploy" | "build" | "research" | "armory" | "hero" | "shop";

export interface BuildBarEvents {
  choose(button: string): void;
  research(upgrade: string): void;
  buy(item: string): void;
  hover(button: string | null): void;
  guide(): void;
}

export const upgradeButton = (id: string) => UPGRADE_PREFIX + id;
export const itemButton = (id: string) => ITEM_PREFIX + id;
export const itemOf = (button: string | null) => (button?.startsWith(ITEM_PREFIX) ? button.slice(ITEM_PREFIX.length) : null);
const AIM_PREFIX = "aim:";
/** The "selected" button while aiming an ability. */
export const aimingButton = (ability: string) => AIM_PREFIX + ability;
const aimingOf = (button: string | null) => (button?.startsWith(AIM_PREFIX) ? button.slice(AIM_PREFIX.length) : null);
export const upgradeOf = (button: string | null) =>
  button?.startsWith(UPGRADE_PREFIX) ? button.slice(UPGRADE_PREFIX.length) : null;

/** The shop's stock, in content order. */
export const shopStock = (content: Content): string[] =>
  Object.keys(content.items.items).filter((id) => content.items.items[id]?.shop);

export class BuildBar {
  private readonly root = $("build-bar");
  /** What's on screen, mode plus the state that changes its contents. */
  private rendered = "";

  /** Set once the hero bar exists (it renders the hero mode's buttons). */
  hero: HeroBar | null = null;

  constructor(
    private readonly session: Session,
    private readonly events: BuildBarEvents,
  ) {}

  /** Rebuild when the mode changes; refresh state every frame. */
  update(mode: BarMode, selected: string | null): void {
    const { content, team } = this.session;
    if (mode !== this.rendered) this.render(mode);
    if (mode === "hero") return this.hero?.refresh(this.root, aimingOf(selected));
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(".build-btn")) {
      const id = button.dataset.building!;
      const item = itemOf(id);
      if (item) {
        const def = content.items.items[item]!;
        const blocked = shopBlocker(this.session.world, content, team, item);
        button.disabled = blocked !== null;
        button.classList.toggle("locked", blocked === "hero not at a registry");
        const detail = button.querySelector("small")!;
        const n = shopStock(content).indexOf(item) + 1;
        // Short: six of these share one row, and a wrapped bar resizes the stage.
        const why = blocked === "hero not at a registry" ? "hero away" : blocked === "inventory full" ? "full" : blocked === "not enough $" ? "need $" : blocked;
        const text = why ? `${n} · ${why} · $${def.cost}` : `${n} · $${def.cost}`;
        if (detail.textContent !== text) detail.textContent = text;
        continue;
      }
      const upgrade = upgradeOf(id);
      if (upgrade) {
        const slot = team[slotOf(content, upgrade)];
        const researching = slot?.upgrade === upgrade;
        // Queueable is enough to click: while something researches, the next
        // level (or the next upgrade) queues behind it.
        button.disabled = canResearch(content, team, upgrade, this.session.world) !== null;
        button.classList.toggle("researching", researching);
        const detail = button.querySelector("small")!;
        detail.textContent = this.upgradeDetail(upgrade);
        const progress = researching ? 1 - slot!.remaining / nextLevel(content, team, upgrade).ticks : 0;
        button.style.setProperty("--progress", String(progress));
        continue;
      }
      if (id === AGENT_BUTTON) {
        // One agent at a time, and the core's price up front.
        const cost = content.buildings[this.session.race.core]!.cost;
        const out = this.session.builder() !== undefined;
        const text = out ? "B · already out" : team.money < cost ? `B · need $${cost - team.money}` : `B · $${cost}`;
        const detail = button.querySelector("small")!;
        if (detail.textContent !== text) detail.textContent = text;
        button.disabled = out || team.money < cost;
        button.classList.toggle("selected", false);
        continue;
      }
      if (id === SPOT_BUTTON) {
        const state = spotState(this.session.world, team);
        const cost = spotCost(content, team);
        const text = this.spotText(state, cost);
        const detail = button.querySelector("small")!;
        if (detail.textContent !== text) detail.textContent = text;
        button.disabled = team.money < cost;
        button.classList.toggle("selected", false);
        continue;
      }
      const locked = id === FOUND_BUTTON ? null : tierLock(this.session, id);
      button.disabled = id !== FOUND_BUTTON && (locked !== null || !affordable(this.session, id));
      button.classList.toggle("locked", locked !== null);
      const index = this.session.race.buildings.indexOf(id);
      if (index >= 0) {
        const detail = button.querySelector("small")!;
        const text = locked ? `${index + 1} · ${locked}` : `${index + 1} · ${buildCost(this.session.world, content, this.session.local, id)}`;
        if (detail.textContent !== text) detail.textContent = text;
      }
      button.classList.toggle("selected", id === selected);
    }
  }

  /** The Spot capacity button's detail line. */
  private spotText(state: ReturnType<typeof spotState>, cost: number): string {
    const { content } = this.session;
    const team = this.session.team;
    if (team.money < cost) return `N · need $${cost - team.money}`;
    const spot = content.economy.spot;
    if (state !== null) return `N · +${spot.compute[Math.min(tierOf(content, team), spot.compute.length - 1)]} more · $${cost}`;
    return `N · +${spot.compute[Math.min(tierOf(content, team), spot.compute.length - 1)]} for ${spot.ticks / TICK_RATE}s · $${cost}`;
  }

  /** The shop card's label: the registry building's name. */
  private shopName(): string {
    const { content } = this.session;
    return Object.values(content.buildings).find((b) => b.shop)?.name ?? "Shop";
  }

  /** Forget what's rendered so the next update re-renders (new match). */
  reset(): void {
    this.rendered = "";
  }

  private render(mode: BarMode): void {
    this.rendered = mode;
    // The buttons are about to go: a hovered one never sees its pointerleave, so
    // its card would stick on the info panel over whatever is selected next.
    this.events.hover(null);
    this.hero?.unhover();
    const { race, content } = this.session;
    const heroName = this.session.team.heroId ? content.units[this.session.team.heroId]!.name : "Hero";
    const center = race.center ? content.buildings[race.center]!.name : "Upgrade center";
    this.root.replaceChildren(label(mode === "research" ? "Core · race & base" : mode === "armory" ? `${center} · army` : mode === "hero" ? heroName : mode === "shop" ? this.shopName() : race.name));
    if (mode === "hero") {
      this.root.append(...(this.hero?.buttons() ?? []));
    } else if (mode === "shop") {
      shopStock(content).forEach((id, index) => {
        const def = content.items.items[id]!;
        const button = this.button(itemButton(id), def.name, `${index + 1} · $${def.cost}`);
        button.classList.add("item-btn");
        this.root.append(button);
      });
    } else if (mode === "deploy") {
      this.root.append(this.button(FOUND_BUTTON, "Deploy core", "C"));
    } else if (mode === "build") {
      race.buildings.forEach((id, index) => {
        const cost = buildCost(this.session.world, content, this.session.local, id);
        this.root.append(this.button(id, content.buildings[id]!.name, `${index + 1} · ${cost}`));
      });
    } else {
      for (const id of this.upgrades(mode)) {
        const button = this.button(upgradeButton(id), upgradeName(content, this.session.team.raceId, id), this.upgradeDetail(id));
        button.classList.add("upgrade-btn");
        this.root.append(button);
      }
      // The core card also trains the deploy agent that founds expansions.
      if (mode === "research") {
        this.root.append(this.button(AGENT_BUTTON, "Deploy agent", `B · ${content.buildings[race.core]!.cost}`));
        this.root.append(this.button(SPOT_BUTTON, "Spot capacity", this.spotText(spotState(this.session.world, this.session.team), spotCost(content, this.session.team))));
      }
    }
    const guide = document.createElement("button");
    guide.className = "guide-btn";
    guide.textContent = "Guide (G)";
    guide.addEventListener("click", () => this.events.guide());
    this.root.append(guide);
  }

  /** The upgrades the core (research) or upgrade center (armory) offers this race, in order. */
  upgrades(mode: BarMode): string[] {
    return upgradesAt(this.session.content, this.session.team, mode === "armory" ? "center" : "core");
  }

  /** The level a click would queue, its price, and what's waiting. */
  private upgradeDetail(upgrade: string): string {
    const { content, team } = this.session;
    const def = content.upgrades[upgrade]!;
    const level = levelOf(team, upgrade);
    const index = this.upgrades(def.at === "center" ? "armory" : "research").indexOf(upgrade) + 1;
    const head = team[slotOf(content, upgrade)];
    const next = nextQueued(content, team, upgrade);
    // In the queue but not running yet: one entry per upgrade, so that's all there is to say.
    const waiting = head?.upgrade !== upgrade && queuedCount(content, team, upgrade) > 0;
    if (waiting) return `${index} · queued`;
    if (def.stat === "tier") {
      const tiers = content.economy.tiers;
      if (head?.upgrade === upgrade) return `${index} · building ${tiers[level + 1]!.name}`;
      if (next.level > def.maxLevel) return `${index} · ${tiers[level]!.name}`;
      return `${index} · → ${tiers[next.level]!.name} · ${next.cost}`;
    }
    if (next.level > def.maxLevel) return `${index} · ${def.stat === "trait" ? "done" : "max"}`;
    if (head?.upgrade === upgrade) return `${index} · researching`;
    const needs = def.tiers?.[next.level - 1];
    if (needs !== undefined && projectedTier(content, team) < needs) {
      return `${index} · needs ${content.economy.tiers[needs]!.name}`;
    }
    if (def.stat === "trait") return `${index} · trait · ${next.cost}`;
    return `${index} · Lv ${next.level}/${def.maxLevel} · ${next.cost}`;
  }

  private button(id: string, text: string, detail: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "build-btn";
    button.dataset.building = id;
    const name = document.createTextNode(text);
    const small = document.createElement("small");
    small.textContent = detail;
    button.append(name, small);
    const upgrade = upgradeOf(id);
    const item = itemOf(id);
    button.addEventListener("click", () => (upgrade ? this.events.research(upgrade) : item ? this.events.buy(item) : this.events.choose(id)));
    button.addEventListener("pointerenter", () => this.events.hover(id));
    button.addEventListener("pointerleave", () => this.events.hover(null));
    return button;
  }
}

function label(text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "race-name";
  el.textContent = text;
  return el;
}
