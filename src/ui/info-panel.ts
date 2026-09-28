// The info card in the top-left. Shows, in priority order: the build button
// you're hovering, the building you're placing, what's under the pointer,
// then what you have selected.

import { TICK_RATE, TILE, tileAt, type Point } from "../sim";
import { groundOrderLabel, selectedEntity, type Selection } from "../game/selection";
import { HUMAN, type Session } from "../game/session";
import { buildingCard, terrainCard, unitCard, type InfoCard } from "./cards";
import { $ } from "./dom";

export interface Visibility {
  isVisible(x: number, y: number): boolean;
  isExplored(x: number, y: number): boolean;
}

export class InfoPanel {
  private readonly root = $("info");
  private readonly title = $("info-title");
  private readonly subtitle = $("info-subtitle");
  private readonly lines = $("info-lines");
  /** Build button under the pointer, or "found" for the deploy button. */
  hoverButton: string | null = null;
  /** Card for whatever is under the pointer on the map. */
  hoverCard: InfoCard | null = null;

  constructor(private readonly session: Session) {}

  refresh(selection: Selection): void {
    const { content } = this.session;
    const raceId = this.session.team.raceId;
    const placing = selection.kind === "place" ? selection.building : selection.kind === "found" ? "found" : null;
    const building = this.hoverButton ?? placing;
    if (building === "found") {
      const card = buildingCard(content, raceId, this.session.race.core);
      return this.show({
        ...card,
        subtitle: "Choose where your core goes. Your deploy agent walks there and becomes it. Waves start soon after.",
      });
    }
    if (building) return this.show(buildingCard(content, raceId, building));
    this.show(this.hoverCard ?? this.selectedCard(selection));
  }

  /** Work out what's under the pointer, respecting fog. */
  hoverAt(point: Point | null, selection: Selection, fog: Visibility): void {
    this.hoverCard = point ? this.cardAt(point, selection, fog) : null;
  }

  private cardAt(point: Point, selection: Selection, fog: Visibility): InfoCard | null {
    const { world, content } = this.session;
    if (!fog.isExplored(point.x, point.y)) {
      return { title: "Unexplored", subtitle: "Nobody has been out here yet.", lines: ["Send your deploy agent, or build closer, to see what's out there."] };
    }
    for (const entity of world.entities) {
      const mine = entity.team === HUMAN;
      if (!mine && entity.kind === "unit" && !fog.isVisible(entity.x, entity.y)) continue;
      if (entity.kind === "building") {
        const half = (entity.footprint * TILE) / 2;
        if (Math.abs(point.x - entity.x) > half || Math.abs(point.y - entity.y) > half) continue;
        if (selection.kind === "entity" && selection.id === entity.id) return this.selectedCard(selection);
        const card = buildingCard(content, world.teams[entity.team].raceId, entity.defId);
        const status = entity.buildRemaining > 0 ? `building, ${Math.ceil(entity.buildRemaining / TICK_RATE)}s left` : "online";
        const hint = mine ? " Click to select." : "";
        return { ...card, subtitle: `${mine ? "Yours" : "Hostile"} · ${status} · ${Math.ceil(entity.hp)} / ${entity.maxHp} HP.${hint} ${card.subtitle}` };
      }
      const dx = point.x - entity.x;
      const dy = point.y - entity.y;
      if (dx * dx + dy * dy > (entity.radius + 4) ** 2) continue;
      if (selection.kind === "entity" && selection.id === entity.id) return this.selectedCard(selection);
      const card = unitCard(content, entity.defId, entity.hp);
      const owner = entity.mode === "builder" ? "Yours, deploy agent. Click to select." : entity.mode === "guard" ? "Yours, guarding" : "Creep, wandering";
      return { ...card, subtitle: `${owner} ${card.subtitle}` };
    }
    return terrainCard(tileAt(world.terrain, Math.floor(point.x / TILE), Math.floor(point.y / TILE)));
  }

  private selectedCard(selection: Selection): InfoCard | null {
    const entity = selectedEntity(this.session, selection);
    if (!entity) return null;
    const { content } = this.session;
    const card =
      entity.kind === "building"
        ? buildingCard(content, this.session.team.raceId, entity.defId)
        : unitCard(content, entity.defId, entity.hp);
    const order = groundOrderLabel(this.session, selection);
    const how = entity.kind === "unit" && entity.mode === "builder" ? "click or right-click the ground" : "right-click the ground";
    const hint = order ? `Selected · ${how}: ${order.toLowerCase()}` : "Selected";
    return { ...card, lines: [...card.lines, hint] };
  }

  private show(card: InfoCard | null): void {
    if (!card) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    this.title.textContent = card.title;
    this.subtitle.textContent = card.subtitle;
    this.lines.replaceChildren(
      ...card.lines.map((line) => {
        const li = document.createElement("li");
        li.textContent = line;
        return li;
      }),
    );
  }
}
