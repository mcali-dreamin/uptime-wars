// The botnet spreads. Infectors walk out of the nest with an escort and build
// Infected Nodes on sites around the map; finished nodes become new places
// incidents come out of. Kill the infector on the way, or the node before it
// finishes, and the spread fails until the botnet sends another.
//
// Sites are a pure function of the terrain (so of the seed): spread out
// around the nest, clear of every player's start.

import type { TickContext } from "./context";
import type { Content } from "./content";
import { placeBuilding } from "./entities";
import { isOccupied } from "./placement";
import { randomInt } from "./rng";
import { FORTRESS_RADIUS, MOAT_WIDTH } from "./terrain/params";
import { TILE_OPEN, type Terrain, type TilePoint } from "./terrain/tiles";
import { TILE, footprintCenter } from "./map";
import type { Building, Entity, TeamId, World } from "./types";

/** Candidate sites for infected nodes (top-left tiles of a 2x2), spread out. */
export function infectionSites(terrain: Terrain, content: Content): TilePoint[] {
  const { cols, nest, starts } = terrain;
  const min = content.waves.spread.minFromStart;
  const clearOfNest = FORTRESS_RADIUS + MOAT_WIDTH + 6;
  const nc = { col: nest.col + 1, row: nest.row + 1 };
  const d2 = (a: TilePoint, b: TilePoint) => (a.col - b.col) * (a.col - b.col) + (a.row - b.row) * (a.row - b.row);
  const fits = (p: TilePoint) => {
    const h = terrain.heights[p.row * cols + p.col];
    for (let r = p.row; r < p.row + 2; r += 1) {
      for (let c = p.col; c < p.col + 2; c += 1) {
        const i = r * cols + c;
        if (terrain.tiles[i] !== TILE_OPEN || terrain.heights[i] !== h) return false;
      }
    }
    return true;
  };
  const candidates = terrain.roamPoints.filter(
    (p) => fits(p) && d2(p, nc) >= clearOfNest * clearOfNest && starts.every((s) => d2(p, { col: s.col + 1, row: s.row + 1 }) >= min * min),
  );
  // Greedy: each next site is the candidate furthest from the nest and every site so far.
  const sites: TilePoint[] = [];
  const anchors: TilePoint[] = [nc];
  while (sites.length < 8 && candidates.length > 0) {
    let best = 0;
    let bestGap = -1;
    candidates.forEach((p, i) => {
      const gap = Math.min(...anchors.map((a) => d2(p, a)));
      if (gap > bestGap) {
        best = i;
        bestGap = gap;
      }
    });
    const pick = candidates.splice(best, 1)[0]!;
    sites.push(pick);
    anchors.push(pick);
  }
  return sites;
}

const isNode = (content: Content, e: Entity, team: TeamId) => e.kind === "building" && e.team === team && e.defId === content.waves.spread.building && e.hp > 0;

/** Finished infected nodes: where incidents can come out of. */
export function liveNodes(world: World, content: Content, team: TeamId): Building[] {
  return world.entities.filter((e): e is Building => isNode(content, e, team) && (e as Building).buildRemaining === 0);
}

/** On an incident: maybe send infectors out to free sites. */
export function sendInfectors(ctx: TickContext, team: TeamId, wave: number): void {
  const { world, content } = ctx;
  const spread = content.waves.spread;
  if (wave < spread.fromWave || (wave - spread.fromWave) % spread.everyWaves !== 0) return;
  const nodes = world.entities.filter((e) => isNode(content, e, team)).length;
  const enRoute = world.entities.filter((e) => e.kind === "unit" && e.team === team && e.mode === "infector" && e.hp > 0) as Entity[];
  const pending = world.waves.pending.filter((p) => p.infect).length;
  let room = spread.max - nodes - enRoute.length - pending;
  const claimed = (site: TilePoint) =>
    enRoute.some((u) => u.kind === "unit" && u.foundAt?.col === site.col && u.foundAt.row === site.row) ||
    world.waves.pending.some((p) => p.infect?.col === site.col && p.infect.row === site.row);
  const free = infectionSites(world.terrain, content).filter((s) => !isOccupied(world, s.col, s.row, 2) && !claimed(s));
  for (let k = 0; k < spread.infectors && room > 0 && free.length > 0; k += 1) {
    const site = free.splice(randomInt(world, 0, free.length - 1), 1)[0]!;
    const packId = world.waves.nextPackId++;
    world.waves.pending.push({ tick: world.tick, unit: spread.unit, packId, wave, infect: site });
    for (let i = 0; i < spread.escort; i += 1) world.waves.pending.push({ tick: world.tick, unit: "bot", packId, wave });
    // The escort walks with it to the site.
    world.waves.packs[packId] = footprintCenter(site.col, site.row, 2);
    const at = footprintCenter(site.col, site.row, 2);
    world.events.push({ type: "infecting", x: at.x, y: at.y });
    room -= 1;
  }
  world.waves.pending.sort((a, b) => a.tick - b.tick);
}

/** An infector reached its site: start the node, if the ground's still free. Returns whether it did. */
export function buildNode(ctx: TickContext, team: TeamId, site: TilePoint): boolean {
  const { world, content } = ctx;
  if (isOccupied(world, site.col, site.row, 2)) return false;
  const node = placeBuilding(world, content, team, content.waves.spread.building, site.col, site.row, false);
  ctx.byId.set(node.id, node);
  world.events.push({ type: "infected", x: node.x, y: node.y });
  return true;
}

/** How close an infector must get to its site's centre to build. */
export const INFECT_REACH = TILE * 1.5;
