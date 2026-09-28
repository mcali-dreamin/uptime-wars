// A small card in the bottom-left. Only ever about something you chose:
// the build button you're hovering, what you're placing, or what you have
// selected. Nothing else pops up. The full story lives in the Guide.

import { TICK_RATE, isCore } from "../sim";
import { selectedEntity, type Selection } from "../game/selection";
import type { Session } from "../game/session";
import { upgradeOf } from "./build-bar";
import { buildingCard, unitCard, upgradeCard, type InfoCard } from "./cards";
import { $ } from "./dom";

export class InfoPanel {
  private readonly root = $("info");
  private readonly title = $("info-title");
  private readonly lines = $("info-lines");
  /** Build button under the pointer, or "found" for the deploy button. */
  hoverButton: string | null = null;

  constructor(private readonly session: Session) {}

  refresh(selection: Selection): void {
    const { content } = this.session;
    const raceId = this.session.team.raceId;
    const placing = selection.kind === "place" ? selection.building : selection.kind === "found" ? "found" : null;
    const building = this.hoverButton ?? placing;
    if (building === "found") return this.show({ title: "Deploy core", lines: ["Your agent walks there and becomes it"] });
    const upgrade = upgradeOf(this.hoverButton);
    if (upgrade) return this.show(upgradeCard(content, this.session.team, upgrade));
    if (building) return this.show(buildingCard(content, raceId, building));

    const entity = selectedEntity(this.session, selection);
    if (!entity) return this.show(null);
    if (entity.kind === "building") {
      const card = buildingCard(content, raceId, entity.defId);
      const hp = `${Math.ceil(entity.hp)} / ${entity.maxHp} HP`;
      const lines = [card.lines[0]!, entity.buildRemaining > 0 ? `building · ${hp}` : hp];
      const research = this.session.team.research;
      if (isCore(content, this.session.team, entity) && research) {
        lines.push(`Researching ${content.upgrades[research.upgrade]!.name} · ${Math.ceil(research.remaining / TICK_RATE)}s`);
      }
      return this.show({ title: card.title, lines });
    }
    this.show(unitCard(content, entity.defId, entity.hp, entity.maxHp));
  }

  private show(card: InfoCard | null): void {
    if (!card) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    this.title.textContent = card.title;
    this.lines.replaceChildren(
      ...card.lines.map((line) => {
        const li = document.createElement("li");
        li.textContent = line;
        return li;
      }),
    );
  }
}
