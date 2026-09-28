// The bottom bar. In the deploy phase it offers "deploy core here"; once the
// core is online it shows the race's buildings.

import { affordable } from "../game/selection";
import type { Session } from "../game/session";
import { buildCost } from "../sim";
import { $ } from "./dom";

export const FOUND_BUTTON = "found";

export interface BuildBarEvents {
  choose(button: string): void;
  hover(button: string | null): void;
  guide(): void;
}

export class BuildBar {
  private readonly root = $("build-bar");
  private phase: "deploy" | "build" | null = null;

  constructor(
    private readonly session: Session,
    private readonly events: BuildBarEvents,
  ) {}

  /** Rebuild when the phase changes; refresh disabled/selected state every frame. */
  update(selected: string | null): void {
    const phase = this.session.deploying ? "deploy" : "build";
    if (phase !== this.phase) this.render(phase);
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(".build-btn")) {
      const id = button.dataset.building!;
      button.disabled = id !== FOUND_BUTTON && !affordable(this.session, id);
      button.classList.toggle("selected", id === selected);
    }
  }

  /** Forget the current phase so the next update re-renders (new match). */
  reset(): void {
    this.phase = null;
  }

  private render(phase: "deploy" | "build"): void {
    this.phase = phase;
    const { race, content } = this.session;
    this.root.replaceChildren(label(race.name));
    if (phase === "deploy") {
      this.root.append(this.button(FOUND_BUTTON, "Deploy core", "C"));
    } else {
      race.buildings.forEach((id, index) => {
        const cost = buildCost(content, this.session.team.raceId, id);
        this.root.append(this.button(id, content.buildings[id]!.name, `${index + 1} · ${cost}`));
      });
    }
    const guide = document.createElement("button");
    guide.className = "guide-btn";
    guide.textContent = "Guide (G)";
    guide.addEventListener("click", () => this.events.guide());
    this.root.append(guide);
  }

  private button(id: string, label: string, detail: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "build-btn";
    button.dataset.building = id;
    button.innerHTML = `${label}<small>${detail}</small>`;
    button.addEventListener("click", () => this.events.choose(id));
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
