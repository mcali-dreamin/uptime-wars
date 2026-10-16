// The wave director: the horde's pressure, from the nest. Two parts:
// background traffic (a small pack every few seconds, growing over the
// match) and incidents (the numbered, named surges, with the bosses).
// Both scale with how many players are still online.

import type { TickContext } from "./context";
import type { Content } from "./content";
import { spawnUnit } from "./entities";
import { farmsDown, fortify, raiseFarms } from "./fortress";
import { TILE } from "./map";
import { goalField } from "./movement";
import { ORTHOGONAL, UNREACHABLE, bodyFits } from "./nav";
import { randomInt } from "./rng";
import { rankWorth, stampRank } from "./ranks";
import { liveNodes, sendInfectors } from "./spread";
import { humanTeams } from "./teams";
import type { Building, Point, TeamId, World } from "./types";

/**
 * The horde is not special: it is a team whose controller is the wave
 * director instead of a human. Nothing ever stops. Every pack is released
 * from the nest in the middle of the web, and nobody tells it where you are.
 */
export function tickWaveDirector(ctx: TickContext): void {
  const { world, content } = ctx;
  const team = world.teams.find((t) => t.controller === "wave-director");
  if (!team) return;
  const waves = content.waves;
  const state = world.waves;
  const nest = ctx.byId.get(team.coreId);
  if (!nest) return;

  // Background traffic: one small pack, every few seconds.
  if (world.tick >= state.nextTrickleTick) {
    if (state.trickleSince < 0) state.trickleSince = world.tick;
    const units = planTrickle(world, content);
    const packId = state.nextPackId++;
    const wave = Math.max(1, state.nextIndex);
    for (const unit of units) state.pending.push({ tick: world.tick, unit, packId, wave });
    state.nextTrickleTick = world.tick + waves.trickle.everyTicks;
  }

  // Incidents.
  if (world.tick >= state.nextWaveTick) {
    const wave = state.nextIndex + 1;
    // Every farm down shrinks the wave.
    const down = farmsDown(world, content, team.id);
    const budgetScale = Math.max(0, 1000 - down * waves.fortress.farms.weakenPermille);
    // The opening incident lands at each player's door, smaller.
    const entries = wave === 1 && waves.opening ? openingEntries(ctx) : [];
    const scale =
      entries.length > 0
        ? Math.round((waves.opening!.budget * 1000) / waves.budget.start)
        : Math.round((budgetScale * threatPermille(world, content)) / 1000);
    const plan = planWave(world, content, wave, scale);
    let at = world.tick;
    let packs = 0;
    // The botnet's spread: some packs come out of its infected nodes instead of the nest.
    const nodes = liveNodes(world, content, team.id);
    const ranked = plan.rank > 0 ? { rank: plan.rank } : {};
    for (let i = 0; i < plan.units.length; ) {
      const size = randomInt(world, waves.packSize.min, waves.packSize.max);
      const packId = state.nextPackId++;
      const entry = entries[packs % Math.max(1, entries.length)];
      packs += 1;
      const fromNode = entry === undefined && nodes.length > 0 && randomInt(world, 1, 1000) <= waves.spread.sharePermille;
      const from = fromNode ? nodes[randomInt(world, 0, nodes.length - 1)]!.id : undefined;
      for (const unit of plan.units.slice(i, i + size)) {
        const spawn = { tick: at, unit, packId, wave, ...ranked };
        state.pending.push(entry ? { ...spawn, at: entry.at, target: entry.core } : from === undefined ? spawn : { ...spawn, from });
      }
      i += size;
      at += waves.spawnSpacingTicks;
    }
    world.events.push({
      type: "wave",
      wave,
      name: plan.name,
      packs,
      units: plan.units.length,
      boss: plan.bosses > 0,
      ...(entries.length ? { entries: entries.map((e) => ({ team: e.team, x: e.at.x, y: e.at.y })) } : {}),
    });
    sendInfectors(ctx, team.id, wave);
    if (wave % waves.fortress.rebuildEvery === 0) {
      const rebuilt = fortify(world, content, team.id, wave);
      if (rebuilt > 0) world.events.push({ type: "fortified", wave, rebuilt });
    }
    if (wave % waves.fortress.farms.rebuildEvery === 0) {
      const rebuilt = raiseFarms(world, content, team.id);
      if (rebuilt > 0) world.events.push({ type: "farms-rebuilt", wave, rebuilt });
    }
    state.nextIndex = wave;
    state.nextWaveTick = world.tick + waveInterval(content, wave);
  }

  // The cap counts worth, not heads: a rank-3 creep fills eight slots.
  let alive = 0;
  for (const entity of world.entities) if (entity.kind === "unit" && entity.team === team.id) alive += rankWorth(content, world, entity);
  while (state.pending.length > 0 && state.pending[0]!.tick <= world.tick && alive < waves.maxAlive) {
    const spawn = state.pending.shift()!;
    // At its door (the opening), out of its node if that still stands, else the nest.
    const node = spawn.from === undefined ? undefined : ctx.byId.get(spawn.from);
    const source = spawn.at ?? (node && node.hp > 0 ? node : nest);
    const spread = spawn.at ? 40 : 60;
    const x = source.x + randomInt(world, -spread, spread);
    const y = source.y + randomInt(world, -spread, spread);
    const hp = 1 + waves.hpGrowthPerWave * (spawn.wave - 1);
    const unit = spawnUnit(ctx, team.id, spawn.unit, source, x, y, spawn.infect ? "infector" : "roam", hp);
    const level = spawn.rank ? content.waves.ranks?.levels[spawn.rank - 1] : undefined;
    if (level) stampRank(unit, spawn.rank!, level);
    alive += (level?.worth ?? 1) - 1;
    unit.packId = spawn.packId;
    if (spawn.infect) unit.foundAt = { ...spawn.infect };
    // Marching on a base: no wandering first.
    if (spawn.target && state.packs[spawn.packId] === undefined) state.packs[spawn.packId] = { x: spawn.target.x, y: spawn.target.y };
    alive += 1;
  }
}

