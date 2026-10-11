// The minimap: the whole map small, fog over it, what you can see, and the
// camera's rectangle. Clicking it is handled by the renderer shell.

import { Container, Graphics } from "pixi.js";
import { TILE, type Terrain, type World } from "../sim";
import type { Fog } from "./fog";
import { teamColor } from "./palette";
import { drawTerrainBase, drawWells } from "./pixi/terrain-art";

const WIDTH = 240;
const MARGIN = 12;

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
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
    g.rect(0, 0, terrain.cols * cell, terrain.rows * cell).fill({ color: 0x0e141b }).stroke({ width: 1, color: 0x243142 });
    drawTerrainBase(g, terrain, cell);
    drawWells(g, terrain, cell);
    this.fog.setMinimapScale(this.scale);
  }

  draw(world: World, width: number, height: number, view: Rect, shows: (entity: World["entities"][number]) => boolean): void {
    if (!this.terrain) return;
    const s = this.scale;
    this.root.position.set(width - WIDTH - MARGIN, height - this.terrain.rows * TILE * s - MARGIN);
    const g = this.dynamic;
    g.clear();
    for (const entity of world.entities) {
      if (!shows(entity)) continue;
      const color = teamColor(world, entity.team);
      if (entity.kind === "building") {
        const size = Math.max(3, entity.footprint * TILE * s);
        g.rect(entity.x * s - size / 2, entity.y * s - size / 2, size, size).fill({ color });
      } else {
        g.rect(entity.x * s - 1, entity.y * s - 1, 2, 2).fill({ color });
      }
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
