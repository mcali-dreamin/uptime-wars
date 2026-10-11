// The wave director: endless, escalating waves from the nest.

import type { TickContext } from "./context";
import type { Content } from "./content";
import { spawnUnit } from "./entities";
import { randomInt } from "./rng";
import type { World } from "./types";

/**
 * The horde is not special: it is a team whose controller is the wave
 * director instead of a human. Waves never stop. Each is generated from a
 * growing budget, shuffled, cut into random-sized packs, and released from the
 * nest in the middle of the web. Nobody tells the packs where you are.
 */
export function tickWaveDirector(ctx: TickContext): void {
  const { world, content } = ctx;
  const team = world.teams.find((t) => t.controller === "wave-director");
  if (!team) return;
  const waves = content.waves;
  const state = world.waves;
  const nest = ctx.byId.get(team.coreId);
  if (!nest) return;

  if (world.tick >= state.nextWaveTick) {
    const wave = state.nextIndex + 1;
    const plan = planWave(world, content, wave);
    let at = world.tick;
    let packs = 0;
    for (let i = 0; i < plan.units.length; ) {
      const size = randomInt(world, waves.packSize.min, waves.packSize.max);
      const packId = state.nextPackId++;
      packs += 1;
      for (const unit of plan.units.slice(i, i + size)) state.pending.push({ tick: at, unit, packId, wave });
      i += size;
      at += waves.spawnSpacingTicks;
    }
    world.events.push({ type: "wave", wave, name: plan.name, packs, units: plan.units.length, boss: plan.bosses > 0 });
    state.nextIndex = wave;
    state.nextWaveTick = world.tick + waveInterval(content, wave);
  }

  let alive = 0;
  for (const entity of world.entities) if (entity.kind === "unit" && entity.team === team.id) alive += 1;
  while (state.pending.length > 0 && state.pending[0]!.tick <= world.tick && alive < waves.maxAlive) {
    const spawn = state.pending.shift()!;
    const x = nest.x + randomInt(world, -60, 60);
    const y = nest.y + randomInt(world, -60, 60);
    const hp = 1 + waves.hpGrowthPerWave * (spawn.wave - 1);
    const unit = spawnUnit(ctx, team.id, spawn.unit, nest, x, y, "roam", hp);
    unit.packId = spawn.packId;
    alive += 1;
  }
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
export function planWave(world: World, content: Content, wave: number) {
  const { budget, roster, bosses } = content.waves;
  // Repeated multiplication, not Math.pow: the spec lets pow be approximate,
  // and two browsers disagreeing on a wave size would desync a match.
  let scale = 1;
  for (let i = 1; i < wave; i += 1) scale *= budget.growth;
  let points = Math.round(budget.start * scale);
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
  return { units, bosses: bossCount, name: waveName(content, wave) };
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