/**
 * Pressure multiplier for the players still online: 1 solo, plus `k` for
 * each extra player. `kind` picks k: the trickle scales strongly (it spreads
 * over everyone), incidents gently (each lands on one base).
 */
export function playerScale(world: World, content: Content, kind: "trickle" | "incident"): number {
  let online = 0;
  for (const team of humanTeams(world)) if (team.downTick === null) online += 1;
  return 1 + content.waves.players[kind] * Math.max(0, online - 1);
}

/** The points the next background-traffic pack spends. */
export function trickleBudget(world: World, content: Content): number {
  const { trickle } = content.waves;
  const since = world.waves.trickleSince < 0 ? 0 : world.tick - world.waves.trickleSince;
  // Integer minutes keep it exact; it grows in steps a minute apart.
  const minutes = Math.floor(since / (60 * 20));
  return Math.round((trickle.start + trickle.perMinute * minutes) * playerScale(world, content, "trickle"));
}

/** One background-traffic pack: whatever the latest incident has unlocked, never bosses. */
function planTrickle(world: World, content: Content): string[] {
  const { roster, trickle } = content.waves;
  const unlocked = roster.filter((entry) => entry.fromWave <= Math.max(1, world.waves.nextIndex));
  const totalWeight = unlocked.reduce((sum, entry) => sum + entry.weight, 0);
  const cheapest = Math.min(...unlocked.map((entry) => entry.cost));
  let points = trickleBudget(world, content);
  const units: string[] = [];
  while (points >= cheapest && units.length < trickle.maxPack) {
    let roll = randomInt(world, 1, totalWeight);
    let pick = unlocked[0]!;
    for (const entry of unlocked) {
      roll -= entry.weight;
      if (roll <= 0) {
        pick = entry;
        break;
      }
    }
    if (pick.cost > points) pick = unlocked.find((entry) => entry.cost === cheapest)!;
    units.push(pick.unit);
    points -= pick.cost;
  }
  return units;
}

