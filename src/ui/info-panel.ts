// A small card in the bottom-left. Only ever about something you chose:
// the build button you're hovering, what you're placing, or what you have
// selected. Nothing else pops up. The full story lives in the Guide.

import { invokeCost, upgradeName, earnedPerks, tierDef, TICK_RATE, forkCost, isCore, levelOf, queueOf, regionShield, buildingRank, nextRank, rankBlocker, rankCost, tierOf, unitRank } from "../sim";
import { armyHero, armyUnits, buildingGroup, groundOrderLabel, isRallied, removal, selectedEntity, type Selection } from "../game/selection";
import type { Session } from "../game/session";
import { heightAtTile, TILE, type Building, type Entity } from "../sim";
import { HIGH_GROUND_DAMAGE } from "../sim/tuning";
import { upgradeOf } from "./build-bar";
import { buildingCard, rankEffect, unitCard, upgradeCard, type InfoCard } from "./cards";
import { rankChange } from "./text";
import { $ } from "./dom";

export class InfoPanel {
  private readonly root = $("info");
  private readonly title = $("info-title");
  private readonly lines = $("info-lines");
  /** "Set rally (T)": the ground order without a right-click. */
  private readonly action = $("info-action");
  /** "Burst now (V)" for a serverless function. */
  private readonly invokeButton = $("info-invoke");
  /** "Fork · $N (X)" for races that can copy a building. */
  private readonly forkButton = $("info-fork");
  /** "Upgrade to <rank> · $N (U)" for a spawner. */
  private readonly rankButton = $("info-rank");
  /** "Decommission · +$N (Del)" / "Dismiss (Del)": take your own things away. */
  private readonly removeButton = $("info-remove");
  /** Set while a first Delete waits for the second one, so the button asks to confirm. */
  removeArmed: () => boolean = () => false;
  /** Build button under the pointer, or "found" for the deploy button. */
  hoverButton: string | null = null;
  /** Ability under the pointer in the hero's command card. */
  hoverAbility: string | null = null;
  /** Set once the hero bar exists, to describe abilities. */
  describeAbility: ((id: string) => InfoCard) | null = null;
  /** Research queue entries of the selected building, shown under the card's lines; clicking one cancels it. */
  private queueEntries: { label: string; slot: "research" | "labResearch"; index: number }[] = [];

  constructor(
    private readonly session: Session,
    arm: () => void,
    invoke: () => void = () => {},
    fork: () => void = () => {},
    rank: () => void = () => {},
    remove: () => void = () => {},
  ) {
    this.removeButton.addEventListener("click", () => remove());
    this.rankButton.addEventListener("click", () => rank());
    this.forkButton.addEventListener("click", () => fork());
    this.action.addEventListener("click", () => arm());
    this.invokeButton.addEventListener("click", () => invoke());
  }

