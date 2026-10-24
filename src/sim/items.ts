// Items: the hero's gear. Six slots, kept through death and respawn.
//
// - Shop: while the hero stands within a core's shop radius (the core-heal
//   radius), the player can buy the basics and sell anything back for part
//   of its price. Passive stats stack per copy carried.
// - Drops: when a Botnet Farm, a C2 Server or an incident boss falls to a
//   player, one item from the drop table lands where it died and lies there
//   until a hero of the killing alliance takes it (pickUp). There is no
//   passive pickup: the sim only changes through explicit commands.
// - The drop roll is derived from the match seed and the dead entity's id
//   through its own throwaway RNG. It never touches world.rngState, so adding
//   drops doesn't shift any other random roll in the match.

import type { TickContext } from "./context";
import type { Content, ItemDef, ItemStats } from "./content";
import { nextRandom } from "./rng";
import { teamCores } from "./placement";
import { allied } from "./teams";
import { distance } from "./movement";
import type { BuyItemCommand, HeroState, PickUpCommand, SellItemCommand, Team, Unit, UseItemCommand, World } from "./types";

/** Slots in a hero's inventory. */
export const MAX_ITEMS = 6;

/** Every passive stat, summed over the inventory. Multipliers are permille (1000 = none). */
export interface ItemTotals {
  damage: number;
  armor: number;
  hp: number;
  regen: number;
  speed: number;
  attackSpeed: number;
}

const NONE: ItemTotals = { damage: 0, armor: 0, hp: 0, regen: 0, speed: 1000, attackSpeed: 1000 };

/** The hero's stat bonuses from everything it carries. */
export function itemTotals(content: Content, state: HeroState | null | undefined): ItemTotals {
  const totals = { ...NONE };
  if (!state) return totals;
  for (const stack of state.items) {
    const stats: ItemStats = content.items.items[stack.item]?.stats ?? {};
    totals.damage += stats.damage ?? 0;
    totals.armor += stats.armor ?? 0;
    totals.hp += stats.hp ?? 0;
    totals.regen += stats.regen ?? 0;
    totals.speed += stats.speed ? stats.speed - 1000 : 0;
    totals.attackSpeed += stats.attackSpeed ? stats.attackSpeed - 1000 : 0;
  }
  return totals;
}

/** What selling this item gives back. */
export function sellValue(content: Content, itemId: string): number {
  return Math.floor((content.items.items[itemId]!.cost * content.items.sellPermille) / 1000);
}

/** The shop is where the hero already heals: within a core's core-heal radius. */
export function shopRadius(content: Content): number {
  return content.heroes.coreHeal?.radius ?? 0;
}

/** Is this team's hero (alive or down) within the shop range of one of its cores? */
export function atShop(world: World, content: Content, team: Team): boolean {
  if (team.coreId === -1) return false;
  const cores = teamCores(world, content, team);
  const hero = heroSpot(world, team);
  return cores.some((core) => hero && distance(core, hero) <= shopRadius(content) + core.radius);
}

/** The team's living hero unit, if it's on the board. */
function heroSpot(world: World, team: Team): Unit | undefined {
  const hero = world.entities.find((e) => e.kind === "unit" && e.id === team.hero?.unitId && e.hp > 0);
  return hero?.kind === "unit" ? hero : undefined;
}

/** Why the hero can't buy this right now, or null. */
export function shopBlocker(world: World, content: Content, team: Team, itemId: string): string | null {
  const def = content.items.items[itemId];
  if (!def) return "unknown item";
  if (!def.shop) return "not for sale";
  if (!atShop(world, content, team)) return "not at the shop";
  if ((team.hero?.items.length ?? 0) >= MAX_ITEMS) return "inventory full";
  if (team.money < def.cost) return "not enough $";
  return null;
}

/** Why the hero can't sell from this slot right now, or null. */
export function sellBlocker(world: World, content: Content, team: Team, slot: number): string | null {
  const stack = team.hero?.items[slot];
  if (!stack) return "empty slot";
  if (!atShop(world, content, team)) return "not at the shop";
  return null;
}

