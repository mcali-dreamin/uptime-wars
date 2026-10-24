// The nest's fortress: C2 Servers guarding every gateway up onto the nest's
// plateau, plus a ring around the nest itself. Where they stand is a pure
// function of the terrain (so of the seed): every peer agrees, and nothing
// about it needs to be stored. Every few waves the botnet rebuilds the ones
// you've knocked down, tougher than before.

import type { Content } from "./content";
import { placeBuilding } from "./entities";
import { clusters } from "./terrain/elevation";
import { FORTRESS_RADIUS } from "./terrain/params";
import { TILE_OPEN, TILE_RAMP, type Terrain, type TilePoint } from "./terrain/tiles";
import type { TickContext } from "./context";
import { isCore } from "./placement";
import { hostile } from "./teams";
import type { Entity, TeamId, World } from "./types";
import { planWave } from "./waves";

/** Diagonal posts around the nest, in tiles from its center. */
const RING = [[-4, -4], [4, -4], [-4, 4], [4, 4]] as const;
/** How far inside a gateway its guard stands, in tiles. */
const GATE_DEPTH = 3;

/** One tile per gateway onto the plateau: the middle of each ramp. */
export function fortressGates(terrain: Terrain): TilePoint[] {
  const { cols, nest } = terrain;
  const cx = nest.col + 1;
  const cy = nest.row + 1;
  const reach = (FORTRESS_RADIUS + 1) * (FORTRESS_RADIUS + 1);
  const ramps: number[] = [];
  for (let i = 0; i < terrain.tiles.length; i += 1) {
    if (terrain.tiles[i] !== TILE_RAMP || terrain.heights[i] !== 2) continue;
    const dx = (i % cols) - cx;
    const dy = Math.floor(i / cols) - cy;
    if (dx * dx + dy * dy <= reach) ramps.push(i);
  }
  return clusters(ramps, cols).map((group) => {
    const middle = group[Math.floor(group.length / 2)]!;
    return { col: middle % cols, row: Math.floor(middle / cols) };
  });
}

/** Where the C2 Servers stand: just inside each gateway, then the ring round the nest. */
export function fortressSpots(terrain: Terrain): TilePoint[] {
  const { cols, rows, nest } = terrain;
  const cx = nest.col + 1;
  const cy = nest.row + 1;
  const taken = new Set<number>();
  // Never on the nest's own footprint or right beside it.
  for (let r = nest.row - 1; r <= nest.row + 2; r += 1) for (let c = nest.col - 1; c <= nest.col + 2; c += 1) taken.add(r * cols + c);
  const free = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < cols && r < rows && terrain.tiles[r * cols + c] === TILE_OPEN && terrain.heights[r * cols + c] === 2 && !taken.has(r * cols + c);
  /** Nearest free plateau tile to (col, row), searched outward in a fixed order. */
  const near = (col: number, row: number): TilePoint | null => {
    for (let d = 0; d <= 4; d += 1) {
      for (let dr = -d; dr <= d; dr += 1) {
        for (let dc = -d; dc <= d; dc += 1) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue;
          if (free(col + dc, row + dr)) return { col: col + dc, row: row + dr };
        }
      }
    }
    return null;
  };
  const spots: TilePoint[] = [];
  const claim = (spot: TilePoint | null) => {
    if (!spot) return;
    spots.push(spot);
    // Leave a gap so towers don't wall each other in.
    for (let r = spot.row - 1; r <= spot.row + 1; r += 1) for (let c = spot.col - 1; c <= spot.col + 1; c += 1) taken.add(r * cols + c);
  };
  for (const gate of fortressGates(terrain)) {
    const dx = cx - gate.col;
    const dy = cy - gate.row;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    claim(near(Math.round(gate.col + (dx / length) * GATE_DEPTH), Math.round(gate.row + (dy / length) * GATE_DEPTH)));
  }
  for (const [dc, dr] of RING) claim(near(cx + dc, cy + dr));
  return spots;
}

/**
 * Put up every missing C2 Server, with hp scaled for this wave the way creeps
 * are. Returns how many went up.
 */
export function fortify(world: World, content: Content, team: TeamId, wave: number): number {
  const { building, hpGrowthPerWave } = content.waves.fortress;
  const scale = 1 + hpGrowthPerWave * (wave - 1);
  let built = 0;
  for (const spot of fortressSpots(world.terrain)) {
    const standing = world.entities.some(
      (e) => e.kind === "building" && e.team === team && e.defId === building && e.col === spot.col && e.row === spot.row && e.hp > 0,
    );
    if (standing) continue;
    const tower = placeBuilding(world, content, team, building, spot.col, spot.row, true);
    tower.maxHp = Math.round(tower.maxHp * scale);
    tower.hp = tower.maxHp;
    built += 1;
  }
  return built;
}

/** Botnet Farms (2x2) stand this far out from the nest, one per quarter. */
const FARM_OFFSETS = [[-8, -8], [7, -8], [-8, 7], [7, 7]] as const;
/** How many Botnet Farms garrison the fortress. */
export const FARM_COUNT = FARM_OFFSETS.length;