  refresh(selection: Selection): void {
    this.action.hidden = true;
    this.invokeButton.hidden = true;
    this.forkButton.hidden = true;
    this.rankButton.hidden = true;
    this.removeButton.hidden = true;
    this.queueEntries = [];
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

    this.showRemoval(selection);
    if (selection.kind === "army") return this.showArmy(selection);
    if (selection.kind === "buildings") return this.showBuildings(selection);
    const entity = selectedEntity(this.session, selection);
    if (!entity) return this.show(null);
    if (entity.kind === "building") {
      const card = buildingCard(content, raceId, entity.defId);
      const hp = `${Math.ceil(entity.hp)} / ${entity.maxHp} HP`;
      const lines = [card.lines[0]!, entity.buildRemaining > 0 ? `building · ${hp}` : hp];
      if (isCore(content, this.session.team, entity)) {
        const perks = earnedPerks(content, this.session.team).map((p) => p.name);
        lines.push(`Tier: ${tierDef(content, this.session.team).name}${perks.length ? ` · ${perks.join(", ")}` : ""}`);
      }
      const doing = isCore(content, this.session.team, entity) ? "research" as const : entity.defId === content.races[raceId]!.center && entity.team === this.session.local ? "labResearch" as const : null;
      if (doing && entity.team === this.session.local) this.showQueue(doing);
      if (entity.jammedUntil !== undefined && this.session.world.tick < entity.jammedUntil) lines.push("Jammed by a DDoS · can't shoot, spawn or run");
      const fn = content.buildings[entity.defId]!.invoke;
      if (fn && entity.buildRemaining <= 0) {
        lines.push((entity.scaleTimer ?? 0) > 0 ? `Burst cooling down · ${Math.ceil(entity.scaleTimer! / TICK_RATE)}s` : "Burst ready · fires when creeps nearby outnumber its units");
        this.invokeButton.hidden = false;
        this.invokeButton.textContent = `Burst now · $${invokeCost(content, this.session.team, fn.cost)} (V)`;
        (this.invokeButton as HTMLButtonElement).disabled = (entity.scaleTimer ?? 0) > 0 || this.session.team.money < invokeCost(content, this.session.team, fn.cost);
      }
      this.showRank(entity, lines);
      if (content.buildings[entity.defId]!.attack) this.showHeight(entity, lines);
      const shield = regionShield(this.session.world, content, entity);
      if (content.races[raceId]!.mechanics?.region && entity.buildRemaining <= 0) {
        lines.push(shield.neighbors > 0 ? `Region: ${shield.permille / 10}% less damage (${shield.neighbors} nearby)` : "Region: alone, no shield. Build nearby to protect it");
      }
      const repair = content.races[raceId]!.mechanics?.repair;
      if (repair && entity.buildRemaining <= 0 && entity.hp < entity.maxHp) {
        const quiet = this.session.world.tick - entity.lastHitTick >= repair.quietTicks;
        lines.push(quiet ? "Repairing itself" : "Repairs once nothing's hitting it");
      }
      const price = forkCost(this.session.world, content, this.session.local, entity);
      if (price !== null) {
        this.forkButton.hidden = false;
        this.forkButton.textContent = `Fork · $${price} (X)`;
        (this.forkButton as HTMLButtonElement).disabled = this.session.team.money < price;
      }
      this.showAction(selection);
      return this.show({ title: card.title, lines });
    }
    const card = unitCard(content, entity.defId, entity.hp, entity.maxHp, unitRank(content, this.session.world, entity)?.name ?? null);
    if (entity.team === this.session.local) this.showHeight(entity, card.lines);
    this.show(card);
  }

  /** The high-ground bonus, where it applies: the sim gives it, so the card says it. */
  private showHeight(entity: Entity, lines: string[]): void {
    const terrain = this.session.world.terrain;
    const level = heightAtTile(terrain, Math.floor(entity.x / TILE), Math.floor(entity.y / TILE));
    if (level <= 0) return;
    const bonus = Math.round((HIGH_GROUND_DAMAGE - 1) * 100);
    lines.push(`High ground: +${bonus}% damage to anything below it`);
  }

  /** A spawner's rank, its rank-up in progress, and the button for the next one. */
  private showRank(entity: Building, lines: string[]): void {
    if (entity.team !== this.session.local || entity.buildRemaining > 0) return;
    const { content, world } = this.session;
    const rank = buildingRank(content, world, entity);
    if (rank) lines.push(`Rank ${entity.rank} · ${rank.name}: ${rankEffect(rank)}`);
    if ((entity.refitRemaining ?? 0) > 0) {
      lines.push(`Upgrading · ${Math.ceil(entity.refitRemaining! / TICK_RATE)}s · not spawning`);
      return;
    }
    const next = nextRank(content, world, entity);
    const price = rankCost(content, world, entity);
    if (!next || price === null) return;
    const blocker = rankBlocker(content, world, this.session.local, entity);
    lines.push(`Next · ${next.name}: ${rankChange(content, this.session.team.raceId, entity.defId, rank, next)}`);
    this.rankButton.hidden = false;
    this.rankButton.textContent = blocker && blocker.startsWith("needs") ? `${next.name} ${blocker}` : `Upgrade to ${next.name} · $${price} (U)`;
    (this.rankButton as HTMLButtonElement).disabled = blocker !== null;
  }

  /** Buildings with a ground order get a button for it; the deploy agent's is a plain click already. */
  private showAction(selection: Selection): void {
    const label = groundOrderLabel(this.session, selection);
    if (!label) return;
    const armed = (selection.kind === "entity" || selection.kind === "army" || selection.kind === "buildings") && Boolean(selection.armed);
    this.action.hidden = false;
    this.action.textContent = armed ? "Click the ground… (Esc)" : `${label} (T)`;
    this.action.classList.toggle("armed", armed);
  }

