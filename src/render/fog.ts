// Fog of war for the local player. Render-side only: it decides what the
// player gets to *see*, never what the simulation does. (Creeps already only
// act on what they can see; that rule lives in the sim.)
//
// Three states per tile:
// - unexplored: black. Terrain and everything on it is hidden.
// - explored:   dimmed. Terrain and last-seen enemy buildings show; creeps don't.
// - visible:    clear. Within sight of something you own right now.
//
// The fog is a one-pixel-per-tile canvas drawn as a scaled sprite, so linear
// filtering gives soft edges for free.

import { Sprite, Texture } from "pixi.js";
import { TILE, type Content, type TeamId, type World } from "../sim";

const UPDATE_MS = 100;
const EXPLORED_ALPHA = 150;
const DEFAULT_BUILDING_SIGHT = 300;

export class Fog {
  visible = new Uint8Array(0);
  explored = new Uint8Array(0);
  private cols = 0;
  private rows = 0;
  private canvas = document.createElement("canvas");
  private context = this.canvas.getContext("2d")!;
  private image: ImageData | null = null;
  private texture: Texture | null = null;
  private sinceUpdate = Infinity;
  /** Bumped whenever visibility changes, so other views know to refresh. */
  version = 0;
  readonly worldSprite = new Sprite();
  readonly minimapSprite = new Sprite();

  constructor(private readonly enabled: boolean) {}

  reset(world: World): void {
    const { cols, rows } = world.terrain;
    this.cols = cols;
    this.rows = rows;
    this.visible = new Uint8Array(cols * rows);
    this.explored = new Uint8Array(cols * rows);
    this.canvas.width = cols;
    this.canvas.height = rows;
    this.image = this.context.createImageData(cols, rows);
    this.texture?.destroy(true);
    this.texture = Texture.from(this.canvas);
    this.worldSprite.texture = this.texture;
    this.minimapSprite.texture = this.texture;
    this.worldSprite.width = cols * TILE;
    this.worldSprite.height = rows * TILE;
    this.worldSprite.visible = this.enabled;
    this.minimapSprite.visible = this.enabled;
    this.sinceUpdate = Infinity;
  }

  setMinimapScale(scale: number): void {
    this.minimapSprite.width = this.cols * TILE * scale;
    this.minimapSprite.height = this.rows * TILE * scale;
  }

  update(world: World, content: Content, team: TeamId, deltaMs: number): void {
    if (!this.image) return;
    this.sinceUpdate += deltaMs;
    if (this.sinceUpdate < UPDATE_MS) return;
    this.sinceUpdate = 0;

    this.visible.fill(0);
    for (const entity of world.entities) {
      if (entity.team !== team || entity.hp <= 0) continue;
      const sight =
        entity.kind === "unit"
          ? (content.units[entity.defId]!.sight ?? content.units[entity.defId]!.aggro)
          : (content.buildings[entity.defId]!.sight ?? DEFAULT_BUILDING_SIGHT);
      this.reveal(entity.x, entity.y, sight + entity.radius);
    }

    const data = this.image.data;
    for (let i = 0; i < this.visible.length; i += 1) {
      data[i * 4 + 3] = this.visible[i] ? 0 : this.explored[i] ? EXPLORED_ALPHA : 255;
    }
    this.context.putImageData(this.image, 0, 0);
    this.version += 1;
    this.texture?.source.update();
  }

  /** Per-tile state for other views: 2 visible, 1 explored, 0 unexplored. */
  stateAt(index: number): 0 | 1 | 2 {
    if (!this.enabled) return 2;
    return this.visible[index] ? 2 : this.explored[index] ? 1 : 0;
  }

  isVisible(x: number, y: number): boolean {
    return !this.enabled || this.visible[this.index(x, y)] === 1;
  }

  isExplored(x: number, y: number): boolean {
    return !this.enabled || this.explored[this.index(x, y)] === 1;
  }

  private index(x: number, y: number): number {
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor(x / TILE)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor(y / TILE)));
    return row * this.cols + col;
  }

  private reveal(x: number, y: number, radius: number): void {
    const r = radius / TILE;
    const cx = x / TILE;
    const cy = y / TILE;
    const minRow = Math.max(0, Math.floor(cy - r));
    const maxRow = Math.min(this.rows - 1, Math.floor(cy + r));
    const minCol = Math.max(0, Math.floor(cx - r));
    const maxCol = Math.min(this.cols - 1, Math.floor(cx + r));
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        const dx = col + 0.5 - cx;
        const dy = row + 0.5 - cy;
        if (dx * dx + dy * dy > r * r) continue;
        const i = row * this.cols + col;
        this.visible[i] = 1;
        this.explored[i] = 1;
      }
    }
  }
}