/** Top-left tiles of the Botnet Farms: clear of the nest, the C2 Servers, and each other. */
export function farmSpots(terrain: Terrain): TilePoint[] {
  const { cols, rows, nest } = terrain;
  const cx = nest.col + 1;
  const cy = nest.row + 1;
  const taken = new Set<number>();
  const block = (col: number, row: number, size: number, gap: number) => {
    for (let r = row - gap; r < row + size + gap; r += 1) for (let c = col - gap; c < col + size + gap; c += 1) taken.add(r * cols + c);
  };
  block(nest.col, nest.row, 2, 1);
  for (const spot of fortressSpots(terrain)) block(spot.col, spot.row, 1, 1);
  const fits = (col: number, row: number) => {
    for (let r = row; r < row + 2; r += 1) {
      for (let c = col; c < col + 2; c += 1) {
        if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
        const i = r * cols + c;
        if (terrain.tiles[i] !== TILE_OPEN || terrain.heights[i] !== 2 || taken.has(i)) return false;
      }
    }
    return true;
  };
  const spots: TilePoint[] = [];
  for (const [dc, dr] of FARM_OFFSETS) {
    let found: TilePoint | null = null;
    for (let d = 0; d <= 4 && !found; d += 1) {
      for (let r = -d; r <= d && !found; r += 1) {
        for (let c = -d; c <= d && !found; c += 1) {
          if (Math.max(Math.abs(c), Math.abs(r)) !== d) continue;
          if (fits(cx + dc + c, cy + dr + r)) found = { col: cx + dc + c, row: cy + dr + r };
        }
      }
    }
    if (!found) continue;
    spots.push(found);
    block(found.col, found.row, 2, 1);
  }
  return spots;
}

/** Put up every missing Botnet Farm. Returns how many went up. */
export function raiseFarms(world: World, content: Content, team: TeamId): number {
  const { building } = content.waves.fortress.farms;
  let built = 0;
  for (const spot of farmSpots(world.terrain)) {
    const standing = world.entities.some(
      (e) => e.kind === "building" && e.team === team && e.defId === building && e.col === spot.col && e.row === spot.row && e.hp > 0,
    );
    if (standing) continue;
    placeBuilding(world, content, team, building, spot.col, spot.row, true);
    built += 1;
  }
  return built;
}

/** How many of the fortress's farm spots have no farm standing. */
export function farmsDown(world: World, content: Content, team: TeamId): number {
  const { building } = content.waves.fortress.farms;
  const standing = world.entities.filter((e) => e.kind === "building" && e.team === team && e.defId === building && e.hp > 0).length;
  return Math.max(0, farmSpots(world.terrain).length - standing);
}

/** Botnet Farms still standing for this team. */
export function farmsStanding(world: World, content: Content, team: TeamId): number {
  const { building } = content.waves.fortress.farms;
  let standing = 0;
  for (const e of world.entities) if (e.kind === "building" && e.team === team && e.defId === building && e.hp > 0) standing += 1;
  return standing;
}

/**
 * The nest's shield: it takes no damage while any Botnet Farm stands. Break
 * the farms, then the nest. Farms the botnet rebuilds put the shield back up.
 */
export function nestShielded(world: World, content: Content, target: Entity): boolean {
  const team = world.teams[target.team];
  if (!team || team.controller !== "wave-director" || !isCore(content, team, target)) return false;
  return farmsStanding(world, content, team.id) > 0;
}

/**
 * Can't be attacked at all (WC3's invulnerable): units and towers never pick
 * it as a target, drop it if it becomes so, and orders to attack it are
 * refused. Otherwise units park on a shielded nest and snap back to it after
 * every move order. Today that's only the shielded nest.
 */
/** Why an attack order on an invulnerable target is refused (shown to the player). */
export const INVULNERABLE = "invulnerable · destroy every Botnet Farm first";

export function invulnerable(world: World, content: Content, target: Entity): boolean {
  return nestShielded(world, content, target);
}

/**
 * The nest fell: the botnet goes down with it. Every building and creep it
 * still has collapses, and nothing more comes out.
 */
export function collapseHorde(world: World, team: TeamId): void {
  for (const e of world.entities) {
    if (e.team !== team || e.hp <= 0) continue;
    e.hp = 0;
    world.events.push({ type: "death", id: e.id, x: e.x, y: e.y, team: e.team, kind: e.kind, defId: e.defId });
  }
  world.waves.pending = [];
  world.events.push({ type: "collapsed", team });
}

/**
 * A farm fell: the hornet's nest. A retaliation wave, a share of the current
 * wave's size, comes out of the nest as one pack and marches on the spot the
 * attacker hit it from. (The botnet traced the attack; it still doesn't know
 * where your base is.)
 */
export function retaliate(ctx: TickContext, attacker: Entity): void {
  const { world, content } = ctx;
  const horde = world.teams.find((t) => t.controller === "wave-director");
  if (!horde || !hostile(world, attacker.team, horde.id)) return;
  const wave = Math.max(1, world.waves.nextIndex);
  const plan = planWave(world, content, wave);
  const count = Math.max(1, Math.floor((plan.units.length * content.waves.fortress.farms.retaliationPermille) / 1000));
  const units: string[] = [];
  for (let i = 0; i < count; i += 1) units.push(plan.units[i % plan.units.length]!);
  const packId = world.waves.nextPackId++;
  for (const unit of units) world.waves.pending.push({ tick: world.tick, unit, packId, wave });
  world.waves.pending.sort((a, b) => a.tick - b.tick);
  world.waves.packs[packId] = { x: attacker.x, y: attacker.y };
  const farmsLeft = farmsStanding(world, content, horde.id);
  world.events.push({ type: "retaliation", team: attacker.team, x: attacker.x, y: attacker.y, units: units.length, farmsLeft });
}