  /** Delete's button: what it would take away; once pressed, a second press confirms. */
  private showRemoval(selection: Selection): void {
    const plan = removal(this.session, selection);
    if (!plan) return;
    const armed = this.removeArmed();
    this.removeButton.hidden = false;
    this.removeButton.textContent = armed ? `${plan.label} · confirm (Del)` : `${plan.label} (Del)`;
    this.removeButton.classList.toggle("armed", armed);
  }

  /** A group of your units: what's in it (the hero counts, but Delete never takes it), and how to send it. */
  private showArmy(selection: Selection): void {
    const units = armyUnits(this.session, selection);
    const hero = armyHero(this.session, selection);
    if (units.length === 0 && !hero) return this.show(null);
    const { content } = this.session;
    // An army down to its hero (the soldiers fell): its own card.
    if (units.length === 0) {
      const card = unitCard(content, hero!.defId, hero!.hp, hero!.maxHp);
      this.showAction(selection);
      return this.show({ title: card.title, lines: [...card.lines, "Right-click: move"] });
    }
    if (units.length === 1 && !hero) {
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
      title: hero ? `Hero + ${units.length} unit${units.length === 1 ? "" : "s"}` : `${units.length} units`,
      lines: [mix, `${Math.round((100 * hp) / maxHp)}% health`, "Right-click: attack-move · F: move"],
    });
  }

  /** Several of your buildings: what's in the group, one rally for the rallied ones, and how to grow or shrink it. */
  private showBuildings(selection: Selection): void {
    const buildings = buildingGroup(this.session, selection);
    if (buildings.length === 0) return this.show(null);
    const { content } = this.session;
    const counts = new Map<string, number>();
    for (const b of buildings) counts.set(b.defId, (counts.get(b.defId) ?? 0) + 1);
    const mix = [...counts].map(([id, n]) => `${n}× ${content.buildings[id]!.name}`).join(" · ");
    const one = counts.size === 1 ? content.buildings[buildings[0]!.defId]!.name : null;
    const lines = [one ?? mix];
    if (buildings.some((b) => isRallied(this.session, b))) lines.push("Right-click: one rally point for all of them");
    lines.push("Shift-click: add or remove one", "Delete: decommission all of them");
    this.showAction(selection);
    this.show({
      title: one ? `${buildings.length}× ${one}` : `${buildings.length} buildings`,
      lines,
    });
  }

  /** The research queue of the selected core or upgrade center: the entry running (with its progress), then the waiting ones. */
  private showQueue(slot: "research" | "labResearch"): void {
    const { content, team } = this.session;
    const raceId = team.raceId;
    const levels = new Map<string, number>();
    for (const [index, entry] of queueOf(team, slot).entries()) {
      // The level this entry will land at: the team's level plus everything queued ahead of it.
      const level = (levels.get(entry.upgrade) ?? levelOf(team, entry.upgrade)) + 1;
      levels.set(entry.upgrade, level);
      const name = upgradeName(content, raceId, entry.upgrade);
      const head = index === 0 ? team[slot] : null;
      if (head && head.upgrade === entry.upgrade) {
        const needs = content.upgrades[entry.upgrade]!.tiers?.[levelOf(team, entry.upgrade)];
        const gate = needs !== undefined && tierOf(content, team) < needs ? `waiting for ${content.economy.tiers[needs]!.name} · ` : "";
        this.queueEntries.push({
          label: `${gate}Researching ${name} ${level} · ${Math.ceil(head.remaining / TICK_RATE)}s · click to cancel`,
          slot,
          index,
        });
      } else {
        this.queueEntries.push({ label: `Queued ${name} ${level} · $${entry.paid} · click to cancel`, slot, index });
      }
    }
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
      ...this.queueEntries.map((entry) => {
        const li = document.createElement("li");
        li.textContent = entry.label;
        li.className = "cancel";
        li.addEventListener("click", () => this.session.issue({ type: "cancelResearch", slot: entry.slot, index: entry.index }));
        return li;
      }),
    );
  }
}
