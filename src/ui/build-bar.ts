// The bottom bar, a command card in the WC3 sense: what it shows depends on
// the phase and on what you have selected.
//
// - deploy:   "Deploy core"
// - build:    the race's buildings
// - research: the core is selected, so its upgrades (the race and its base)
// - armory:   the upgrade center is selected, so its army upgrades and traits
// - hero:     the hero is selected, so its abilities (see hero-bar.ts)

import { affordable, tierLock } from "../game/selection";
import type { Session } from "../game/session";
import { buildCost, canResearch, levelOf, nextLevel, nextQueued, projectedTier, queuedCount, slotOf, upgradeName, upgradesAt } from "../sim";
import { $ } from "./dom";
import type { HeroBar } from "./hero-bar";

export const FOUND_BUTTON = "found";
const UPGRADE_PREFIX = "upgrade:";

export type BarMode = "deploy" | "build" | "research" | "armory" | "hero";

export interface BuildBarEvents {
  choose(button: string): void;
  research(upgrade: string): void;
  hover(button: string | null): void;
  guide(): void;
}

export const upgradeButton = (id: string) => UPGRADE_PREFIX + id;
const AIM_PREFIX = "aim:";
/** The "selected" button while aiming an ability. */
export const aimingButton = (ability: string) => AIM_PREFIX + ability;
const aimingOf = (button: string | null) => (button?.startsWith(AIM_PREFIX) ? button.slice(AIM_PREFIX.length) : null);
export const upgradeOf = (button: string | null) =>
  button?.startsWith(UPGRADE_PREFIX) ? button.slice(UPGRADE_PREFIX.length) : null;

export class BuildBar {
  private readonly root = $("build-bar");
  private mode: BarMode | null = null;

  /** Set once the hero bar exists (it renders the hero mode's buttons). */
  hero: HeroBar | null = null;

  constructor(
    private readonly session: Session,
    private readonly events: BuildBarEvents,
  ) {}

  /** Rebuild when the mode changes; refresh state every frame. */
  update(mode: BarMode, selected: string | null): void {
    if (mode !== this.mode) this.render(mode);
    if (mode === "hero") return this.hero?.refresh(this.root, aimingOf(selected));
    const { content, team } = this.session;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(".build-btn")) {
      const id = button.dataset.building!;
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

  /** Forget the current mode so the next update re-renders (new match). */
  reset(): void {
    this.mode = null;
  }

  private render(mode: BarMode): void {
    this.mode = mode;
    const { race, content } = this.session;
    const heroName = this.session.team.heroId ? content.units[this.session.team.heroId]!.name : "Hero";
    const center = race.center ? content.buildings[race.center]!.name : "Upgrade center";
    this.root.replaceChildren(label(mode === "research" ? "Core · race & base" : mode === "armory" ? `${center} · army` : mode === "hero" ? heroName : race.name));
    if (mode === "hero") {
      this.root.append(...(this.hero?.buttons() ?? []));
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
    const waiting = queuedCount(content, team, upgrade) - (head?.upgrade === upgrade ? 1 : 0);
    const suffix = waiting > 0 ? ` · ${waiting} queued` : "";
    if (def.stat === "tier") {
      const tiers = content.economy.tiers;
      if (head?.upgrade === upgrade) return `${index} · building ${tiers[level + 1]!.name}${suffix}`;
      if (next.level > def.maxLevel) return `${index} · ${tiers[level]!.name}`;
      return `${index} · → ${tiers[next.level]!.name} · ${next.cost}${suffix}`;
    }
    if (next.level > def.maxLevel) return `${index} · ${def.stat === "trait" ? "done" : "max"}`;
    if (head?.upgrade === upgrade) return `${index} · researching${suffix}`;
    const needs = def.tiers?.[next.level - 1];
    if (needs !== undefined && projectedTier(content, team) < needs) {
      return `${index} · needs ${content.economy.tiers[needs]!.name}`;
    }
    if (def.stat === "trait") return `${index} · trait · ${next.cost}${suffix}`;
    return `${index} · Lv ${next.level}/${def.maxLevel} · ${next.cost}${suffix}`;
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
    button.addEventListener("click", () => (upgrade ? this.events.research(upgrade) : this.events.choose(id)));
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
