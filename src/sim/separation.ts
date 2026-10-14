// Units take up room. After everyone has moved, overlapping bodies push each
// other apart a little, so a crowd spreads into a blob you can count instead
// of stacking on one spot. It's soft (part of the overlap per tick, capped),
// so bodies settle over a few ticks rather than snapping, and nobody is ever
// pushed into a wall.
//
// Deterministic: units are visited in id order, pairs once each, with only
// + - * / and Math.sqrt. Two bodies on exactly the same spot split along a
// direction picked from their ids.

import type { TickContext } from "./context";
import { bodyFits } from "./nav";
import { holding } from "./traits";
import type { Unit } from "./types";

/** Bucket size for the neighbour search; bigger than the widest pair of bodies. */
const CELL = 48;
const STRIDE = 1 << 16;
/** Share of an overlap resolved each tick. */
const PUSH = 0.5;
/** Most a unit is shoved in one tick, in px: under a walking stride. */
const MAX_SHOVE = 2.5;

/** Push overlapping units apart. Runs once a tick, after movement. */
export function tickSeparation(ctx: TickContext): void {
  const { world } = ctx;
  const units: Unit[] = [];
  for (const e of world.entities) if (e.kind === "unit" && e.hp > 0) units.push(e);
  if (units.length < 2) return;

  const cells = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cy * STRIDE + cx;
  units.forEach((u, i) => {
    const k = key(Math.floor(u.x / CELL), Math.floor(u.y / CELL));
    const cell = cells.get(k);
    if (cell) cell.push(i);
    else cells.set(k, [i]);
  });

  const pushX = new Float64Array(units.length);
  const pushY = new Float64Array(units.length);
  units.forEach((a, i) => {
    const cx = Math.floor(a.x / CELL);
    const cy = Math.floor(a.y / CELL);
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        const cell = cells.get(key(cx + ox, cy + oy));
        if (!cell) continue;
        for (const j of cell) {
          if (j <= i) continue;
          const b = units[j]!;
          const min = a.radius + b.radius;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          let d = Math.sqrt(d2);
          if (d < 0.001) {
            // Same spot: split along a direction from the ids, never (0, 0).
            dx = ((a.id * 7 + b.id * 13) % 9) - 4;
            dy = ((a.id * 11 + b.id * 5) % 9) - 4;
            if (dx === 0 && dy === 0) dx = 1;
            d = Math.sqrt(dx * dx + dy * dy);
          }
          const nx = dx / d;
          const ny = dy / d;
          const overlap = (min - Math.min(d, min)) * PUSH;
          // A decoy holds its ground; otherwise the bigger body moves less.
          const fixedA = a.mode === "decoy";
          const fixedB = b.mode === "decoy";
          if (fixedA && fixedB) continue;
          const shareA = fixedA ? 0 : fixedB ? 1 : b.radius / min;
          const shareB = 1 - shareA;
          pushX[i] = pushX[i]! - nx * overlap * shareA;
          pushY[i] = pushY[i]! - ny * overlap * shareA;
          pushX[j] = pushX[j]! + nx * overlap * shareB;
          pushY[j] = pushY[j]! + ny * overlap * shareB;
        }
      }
    }
  });

  units.forEach((u, i) => {
    let px = pushX[i]!;
    let py = pushY[i]!;
    if (px === 0 && py === 0) return;
    const len = Math.sqrt(px * px + py * py);
    if (len > MAX_SHOVE) {
      px = (px / len) * MAX_SHOVE;
      py = (py / len) * MAX_SHOVE;
    }
    const nx = u.x + px;
    const ny = u.y + py;
    if (!bodyFits(world.terrain, nx, ny, u.radius)) return;
    u.x = nx;
    u.y = ny;
    // A guard shoved off its post takes the new spot as home, so a crowd at a
    // rally point settles instead of every unit elbowing back to the middle.
    // One still walking somewhere keeps its destination.
    if (u.mode === "guard" && holding(u)) {
      u.homeX += px;
      u.homeY += py;
    }
  });
}
