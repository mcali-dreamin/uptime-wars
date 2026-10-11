// Heroes: one unit per player that you command directly. It levels up from
// kills made near it, and has up to four abilities on cooldowns.
//
// The hero appears at the core when the core comes online. When it dies it
// comes back at the core after a delay that grows with its level. Orders are
// commands like any other (move, attack, cast), so heroes are as
// deterministic as the rest of the sim.

import { dealDamage } from "./combat";
import type { TickContext } from "./context";
import type { AbilityDef, Content } from "./content";
import { spawnUnit } from "./entities";
import { distance } from "./movement";
import { hostile } from "./teams";
import type { CastCommand, Entity, HeroState, Point, Team, Unit, World } from "./types";

export function heroOf(world: World, team: Team): Unit | undefined {
  const id = team.hero?.unitId ?? -1;
  if (id === -1) return undefined;
  const unit = world.entities.find((e) => e.id === id);
  return unit?.kind === "unit" && unit.hp > 0 ? unit : undefined;
}

/** Total XP needed to reach `level`. */
export function xpForLevel(content: Content, level: number): number {
  return (content.heroes.xpPerLevel * level * (level - 1)) / 2;
}

/** The ability's strength at a rank. */
export function abilityAmount(ability: AbilityDef, rank: number): number {
  return ability.amount + ability.perRank * (rank - 1);
}

/** Skill points the hero hasn't spent yet. */
export function skillPoints(content: Content, state: HeroState): number {
  let spent = 0;
  for (const rank of Object.values(state.ranks)) spent += rank;
  return state.level * content.heroes.skillPointsPerLevel - spent;
}

/** Hero level needed for the next rank of an ability. */
export function levelForRank(content: Content, ability: AbilityDef, rank: number): number {
  return ability.unlockLevel + content.heroes.levelsPerRank * (rank - 1);
}

function ownsAbility(content: Content, team: Team, abilityId: string): boolean {
  const def = team.heroId ? content.heroes.heroes[team.heroId] : undefined;
  return def !== undefined && def.abilities.includes(abilityId);
}

/** Why the hero can't learn (another rank of) this ability, or null. */
export function learnBlocker(content: Content, team: Team, abilityId: string): string | null {
  const state = team.hero;
  if (!state) return "no hero";
  if (!ownsAbility(content, team, abilityId)) return "not your ability";
  const ability = content.heroes.abilities[abilityId]!;
  const next = (state.ranks[abilityId] ?? 0) + 1;
  if (next > ability.maxRank) return "already maxed";
  if (skillPoints(content, state) <= 0) return "no skill points";
  const need = levelForRank(content, ability, next);
  if (state.level < need) return `needs level ${need}`;
  return null;
}

/** Why the hero can't cast this right now, or null. Range is checked when it gets there. */
export function castBlocker(world: World, content: Content, team: Team, abilityId: string): string | null {
  const hero = team.hero;
  if (!hero || !heroOf(world, team)) return "no hero";
  if (!ownsAbility(content, team, abilityId)) return "not your ability";
  if (!hero.ranks[abilityId]) return "not learned";
  if ((hero.cooldowns[abilityId] ?? 0) > 0) return "on cooldown";
  return null;
}

/** Spawn the hero at a core (on founding, and on respawn). */
export function spawnHero(ctx: TickContext, team: Team, at: Point): Unit | undefined {
  const { content } = ctx;
  const heroId = team.heroId;
  if (!heroId) return undefined;
  if (!team.hero) {
    team.hero = { unitId: -1, level: 1, xp: 0, baseHp: 0, ranks: {}, cooldowns: {}, respawnAt: null, focusId: null, cast: null, temps: [], buff: null };
  }
  const unit = spawnUnit(ctx, team.id, heroId, at, at.x, at.y + 60, "hero");
  team.hero.baseHp = unit.maxHp;
  applyLevel(content, unit, team.hero.level, heroId, unit.maxHp);
  unit.hp = unit.maxHp;
  team.hero.unitId = unit.id;
  team.hero.respawnAt = null;
  team.hero.focusId = null;
  team.hero.cast = null;
  return unit;
}

