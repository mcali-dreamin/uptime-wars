// The picker shown before each match: race, then (for races with heroes)
// which hero you'll lead.

import { PLAYER_COLORS } from "../game/colors";
import type { Session } from "../game/session";
import type { Telemetry } from "../game/telemetry";
import { $ } from "./dom";
import { abilityEffect, raceLines } from "./text";

export class RacePicker {
  private readonly root = $("race-picker");
  private readonly cards = $("race-cards");
  private readonly colors = $("color-swatches");
  private readonly title = $("picker-title");
  /** Set while choosing a hero for this race. */
  private race: string | null = null;
  open = false;

  constructor(
    private readonly session: Session,
    private readonly onPick: (raceId: string, heroId?: string) => void,
    /** Open the lobby; `computer` starts it with a computer opponent. */
    private readonly onCoop: (computer: boolean) => void,
    private readonly onColor: () => void = () => {},
    telemetry?: Telemetry,
  ) {
    $("coop-host").addEventListener("click", () => this.coop());
    $("vs-computer").addEventListener("click", () => this.coop(true));
    const share = $("share-stats") as HTMLInputElement;
    if (telemetry) {
      share.checked = telemetry.enabled;
      share.addEventListener("change", () => (telemetry.enabled = share.checked));
    } else $("stats-row").hidden = true;
  }

  show(): void {
    this.race = null;
    this.title.textContent = "Choose who you're keeping online.";
    const { content, playable, raceId } = this.session;
    this.cards.replaceChildren(
      ...playable.map((id, index) => {
        const race = content.races[id]!;
        const card = document.createElement("button");
        card.className = `race-card${id === raceId ? " last" : ""}`;
        const rules = raceLines(content, id).map((line) => `<li>${line}</li>`);
        card.innerHTML = `<strong>${index + 1}. ${race.name}</strong><em>${race.specialty}</em><ul>${rules.join("")}</ul>`;
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

  /** Step two: the race's heroes. */
  private showHeroes(raceId: string): void {
    const { content } = this.session;
    const race = content.races[raceId]!;
    this.race = raceId;
    this.title.textContent = `${race.name}: choose your hero. Esc to go back.`;
    const last = this.session.heroFor(raceId);
    this.cards.replaceChildren(
      ...race.heroes!.map((heroId, index) => {
        const unit = content.units[heroId]!;
        const abilities = content.heroes.heroes[heroId]!.abilities.map((id, i) => {
          const a = content.heroes.abilities[id]!;
          return `<li>${i === 3 ? "<b>Ultimate</b> " : ""}${a.name}: ${a.description} <span>${abilityEffect(content, a, 1)}.</span></li>`;
        });
        const card = document.createElement("button");
        card.className = `race-card hero-card${heroId === last ? " last" : ""}`;
        card.dataset.hero = heroId;
        card.innerHTML = `<strong>${index + 1}. ${unit.name}</strong><em>${unit.description}</em><ul>${abilities.join("")}</ul>`;
        card.addEventListener("click", () => this.pickHero(heroId));
        return card;
      }),
    );
  }

  /** Number keys pick while the picker is open. Returns true when handled. */
  key(key: string): boolean {
    if (!this.open) return false;
    if (this.race) {
      if (key === "escape") return this.show(), true;
      const hero = this.session.content.races[this.race]!.heroes![Number(key) - 1];
      if (hero) this.pickHero(hero);
      return true;
    }
    if (key === "h") return this.coop(), true;
    if (key === "c") return this.coop(true), true;
    const id = this.session.playable[Number(key) - 1];
    if (id) this.pick(id);
    return true;
  }

  private coop(computer = false): void {
    this.root.hidden = true;
    this.open = false;
    this.onCoop(computer);
  }

  private pick(id: string): void {
    // One hero per race: no choice to make, so no step. (More than one brings the step back.)
    if ((this.session.content.races[id]!.heroes?.length ?? 0) > 1) return this.showHeroes(id);
    this.root.hidden = true;
    this.open = false;
    this.onPick(id);
  }

  private pickHero(heroId: string): void {
    const race = this.race!;
    this.root.hidden = true;
    this.open = false;
    this.race = null;
    this.onPick(race, heroId);
  }
}
