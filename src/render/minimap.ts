// The minimap: the whole map small, fog over it, what you can see, and the
// camera's rectangle. Clicking it is handled by the renderer shell.

import { Container, Graphics } from "pixi.js";
import { TILE, type Terrain, type World } from "../sim";
import type { Fog } from "./fog";
import { CAMP_TIER_COLORS, NEUTRAL_COLOR, teamColor } from "./palette";
import { drawTerrainBase } from "./pixi/terrain-art";

/** The colour of items lying on the ground (see groundPickup in three/models). */
const PICKUP = 0x22d3ee;

const WIDTH = 240;
const MARGIN = 12;

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A camp's center (world px) and tier, for its minimap marker. */
export interface CampMarker {
  x: number;
  y: number;
  tier: string;
}

export class Minimap {
  readonly root = new Container();
  private readonly terrainLayer = new Graphics();
  private readonly dynamic = new Graphics();
  private terrain: Terrain | null = null;
  private scale = 1;

  constructor(private readonly fog: Fog) {
    this.root.addChild(this.terrainLayer, fog.minimapSprite, this.dynamic);
  }

  setWorld(world: World): void {
    const { terrain } = world;
    this.terrain = terrain;
    this.scale = WIDTH / (terrain.cols * TILE);
    const cell = TILE * this.scale;
    const g = this.terrainLayer;
    g.clear();
    g.rect(0, 0, terrain.cols * cell, terrain.rows * cell).fill({ color: 0x05080d }).stroke({ width: 1, color: 0x2a7f9c });
    drawTerrainBase(g, terrain, cell);
    this.fog.setMinimapScale(this.scale);
  }

  /** Alerts to flash on the minimap: world point and age in seconds. */
  flashes: { x: number; y: number; age: number; color: number }[] = [];

  /**
   * `camps`: each camp's center and tier (by camp id). A camp still standing
   * shows as one diamond in its tier's colour, not as a dot per guard.
   */
  draw(world: World, width: number, height: number, view: Rect, shows: (entity: World["entities"][number]) => boolean, camps: readonly CampMarker[] = []): void {
    if (!this.terrain) return;
    const s = this.scale;
    this.root.position.set(width - WIDTH - MARGIN, height - this.terrain.rows * TILE * s - MARGIN);
    const g = this.dynamic;
    g.clear();
    const standing = new Set<number>();
    for (const entity of world.entities) {
      if (entity.kind === "unit" && entity.campId !== undefined && entity.hp > 0) {
        standing.add(entity.campId);
        continue;
      }
      // A site (the only building with a camp) shows wherever the map is explored: a square in its owner's colour.
      if (entity.kind === "building" && entity.campId !== undefined) {
        if (!this.fog.isExplored(entity.x, entity.y)) continue;
        const half = 4;
        g.rect(entity.x * s - half, entity.y * s - half, half * 2, half * 2).fill({ color: teamColor(world, entity.team) }).stroke({ width: 1, color: 0x0b0f17 });
        continue;
      }
      if (!shows(entity)) continue;
      const color = teamColor(world, entity.team);
      if (entity.kind === "building") {
        const size = Math.max(3, entity.footprint * TILE * s);
        g.rect(entity.x * s - size / 2, entity.y * s - size / 2, size, size).fill({ color });
      } else if (entity.mode === "hero") {
        // Heroes: a gold-ringed dot you can find at a glance.
        g.circle(entity.x * s, entity.y * s, 3.5).fill({ color }).stroke({ width: 1.5, color: 0xfacc15 });
      } else {
        g.rect(entity.x * s - 1, entity.y * s - 1, 2, 2).fill({ color });
      }
    }
    for (const id of standing) {
      const camp = camps[id];
      if (!camp || !this.fog.isExplored(camp.x, camp.y)) continue;
      const x = camp.x * s;
      const y = camp.y * s;
      const r = 3.5;
      g.poly([x, y - r, x + r, y, x, y + r, x - r, y]).fill({ color: CAMP_TIER_COLORS[camp.tier] ?? NEUTRAL_COLOR }).stroke({ width: 1, color: 0x0b0f17 });
    }
    // Items lying on the ground: a bright dot you can send the hero to collect.
    for (const drop of world.groundItems) {
      if (!this.fog.isVisible(drop.x, drop.y)) continue;
      g.circle(drop.x * s, drop.y * s, 3).fill({ color: PICKUP }).stroke({ width: 1, color: 0xffffff, alpha: 0.7 });
    }
    // Alert flashes: an expanding ring that pulses for a few seconds.
    for (const f of this.flashes) {
      if (f.age > 4) continue;
      const pulse = (f.age % 1) / 1;
      g.circle(f.x * s, f.y * s, 4 + pulse * 10).stroke({ width: 2, color: f.color, alpha: 1 - pulse });
    }
    g.rect(view.left * s, view.top * s, (view.right - view.left) * s, (view.bottom - view.top) * s).stroke({ width: 1, color: 0xd6e2f0, alpha: 0.8 });
  }

  /** World point under a canvas-local point, if it's on the minimap. */
  hit(x: number, y: number): { x: number; y: number } | null {
    if (!this.terrain) return null;
    const lx = x - this.root.x;
    const ly = y - this.root.y;
    const w = this.terrain.cols * TILE * this.scale;
    const h = this.terrain.rows * TILE * this.scale;
    if (lx < 0 || ly < 0 || lx > w || ly > h) return null;
    return { x: lx / this.scale, y: ly / this.scale };
  }
}