/**
 * Where the opening incident comes in for each player online with a core: on
 * the line from the core toward the nest, `entryDistance` out, on open ground
 * the core can be reached from. Pure function of the world; sqrt only.
 */
export function openingEntries(ctx: TickContext): { team: TeamId; at: Point; core: Point }[] {
  const { world, content } = ctx;
  const { terrain } = world;
  const distance = content.waves.opening!.entryDistance;
  const nest = ctx.byId.get(world.teams.find((t) => t.controller === "wave-director")?.coreId ?? -1);
  const out: { team: TeamId; at: Point; core: Point }[] = [];
  for (const team of humanTeams(world)) {
    if (team.downTick !== null) continue;
    const core = ctx.byId.get(team.coreId) as Building | undefined;
    if (!core || core.hp <= 0 || !nest) continue;
    const dx = nest.x - core.x;
    const dy = nest.y - core.y;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    const field = goalField(world, Math.floor(core.y / TILE) * terrain.cols + Math.floor(core.x / TILE));
    let found: Point | null = null;
    // Walk back toward the core until there's open ground with a short way in.
    for (let d = distance; d >= TILE * 4 && !found; d -= TILE) {
      const cx = Math.floor((core.x + (dx / length) * d) / TILE);
      const cy = Math.floor((core.y + (dy / length) * d) / TILE);
      for (let r = 0; r <= 3 && !found; r += 1) {
        for (let oy = -r; oy <= r && !found; oy += 1) {
          for (let ox = -r; ox <= r && !found; ox += 1) {
            if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
            const col = cx + ox;
            const row = cy + oy;
            if (col < 0 || row < 0 || col >= terrain.cols || row >= terrain.rows) continue;
            const cost = field[row * terrain.cols + col]!;
            // Reachable, and by a fairly direct walk: no entry behind a cliff they'd have to go round.
            if (cost === UNREACHABLE || (cost * TILE) / ORTHOGONAL > d * 1.25) continue;
            const p = { x: (col + 0.5) * TILE, y: (row + 0.5) * TILE };
            if (bodyFits(terrain, p.x, p.y, 12)) found = p;
          }
        }
      }
    }
    out.push({ team: team.id, at: found ?? { x: nest.x, y: nest.y }, core: { x: core.x, y: core.y } });
  }
  return out;
}

/**
 * How much bigger incidents are because of what the players have built and
 * banked, permille (1000 = no change). sqrt(worth / reference), clamped to
 * [1, maxScale]; worth is averaged over the players online so co-op doesn't
 * double-count (playerScale already handles headcount).
 */
export function threatPermille(world: World, content: Content): number {
  const threat = content.waves.threat;
  if (!threat) return 1000;
  let total = 0;
  let players = 0;
  for (const team of humanTeams(world)) {
    if (team.downTick !== null || team.coreId === -1) continue;
    players += 1;
    total += Math.max(0, team.money);
    for (const e of world.entities) {
      if (e.kind !== "building" || e.team !== team.id || e.hp <= 0) continue;
      total += Math.round(content.buildings[e.defId]!.cost * content.races[team.raceId]!.modifiers.costMultiplier);
    }
  }
  if (players === 0) return 1000;
  const ratio = total / players / threat.referenceWorth;
  const scale = Math.min(threat.maxScale, Math.max(1, Math.sqrt(ratio)));
  return Math.round(scale * 1000);
}

/** Ticks between wave n and wave n + 1. */
export function waveInterval(content: Content, wave: number): number {
  const { startTicks, minTicks, shrinkPerWave } = content.waves.interval;
  return Math.max(minTicks, startTicks - shrinkPerWave * (wave - 1));
}

/**
 * What wave n contains. Bosses first, then the rest of the budget spent on
 * randomly chosen unlocked units, then shuffled so packs come out mixed.
 */