/** Why the hero can't use this slot right now, or null. */
export function useBlocker(world: World, content: Content, team: Team, slot: number): string | null {
  const hero = heroSpot(world, team);
  if (!hero) return "no hero";
  const stack = team.hero?.items[slot];
  if (!stack) return "empty slot";
  if (!content.items.items[stack.item]!.active) return "nothing to use";
  return null;
}

/** Why this ground item can't be ordered picked up right now, or null. */
export function pickUpBlocker(world: World, team: Team, itemId: number): string | null {
  if (!world.groundItems.some((g) => g.id === itemId)) return "nothing there";
  if (!heroSpot(world, team)) return "no hero";
  if ((team.hero?.items.length ?? 0) >= MAX_ITEMS) return "inventory full";
  return null;
}

// --- commands ------------------------------------------------------------------

/** buyItem: pay, take the item. */
export function applyBuy(ctx: TickContext, command: BuyItemCommand): string | null {
  const { world, content } = ctx;
  const team = world.teams[command.team]!;
  const reason = shopBlocker(world, content, team, command.item);
  if (reason) return reason;
  const hero = heroSpot(world, team)!;
  const def = content.items.items[command.item]!;
  team.money -= def.cost;
  team.hero!.items.push({ item: command.item, ...(def.charges ? { charges: def.charges } : {}) });
  refreshHeroItems(content, team, hero);
  return null;
}

/** sellItem: give it back for a share of the price. */
export function applySell(ctx: TickContext, command: SellItemCommand): string | null {
  const { world, content } = ctx;
  const team = world.teams[command.team]!;
  const reason = sellBlocker(world, content, team, command.slot);
  if (reason) return reason;
  const hero = heroSpot(world, team)!;
  const [sold] = team.hero!.items.splice(command.slot, 1);
  team.money += sellValue(content, sold!.item);
  refreshHeroItems(content, team, hero);
  return null;
}

/** useItem: spend a charge of a consumable. */
export function applyUse(ctx: TickContext, command: UseItemCommand): string | null {
  const { world, content } = ctx;
  const team = world.teams[command.team]!;
  const reason = useBlocker(world, content, team, command.slot);
  if (reason) return reason;
  const hero = heroSpot(world, team)!;
  const state = team.hero!;
  const stack = state.items[command.slot]!;
  const def = content.items.items[stack.item]!;
  useActive(ctx, team, hero, def);
  stack.charges = (stack.charges ?? 1) - 1;
  if (stack.charges <= 0) state.items.splice(command.slot, 1);
  refreshHeroItems(content, team, hero);
  return null;
}

/** pickUp: remember the item; the hero walks there and takes it (see units/hero.ts). */
export function applyPickUp(ctx: TickContext, command: PickUpCommand): string | null {
  const { world } = ctx;
  const team = world.teams[command.team]!;
  const reason = pickUpBlocker(world, team, command.itemId);
  if (reason) return reason;
  const drop = world.groundItems.find((g) => g.id === command.itemId)!;
  if (!allied(world, team.id, drop.team)) return "not yours";
  const hero = heroSpot(world, team)!;
  const state = team.hero!;
  state.pickup = drop.id;
  state.focusId = null;
  state.cast = null;
  hero.moveTo = { x: drop.x, y: drop.y };
  return null;
}

/** One charge spent: the item's active goes off around the hero. */
function useActive(ctx: TickContext, team: Team, hero: Unit, def: ItemDef): void {
  const { world } = ctx;
  const active = def.active!;
  world.events.push({ type: "cast", team: team.id, ability: def.name, x: hero.x, y: hero.y, radius: active.radius, targetId: null });
  for (const entity of world.entities) {
    if (entity.hp <= 0 || entity.team !== team.id) continue;
    if (entity.kind === "building" && entity.buildRemaining > 0) continue;
    if (distance(entity, hero) > active.radius + entity.radius) continue;
    entity.hp = Math.min(entity.maxHp, entity.hp + active.amount);
  }
}

// --- pickups -------------------------------------------------------------------

/**
 * Which item (if any) falls where this entity died: the drop table rolled on
 * a throwaway RNG keyed by the match seed and the dead entity's id. Pure:
 * world.rngState is untouched, and two peers agree without sharing anything
 * but the seed.
 */
