// How buildings and units look in the 2D view.

import type { Graphics } from "pixi.js";
import { TILE, type Unit } from "../../sim";

/** The deploy agent: a diamond with a pulse, plus a line to where it's headed. */
export function drawBuilder(g: Graphics, unit: Unit, x: number, y: number, color: number): void {
  const r = unit.radius + 3;
  if (unit.moveTo) {
    g.moveTo(x, y).lineTo(unit.moveTo.x, unit.moveTo.y).stroke({ width: 1.5, color, alpha: 0.35 });
    if (unit.foundAt) {
      const size = 2 * TILE;
      g.rect(unit.foundAt.col * TILE, unit.foundAt.row * TILE, size, size).stroke({ width: 2, color, alpha: 0.7 });
    } else {
      g.circle(unit.moveTo.x, unit.moveTo.y, 8).stroke({ width: 2, color, alpha: 0.6 });
    }
  }
  const pulse = 1 + 0.25 * Math.sin(performance.now() / 200);
  g.circle(x, y, r * 1.6 * pulse).stroke({ width: 1.5, color, alpha: 0.35 });
  g.moveTo(x, y - r).lineTo(x + r, y).lineTo(x, y + r).lineTo(x - r, y).closePath().fill({ color, alpha: 0.9 });
  if (unit.hp < unit.maxHp) drawHealth(g, x - r, y - r - 7, r * 2, unit.hp / unit.maxHp);
}

export function drawHealth(g: Graphics, x: number, y: number, width: number, ratio: number): void {
  g.rect(x, y, width, 3).fill({ color: 0x243142 });
  g.rect(x, y, width * Math.max(0, ratio), 3).fill({ color: ratio > 0.5 ? 0x4ade80 : ratio > 0.25 ? 0xfacc15 : 0xf87171 });
}

export function drawGlyph(g: Graphics, defId: string, x: number, y: number, size: number, color: number, alpha: number): void {
  const s = size * 0.3;
  switch (defId) {
    case "core":
      g.rect(x - s, y - s, s * 2, s * 2).stroke({ width: 3, color, alpha });
      g.circle(x, y, s * 0.5).fill({ color, alpha });
      break;
    case "c2-server":
      g.moveTo(x, y - s).lineTo(x + s * 0.6, y + s).lineTo(x - s * 0.6, y + s).closePath().fill({ color, alpha });
      g.circle(x, y + s * 0.2, s * 0.25).fill({ color: 0xffffff, alpha });
      break;
    case "campus":
    case "metro":
      g.moveTo(x, y + s).lineTo(x, y - s).stroke({ width: 2.5, color, alpha });
      g.circle(x, y - s, s * 0.3).fill({ color, alpha });
      g.circle(x, y - s, s * 0.7).stroke({ width: 1.5, color, alpha });
      break;
    case "malware-nest":
      g.circle(x, y, s).stroke({ width: 3, color, alpha });
      g.circle(x, y, s * 0.4).fill({ color, alpha });
      break;
    case "server-rack":
      for (let i = -1; i <= 1; i += 1) g.rect(x - s, y + i * s * 0.7 - 2, s * 2, 4).fill({ color, alpha });
      break;
    case "gpu-cluster":
      for (const dx of [-1, 1]) for (const dy of [-1, 1]) g.rect(x + dx * s * 0.5 - 3, y + dy * s * 0.5 - 3, 6, 6).fill({ color, alpha });
      break;
    case "firewall":
      g.moveTo(x - s, y + s).lineTo(x, y - s).lineTo(x + s, y + s).closePath().stroke({ width: 2, color, alpha });
      break;
    case "mesh-node":
      g.circle(x, y, s * 0.35).fill({ color, alpha });
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        g.moveTo(x, y).lineTo(x + dx * s, y + dy * s).stroke({ width: 1.5, color, alpha });
        g.circle(x + dx * s, y + dy * s, 2).fill({ color, alpha });
      }
      break;
    case "edge-pop":
      g.moveTo(x, y - s).lineTo(x + s, y).lineTo(x, y + s).lineTo(x - s, y).closePath().stroke({ width: 2, color, alpha });
      g.circle(x, y, s * 0.4).stroke({ width: 1.5, color, alpha });
      break;
    case "hyperscale-rack":
      g.rect(x - s, y - s, s * 2, s * 2).stroke({ width: 2, color, alpha });
      for (let i = -1; i <= 1; i += 1) g.rect(x - s * 0.7, y + i * s * 0.6 - 1.5, s * 1.4, 3).fill({ color, alpha });
      break;
    case "cdn-edge":
      g.circle(x, y, s * 0.35).fill({ color, alpha });
      g.circle(x, y, s * 0.9).stroke({ width: 1.5, color, alpha });
      g.moveTo(x - s, y).lineTo(x + s, y).moveTo(x, y - s).lineTo(x, y + s).stroke({ width: 1.5, color, alpha });
      break;
    case "power-plant":
      g.moveTo(x + s * 0.2, y - s).lineTo(x - s * 0.5, y + s * 0.1).lineTo(x, y + s * 0.1).lineTo(x - s * 0.2, y + s).lineTo(x + s * 0.5, y - s * 0.1).lineTo(x, y - s * 0.1).closePath().fill({ color, alpha });
      break;
    case "web-app":
      g.rect(x - s, y - s * 0.75, s * 2, s * 1.5).stroke({ width: 2, color, alpha });
      g.moveTo(x - s, y - s * 0.35).lineTo(x + s, y - s * 0.35).stroke({ width: 1.5, color, alpha });
      g.circle(x - s * 0.7, y - s * 0.55, 1.5).fill({ color, alpha });
      break;
    case "solar-array":
      g.circle(x, y, s * 0.8).stroke({ width: 2, color, alpha });
      break;
    default:
      g.circle(x, y, s).stroke({ width: 2, color, alpha });
  }
}

