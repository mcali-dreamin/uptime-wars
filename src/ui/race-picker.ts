// The race picker shown before each match.

import { PLAYER_COLORS } from "../game/colors";
import type { Session } from "../game/session";
import { $ } from "./dom";

export class RacePicker {
  private readonly root = $("race-picker");
  private readonly cards = $("race-cards");
  private readonly colors = $("color-swatches");
  open = false;

  constructor(
    private readonly session: Session,
    private readonly onPick: (raceId: string) => void,
    private readonly onCoop: () => void,
    private readonly onColor: () => void = () => {},
  ) {
    $("coop-host").addEventListener("click", () => this.coop());
  }

  show(): void {
    const { content, playable, raceId } = this.session;
    this.cards.replaceChildren(
      ...playable.map((id, index) => {
        const race = content.races[id]!;
        const card = document.createElement("button");
        card.className = `race-card${id === raceId ? " last" : ""}`;
        card.innerHTML = `<strong>${index + 1}. ${race.name}</strong><em>${race.specialty}</em>`;
        card.addEventListener("click", () => this.pick(id));
        return card;
      }),
    );
    this.showColors();
    this.root.hidden = false;
    this.open = true;
  }

  private showColors(): void {
    this.colors.replaceChildren(
      ...PLAYER_COLORS.map((color) => {
        const swatch = document.createElement("button");
        swatch.className = `color-swatch${color.id === this.session.color.id ? " chosen" : ""}`;
        swatch.dataset.color = color.id;
        swatch.title = color.name;
        swatch.setAttribute("aria-label", color.name);
        swatch.style.setProperty("--swatch", `#${color.hex.toString(16).padStart(6, "0")}`);
        swatch.addEventListener("click", () => {
          this.session.setColor(color.id);
          this.onColor();
          this.showColors();
        });
        return swatch;
      }),
    );
  }

  /** Number keys pick while the picker is open. Returns true when handled. */
  key(key: string): boolean {
    if (!this.open) return false;
    if (key === "h") return this.coop(), true;
    const id = this.session.playable[Number(key) - 1];
    if (id) this.pick(id);
    return true;
  }

  private coop(): void {
    this.root.hidden = true;
    this.open = false;
    this.onCoop();
  }

  private pick(id: string): void {
    this.root.hidden = true;
    this.open = false;
    this.onPick(id);
  }
}
