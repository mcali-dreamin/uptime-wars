// The home screen: pick a race (and a hero, for races with more than one),
// then how to play. Every way to play uses the race picked here: solo
// against the botnet, Quick Match with strangers, or a custom match with
// friends and computers.

import { PLAYER_COLORS } from "../game/colors";
import type { Session } from "../game/session";
import type { Telemetry } from "../game/telemetry";
import { $ } from "./dom";
import { abilityEffect, raceLines } from "./text";

/** How the lobby opens from the home screen: Quick Match with strangers, or a custom match. */
export type LobbyStart = "quick" | "custom";

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
    /** Open the lobby: Quick Match with strangers, or a custom match with friends and computers. */
    private readonly onLobby: (how: LobbyStart) => void,
    private readonly onColor: () => void = () => {},
    telemetry?: Telemetry,
    private readonly onGuide: () => void = () => {},
  ) {
    $("play-solo").addEventListener("click", () => this.solo());
    $("quick-match").addEventListener("click", () => this.lobby("quick"));
    $("custom-match").addEventListener("click", () => this.lobby("custom"));
    $("picker-guide").addEventListener("click", () => this.onGuide());
    const share = $("share-stats") as HTMLInputElement;
    if (telemetry) {
      share.checked = telemetry.enabled;
      share.addEventListener("change", () => (telemetry.enabled = share.checked));
    } else $("stats-row").hidden = true;
  }

  show(): void {
    this.race = null;
    this.title.textContent = "Choose who you're keeping online, then how to play.";
    $("picker-actions").hidden = false;
    const { content, playable, raceId } = this.session;
    this.cards.replaceChildren(
      ...playable.map((id, index) => {
        const race = content.races[id]!;
        const card = document.createElement("button");
        card.className = `race-card${id === raceId ? " chosen" : ""}`;
        card.dataset.race = id;
        card.setAttribute("aria-pressed", String(id === raceId));
        const rules = raceLines(content, id).map((line) => `<li>${line}</li>`);
        card.innerHTML = `<strong>${index + 1}. ${race.name}</strong><em>${race.specialty}</em><ul>${rules.join("")}</ul>`;
        card.addEventListener("click", () => this.pick(id));
        // A double-click is "this one, solo, now".
        card.addEventListener("dblclick", () => this.solo());
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
    $("picker-actions").hidden = true;
    const last = this.session.heroFor(raceId);
    this.cards.replaceChildren(
      ...race.heroes!.map((heroId, index) => {
        const unit = content.units[heroId]!;
        const abilities = content.heroes.heroes[heroId]!.abilities.map((id, i) => {
          const a = content.heroes.abilities[id]!;
          return `<li>${i === 3 ? "<b>Ultimate</b> " : ""}${a.name}: ${a.description} <span>${abilityEffect(content, a, 1)}.</span></li>`;
        });
        const card = document.createElement("button");
        card.className = `race-card hero-card${heroId === last ? " chosen" : ""}`;
        card.dataset.hero = heroId;
        card.innerHTML = `<strong>${index + 1}. ${unit.name}</strong><em>${unit.description}</em><ul>${abilities.join("")}</ul>`;
        card.addEventListener("click", () => this.pickHero(heroId));
        return card;
      }),
    );
  }

  /** Keys while the home screen is open. Returns true when handled. */
  key(key: string, event?: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (this.race) {
      if (key === "escape") return this.show(), true;
      const hero = this.session.content.races[this.race]!.heroes![Number(key) - 1];
      if (hero) this.pickHero(hero);
      return true;
    }
    if (key === "enter") {
      // Enter on a focused mode button is that button's own click.
      if (document.activeElement instanceof HTMLElement && document.activeElement.closest("#picker-actions, #picker-footer")) return true;
      // Not the focused race card's click as well: that would reopen this screen.
      event?.preventDefault();
      return this.solo(), true;
    }
    if (key === "q") return this.lobby("quick"), true;
    // H was "play with friends": the same lobby.
    if (key === "c" || key === "h") return this.lobby("custom"), true;
    if (key === "g") return this.onGuide(), true;
    const id = this.session.playable[Number(key) - 1];
    if (id) this.pick(id);
    return true;
  }

  /** Select a race. One with several heroes asks which one first. */
  private pick(id: string): void {
    this.session.pick(id);
    if ((this.session.content.races[id]!.heroes?.length ?? 0) > 1) return this.showHeroes(id);
    this.show();
  }

  private pickHero(heroId: string): void {
    this.session.pickHero(heroId);
    this.show();
  }

  /** You against the botnet, as the race picked here. */
  private solo(): void {
    this.close();
    const race = this.session.raceId;
    this.onPick(race, this.session.heroFor(race));
  }

  private lobby(how: LobbyStart): void {
    this.close();
    this.onLobby(how);
  }

  private close(): void {
    this.root.hidden = true;
    this.open = false;
    this.race = null;
  }
}