/**
 * Set a hero's max hp for its level, keeping the fraction of hp it had.
 * `baseHp` is its level-1 max hp as spawned (race and upgrades included).
 */
function applyLevel(content: Content, unit: Unit, level: number, heroId: string, baseHp: number): void {
  const def = content.heroes.heroes[heroId]!;
  const ratio = unit.maxHp > 0 ? unit.hp / unit.maxHp : 1;
  unit.maxHp = baseHp + def.hpPerLevel * (level - 1);
  unit.hp = Math.max(1, Math.round(unit.maxHp * ratio));
}

/** Damage a hero hits for at its level. */
export function heroDamage(content: Content, heroId: string, level: number): number {
  return content.units[heroId]!.damage + content.heroes.heroes[heroId]!.damagePerLevel * (level - 1);
}

/**
 * Credit XP for a kill: every hero within xpRange of the kill gets it (not
 * just the killer), so a hero standing in the fight levels up.
 */
export function creditKill(ctx: TickContext, victim: Entity): void {
  const { world, content } = ctx;
  if (victim.kind !== "unit") return;
  const bounty = content.units[victim.defId]!.bounty;
  if (bounty <= 0) return;
  for (const team of world.teams) {
    if (!team.hero || !hostile(world, team.id, victim.team)) continue;
    const hero = heroOf(world, team);
    if (!hero || distance(hero, victim) > content.heroes.xpRange) continue;
    gainXp(ctx, team, hero, bounty * content.heroes.xpPerBounty);
  }
}

function gainXp(ctx: TickContext, team: Team, hero: Unit, xp: number): void {
  const { world, content } = ctx;
  const state = team.hero!;
  state.xp += xp;
  while (state.level < content.heroes.maxLevel && state.xp >= xpForLevel(content, state.level + 1)) {
    state.level += 1;
    applyLevel(content, hero, state.level, hero.defId, state.baseHp);
    world.events.push({ type: "hero-level", team: team.id, level: state.level });
  }
}

/** Each tick: cooldowns, decoys expiring, death and respawn. */
export function tickHeroes(ctx: TickContext): void {
  const { world, content } = ctx;
  for (const team of world.teams) {
    const state = team.hero;
    if (!state) continue;
    for (const ability of Object.keys(state.cooldowns)) {
      if (state.cooldowns[ability]! > 0) state.cooldowns[ability]! -= 1;
    }
    state.temps = state.temps.filter((temp) => {
      const unit = ctx.byId.get(temp.id);
      if (!unit || unit.hp <= 0) return false;
      if (world.tick < temp.until) return true;
      unit.hp = 0;
      return false;
    });
    if (state.buff && world.tick >= state.buff.until) state.buff = null;

    if (state.unitId !== -1) {
      const hero = ctx.byId.get(state.unitId);
      if (!hero || hero.hp <= 0) {
        const def = content.heroes.heroes[team.heroId!]!;
        state.unitId = -1;
        state.respawnAt = world.tick + def.respawnTicks + def.respawnPerLevel * (state.level - 1);
        state.focusId = null;
        state.cast = null;
        world.events.push({ type: "hero-down", team: team.id, respawnAt: state.respawnAt });
      }
    }
    if (state.unitId === -1 && state.respawnAt !== null && world.tick >= state.respawnAt && team.downTick === null) {
      const core = ctx.byId.get(team.coreId);
      if (core && core.hp > 0) {
        const hero = spawnHero(ctx, team, core);
        if (hero) world.events.push({ type: "hero-up", team: team.id, x: hero.x, y: hero.y });
      }
    }
  }
}

/** A cast order: remember it; the hero walks into range and casts (see the hero behaviour). */
export function orderCast(ctx: TickContext, team: Team, command: CastCommand): string | null {
  const { world, content } = ctx;
  const reason = castBlocker(world, content, team, command.ability);
  if (reason) return reason;
  const ability = content.heroes.abilities[command.ability]!;
  if (ability.target === "enemy") {
    const target = command.targetId === null ? undefined : ctx.byId.get(command.targetId);
    if (!target || target.hp <= 0 || !hostile(world, target.team, team.id)) return "needs an enemy";
  }
  const state = team.hero!;
  state.cast = { ability: command.ability, x: command.x, y: command.y, targetId: command.targetId };
  state.focusId = null;
  return null;
}