export function planWave(world: World, content: Content, wave: number, budgetPermille = 1000) {
  const { budget, roster, bosses } = content.waves;
  // Repeated multiplication, not Math.pow: the spec lets pow be approximate,
  // and two browsers disagreeing on a wave size would desync a match.
  let scale = 1;
  for (let i = 1; i < wave; i += 1) scale *= i + 1 > (budget.lateFrom ?? Infinity) ? budget.lateGrowth! : budget.growth;
  let points = Math.round((budget.start * scale * playerScale(world, content, "incident") * budgetPermille) / 1000);
  const units: string[] = [];

  const bossCount = bossesIn(content, wave);
  for (let i = 0; i < bossCount; i += 1) units.push(bosses.unit);

  const unlocked = roster.filter((entry) => entry.fromWave <= wave);
  const totalWeight = unlocked.reduce((sum, entry) => sum + entry.weight, 0);
  const cheapest = Math.min(...unlocked.map((entry) => entry.cost));
  while (points >= cheapest) {
    let roll = randomInt(world, 1, totalWeight);
    let pick = unlocked[0]!;
    for (const entry of unlocked) {
      roll -= entry.weight;
      if (roll <= 0) {
        pick = entry;
        break;
      }
    }
    if (pick.cost > points) {
      // Can't afford this pick: spend what's left on the cheapest unit.
      pick = unlocked.find((entry) => entry.cost === cheapest)!;
    }
    units.push(pick.unit);
    points -= pick.cost;
  }

  for (let i = units.length - 1; i > 0; i -= 1) {
    const j = randomInt(world, 0, i);
    [units[i], units[j]] = [units[j]!, units[i]!];
  }
  const { kept, rank } = condense(content, units);
  return { units: kept, rank, bosses: bossCount, name: waveName(content, wave) };
}

/**
 * Tougher, not bigger: a wave past `ranks.maxUnits` keeps one creep in 2^r
 * (every boss stays), all at rank r, the smallest rank that fits. The list
 * is already shuffled, so keeping every 2^r-th is a fair sample.
 */
function condense(content: Content, units: string[]): { kept: string[]; rank: number } {
  const ranks = content.waves.ranks;
  if (!ranks || units.length <= ranks.maxUnits) return { kept: units, rank: 0 };
  const boss = content.waves.bosses.unit;
  let rank = 0;
  let every = 1;
  while (rank < ranks.levels.length && Math.ceil(units.length / every) > ranks.maxUnits) {
    rank += 1;
    every *= 2;
  }
  const kept = units.filter((unit, i) => unit === boss || i % every === 0);
  return { kept: kept.slice(0, ranks.maxUnits), rank };
}

/** What wave n will bring, without rolling it. */
export interface WavePreview {
  wave: number;
  name: string;
  /** Creep types that can appear, roster order. */
  creeps: string[];
  /** Creep types appearing for the first time this wave. */
  fresh: string[];
  bosses: number;
  boss: string;
}

/**
 * Wave n as far as it's knowable in advance: its name, which creeps it can
 * contain, which are new, and its bosses. Pure: it never touches the world's
 * RNG, so the UI can call it every frame without changing the match.
 */
export function previewWave(content: Content, wave: number): WavePreview {
  const { roster, bosses } = content.waves;
  const unlocked = roster.filter((entry) => entry.fromWave <= wave);
  const count = bossesIn(content, wave);
  return {
    wave,
    name: waveName(content, wave),
    creeps: unlocked.map((entry) => entry.unit),
    fresh: unlocked.filter((entry) => entry.fromWave === wave).map((entry) => entry.unit),
    bosses: count,
    boss: bosses.unit,
  };
}

function bossesIn(content: Content, wave: number): number {
  const { fromWave, every } = content.waves.bosses;
  if (wave < fromWave || (wave - fromWave) % every !== 0) return 0;
  return 1 + Math.floor((wave - fromWave) / (every * 3));
}

function waveName(content: Content, wave: number): string {
  const { names } = content.waves;
  const base = names[(wave - 1) % names.length]!;
  const cycle = Math.floor((wave - 1) / names.length);
  return cycle === 0 ? base : `${base} ${cycle + 1}`;
}
