// A small card in the bottom-left. Only ever about something you chose:
// the build button you're hovering, what you're placing, or what you have
// selected. Nothing else pops up. The full story lives in the Guide.

import { TICK_RATE, isCore } from "../sim";
import { armyUnits, groundOrderLabel, selectedEntity, type Selection } from "../game/selection";
import type { Session } from "../game/session";
import { upgradeOf } from "./build-bar";
import { buildingCard, unitCard, upgradeCard, type InfoCard } from "./cards";
import { $ } from "./dom";

export class InfoPanel {
  private readonly root = $("info");
  private readonly title = $("info-title");
  private readonly lines = $("info-lines");
  /** "Set rally (T)": the ground order without a right-click. */
  private readonly action = $("info-action");
  /** "Invoke (V)" for a serverless function. */
  private readonly invokeButton = $("info-invoke");
  /** Build button under the pointer, or "found" for the deploy button. */
  hoverButton: string | null = null;
  /** Ability under the pointer in the hero's command card. */
  hoverAbility: string | null = null;
  /** Set once the hero bar exists, to describe abilities. */
  describeAbility: ((id: string) => InfoCard) | null = null;

  constructor(
    private readonly session: Session,
    arm: () => void,
    invoke: () => void = () => {},
  ) {
    this.action.addEventListener("click", () => arm());
    this.invokeButton.addEventListener("click", () => invoke());
  }

  refresh(selection: Selection): void {
    this.action.hidden = true;
    this.invokeButton.hidden = true;
    const { content } = this.session;
    const raceId = this.session.team.raceId;
    const placing = selection.kind === "place" ? selection.building : selection.kind === "found" ? "found" : null;
    const building = this.hoverButton ?? placing;
    if (building === "found") return this.show({ title: "Deploy core", lines: ["Your agent walks there and becomes it"] });
    const aiming = selection.kind === "cast" ? selection.ability : null;
    const ability = this.hoverAbility ?? aiming;
    if (ability && this.describeAbility) return this.show(this.describeAbility(ability));
    const upgrade = upgradeOf(this.hoverButton);
    if (upgrade) return this.show(upgradeCard(content, this.session.team, upgrade));
    if (building) return this.show(buildingCard(content, raceId, building));

    if (selection.kind === "army") return this.showArmy(selection);
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
      const fn = content.buildings[entity.defId]!.invoke;
      if (fn && entity.buildRemaining <= 0) {
        lines.push(entity.spawnTimer > 0 ? `Cooling down · ${Math.ceil(entity.spawnTimer / TICK_RATE)}s` : "Ready · runs when a creep comes near");
        this.invokeButton.hidden = false;
        this.invokeButton.textContent = `Invoke now · ${fn.cost} (V)`;
        (this.invokeButton as HTMLButtonElement).disabled = entity.spawnTimer > 0 || this.session.team.compute < fn.cost;
      }
      this.showAction(selection);
      return this.show({ title: card.title, lines });
    }
    this.show(unitCard(content, entity.defId, entity.hp, entity.maxHp));
  }

  /** Buildings with a ground order get a button for it; the deploy agent's is a plain click already. */
  private showAction(selection: Selection): void {
    const label = groundOrderLabel(this.session, selection);
    if (!label) return;
    const armed = (selection.kind === "entity" || selection.kind === "army") && Boolean(selection.armed);
    this.action.hidden = false;
    this.action.textContent = armed ? "Click the ground… (Esc)" : `${label} (T)`;
    this.action.classList.toggle("armed", armed);
  }

  /** A group of your units: what's in it, and how to send it. */
  private showArmy(selection: Selection): void {
    const units = armyUnits(this.session, selection);
    if (units.length === 0) return this.show(null);
    const { content } = this.session;
    if (units.length === 1) {
      const unit = units[0]!;
      const card = unitCard(content, unit.defId, unit.hp, unit.maxHp);
      this.showAction(selection);
      return this.show({ title: card.title, lines: [...card.lines, "Right-click: attack-move · F: move"] });
    }
    const counts = new Map<string, number>();
    let hp = 0;
    let maxHp = 0;
    for (const unit of units) {
      counts.set(unit.defId, (counts.get(unit.defId) ?? 0) + 1);
      hp += unit.hp;
      maxHp += unit.maxHp;
    }
    const mix = [...counts].map(([id, n]) => `${n}× ${content.units[id]!.name}`).join(" · ");
    this.showAction(selection);
    this.show({
      title: `${units.length} units`,
      lines: [mix, `${Math.round((100 * hp) / maxHp)}% health`, "Right-click: attack-move · F: move"],
    });
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