/** Where a pending cast lands, if its target still exists. */
export function castPoint(ctx: TickContext, cast: NonNullable<HeroState["cast"]>, hero: Unit): Point | null {
  if (cast.targetId !== null) {
    const target = ctx.byId.get(cast.targetId);
    return target && target.hp > 0 ? target : null;
  }
  const ability = ctx.content.heroes.abilities[cast.ability]!;
  return ability.target === "self" ? hero : { x: cast.x, y: cast.y };
}

/** Make the cast now. The hero is in range. */
export function resolveCast(ctx: TickContext, team: Team, hero: Unit, abilityId: string, at: Point, targetId: number | null): void {
  const { world, content } = ctx;
  const state = team.hero!;
  const ability = content.heroes.abilities[abilityId]!;
  const amount = abilityAmount(ability, state.ranks[abilityId] ?? 1);
  state.cooldowns[abilityId] = ability.cooldownTicks;
  world.events.push({ type: "cast", team: team.id, ability: abilityId, x: at.x, y: at.y, radius: ability.radius ?? 0, targetId });

  switch (ability.effect) {
    case "blast":
      for (const entity of world.entities) {
        if (entity.hp <= 0 || !hostile(world, entity.team, team.id)) continue;
        const dx = entity.x - at.x;
        const dy = entity.y - at.y;
        const reach = ability.radius! + entity.radius;
        if (dx * dx + dy * dy <= reach * reach) dealDamage(ctx, hero, entity, ability.attackType!, amount);
      }
      return;
    case "strike": {
      const target = targetId === null ? undefined : ctx.byId.get(targetId);
      if (target && target.hp > 0) dealDamage(ctx, hero, target, ability.attackType!, amount);
      return;
    }
    case "heal":
      for (const entity of world.entities) {
        if (entity.hp <= 0 || entity.team !== team.id) continue;
        if (entity.kind === "building" && entity.buildRemaining > 0) continue;
        if (distance(entity, hero) > ability.radius! + entity.radius) continue;
        entity.hp = Math.min(entity.maxHp, entity.hp + amount);
      }
      return;
    case "decoy": {
      const decoy = spawnUnit(ctx, team.id, ability.unit!, at, at.x, at.y, "decoy");
      decoy.maxHp = decoy.hp = amount;
      state.temps.push({ id: decoy.id, until: world.tick + ability.durationTicks! });
      // Every creep near it drops what it was doing and goes for the decoy.
      for (const entity of world.entities) {
        if (entity.kind !== "unit" || entity.hp <= 0 || !hostile(world, entity.team, team.id)) continue;
        if (distance(entity, decoy) <= ability.radius!) entity.targetId = decoy.id;
      }
      return;
    }
    case "summon":
      for (let i = 0; i < amount; i += 1) {
        // Spread around the hero in a fixed pattern (no trig in the sim).
        const ox = [40, 0, -40, 0, 30, -30, 30, -30][i % 8]!;
        const oy = [0, 40, 0, -40, 30, 30, -30, -30][i % 8]!;
        const unit = spawnUnit(ctx, team.id, ability.unit!, hero, hero.x + ox, hero.y + oy, "guard");
        state.temps.push({ id: unit.id, until: world.tick + ability.durationTicks! });
      }
      return;
    case "buff":
      state.buff = { amount, until: world.tick + ability.durationTicks! };
      return;
  }
}

/** Damage multiplier from a running buff ability (1 when none). */
export function buffMultiplier(team: Team, tick: number): number {
  const buff = team.hero?.buff;
  return buff && tick < buff.until ? 1 + buff.amount : 1;
}

/** Is this unit being held by a decoy? Decoys keep creeps that were lured onto them. */
export function luredBy(ctx: TickContext, unit: Unit): Entity | undefined {
  if (unit.targetId === null) return undefined;
  const target = ctx.byId.get(unit.targetId);
  return target?.kind === "unit" && target.mode === "decoy" && target.hp > 0 ? target : undefined;
}

