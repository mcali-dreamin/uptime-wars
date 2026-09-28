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
    this.root.replaceChildren(stat(race.name, race.specialty));
    if (phase === "deploy") {
      this.root.append(this.button(FOUND_BUTTON, "C. Deploy core here", "free · your agent walks there"));
      this.root.append(stat("Deploy", "Click your agent, then click the ground to walk · C: choose where your core goes · Space: find your agent", "help"));
      return;
    }
    race.buildings.forEach((id, index) => {
      const cost = buildCost(content, this.session.team.raceId, id);
      this.root.append(this.button(id, `${index + 1}. ${content.buildings[id]!.name}`, `${cost} compute`));
    });
    this.root.append(
      stat("Controls", "Click to select · right-click: rally (core = global) · WASD / drag / edge: pan · wheel or +/-: zoom · Space: home · P: pause", "help"),
    );
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

function stat(label: string, value: string, extra = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = `stat ${extra}`.trim();
  const l = document.createElement("span");
  l.className = "label";
  l.textContent = label;
  const v = document.createElement("span");
  v.textContent = value;
  el.append(l, v);
  return el;
}