export function rollDrop(content: Content, seed: number, source: "farm" | "c2" | "boss", entityId: number): string | null {
  const { drops } = content.items;
  const scratch = { rngState: (seed ^ Math.imul(entityId + 1, 0x9e3779b1)) | 0 };
  if (nextRandom(scratch) * 1000 >= drops[source]) return null;
  const total = drops.table.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = nextRandom(scratch) * total;
  for (const entry of drops.table) {
    roll -= entry.weight;
    if (roll < 0) return entry.item;
  }
  return drops.table[drops.table.length - 1]!.item;
}

/** What kind of drop source a dying horde entity is, if it is one. */
function dropSource(content: Content, victim: { kind: string; defId: string; team: number }, world: World): "farm" | "c2" | "boss" | null {
  const horde = world.teams[victim.team];
  if (!horde || horde.controller === "human") return null;
  const waves = content.waves;
  if (victim.defId === waves.fortress.farms.building) return "farm";
  if (victim.defId === waves.fortress.building) return "c2";
  if (victim.defId === waves.bosses.unit) return "boss";
  return null;
}

/**
 * A push pays: on a drop-source death to a player, one item lands where it
 * died for the killer's alliance. Only actual kills count, not collapses.
 */
export function dropLoot(ctx: TickContext, victim: { kind: string; defId: string; team: number; x: number; y: number; id: number }, killerTeam: number): void {
  const { world, content } = ctx;
  const source = dropSource(content, victim, world);
  if (!source) return;
  const killer = world.teams[killerTeam];
  if (!killer || killer.controller !== "human") return;
  const item = rollDrop(content, world.seed, source, victim.id);
  if (!item) return;
  world.groundItems.push({ id: victim.id, item, x: victim.x, y: victim.y, team: killerTeam });
}

/** The hero reached a drop: into the first free slot (the order was accepted, so there is one). */
export function takeDrop(world: World, content: Content, team: Team, dropId: number): void {
  const index = world.groundItems.findIndex((g) => g.id === dropId);
  if (index === -1) return;
  const [drop] = world.groundItems.splice(index, 1);
  const def = content.items.items[drop!.item]!;
  team.hero!.items.push({ item: drop!.item, ...(def.charges ? { charges: def.charges } : {}) });
  const hero = heroSpot(world, team);
  if (hero) refreshHeroItems(content, team, hero);
}

// --- stats ---------------------------------------------------------------------

/**
 * Re-derive the hero's max HP (level and gear) after its items changed: gains
 * add to the current HP too, losses can't take it below 1.
 */
export function refreshHeroItems(content: Content, team: Team, hero: Unit): void {
  const state = team.hero;
  if (!state) return;
  const def = content.heroes.heroes[hero.defId]!;
  const maxHp = state.baseHp + def.hpPerLevel * (state.level - 1) + itemTotals(content, state).hp;
  const delta = maxHp - hero.maxHp;
  hero.maxHp = maxHp;
  hero.hp = Math.max(1, Math.min(maxHp, hero.hp + Math.max(0, delta)));
}

/** The hero's move speed with its gear, in pixels per tick (the unit def's, geared up). */
export function heroSpeed(content: Content, team: Team, speed: number): number {
  return (speed * itemTotals(content, team.hero).speed) / 1000;
}

/** Ticks between the hero's attacks with its gear (the unit def's cooldown, geared down). */
export function heroAttackCooldown(content: Content, team: Team, cooldownTicks: number): number {
  return Math.max(1, Math.round((cooldownTicks * 1000) / itemTotals(content, team.hero).attackSpeed));
}

/** Item HP regen, applied once a second wherever the hero stands. */
export function tickItemRegen(ctx: TickContext, team: Team): void {
  const { world, content } = ctx;
  const state = team.hero;
  if (!state || world.tick % 20 !== 0) return;
  const regen = itemTotals(content, state).regen;
  if (regen <= 0 || state.unitId === -1) return;
  const hero = ctx.byId.get(state.unitId);
  if (!hero || hero.kind !== "unit" || hero.hp <= 0) return;
  hero.hp = Math.min(hero.maxHp, hero.hp + regen);
}
