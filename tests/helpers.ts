import {
  TILE,
  TILE_OPEN,
  createWorld,
  footprintCenter,
  tileAt,
  type BuildCommand,
  type Content,
  type MatchSetup,
} from "../src/sim";

/**
 * Turn a map-agnostic build order into concrete placements for this seed's
 * map: each building goes on the free, buildable tile closest to a point a few
 * tiles out from the core toward the nest (where the creeps come from).
 */
export function planBuildOrder(
  content: Content,
  setup: MatchSetup,
  order: [tick: number, building: string][],
  forwardTiles = 4,
): BuildCommand[] {
  const world = createWorld(content, setup);
  const { terrain } = world;
  const core = world.entities.find((e) => e.id === world.teams[0].coreId)!;
  if (core.kind !== "building") throw new Error("core must be a building");
  const nest = world.entities.find((e) => e.id === world.teams[1].coreId)!;
  const dx = nest.x - core.x;
  const dy = nest.y - core.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const focus = { x: core.x + (dx / length) * forwardTiles * TILE, y: core.y + (dy / length) * forwardTiles * TILE };

  const taken = new Set<number>();
  for (let r = core.row; r < core.row + 2; r += 1) for (let c = core.col; c < core.col + 2; c += 1) taken.add(r * terrain.cols + c);

  const candidates: { col: number; row: number; score: number }[] = [];
  const reach = content.buildings[content.races[setup.races[0]]!.core]!.buildRadius! * TILE;
  for (let row = 0; row < terrain.rows; row += 1) {
    for (let col = 0; col < terrain.cols; col += 1) {
      if (tileAt(terrain, col, row) !== TILE_OPEN) continue;
      const center = footprintCenter(col, row, 1);
      const cx = center.x - core.x;
      const cy = center.y - core.y;
      if (cx * cx + cy * cy > reach * reach) continue;
      const fx = center.x - focus.x;
      const fy = center.y - focus.y;
      candidates.push({ col, row, score: fx * fx + fy * fy });
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.row - b.row || a.col - b.col);

  return order.map(([tick, building]) => {
    // Leave a one-tile gap between buildings so spawns always have room.
    const spot = candidates.find((c) => {
      for (let r = c.row - 1; r <= c.row + 1; r += 1) {
        for (let k = c.col - 1; k <= c.col + 1; k += 1) {
          if (taken.has(r * terrain.cols + k)) return false;
        }
      }
      return true;
    });
    if (!spot) throw new Error(`no room for ${building}`);
    taken.add(spot.row * terrain.cols + spot.col);
    return { type: "build", tick, team: 0, building, col: spot.col, row: spot.row };
  });
}
