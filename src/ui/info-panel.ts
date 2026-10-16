// A small card in the bottom-left. Only ever about something you chose:
// the build button you're hovering, what you're placing, or what you have
// selected. Nothing else pops up. The full story lives in the Guide.

import { invokeCost, upgradeName, earnedPerks, tierDef, TICK_RATE, forkCost, isCore, regionShield, buildingRank, nextRank, rankBlocker, rankCost, unitRank } from "../sim";
import { armyUnits, groundOrderLabel, selectedEntity, spawnerGroup, type Selection } from "../game/selection";
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
    fork: () => void = () => {},
    rank: () => void = () => {},
  ) {
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
    if (selection.kind === "spawners") return this.showSpawners(selection);
    const entity = selectedEntity(this.session, selection);
    if (!entity) return this.show(null);
    if (entity.kind === "building") {
      const card = buildingCard(content, raceId, entity.defId);
      const hp = `${Math.ceil(entity.hp)} / ${entity.maxHp} HP`;
      const lines = [card.lines[0]!, entity.buildRemaining > 0 ? `building · ${hp}` : hp];
      const research = this.session.team.research;
      if (isCore(content, this.session.team, entity)) {
        const perks = earnedPerks(content, this.session.team).map((p) => p.name);
        lines.push(`Tier: ${tierDef(content, this.session.team).name}${perks.length ? ` · ${perks.join(", ")}` : ""}`);
      }
      const lab = this.session.team.labResearch;
      const doing = isCore(content, this.session.team, entity) ? research : entity.defId === content.races[raceId]!.center ? lab : null;
      if (doing) {
        lines.push(`Researching ${upgradeName(content, raceId, doing.upgrade)} · ${Math.ceil(doing.remaining / TICK_RATE)}s`);
      }
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
    const armed = (selection.kind === "entity" || selection.kind === "army" || selection.kind === "spawners") && Boolean(selection.armed);
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

  /** Several of your spawners: what's in the group, and one rally for all of them. */
  private showSpawners(selection: Selection): void {
    const buildings = spawnerGroup(this.session, selection);
    if (buildings.length === 0) return this.show(null);
    const { content } = this.session;
    const counts = new Map<string, number>();
    for (const b of buildings) counts.set(b.defId, (counts.get(b.defId) ?? 0) + 1);
    const mix = [...counts].map(([id, n]) => `${n}× ${content.buildings[id]!.name}`).join(" · ");
    this.showAction(selection);
    this.show({
      title: `${buildings.length} buildings`,
      lines: [mix, "Right-click: one rally point for all of them", "Shift-click: add or remove one"],
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
