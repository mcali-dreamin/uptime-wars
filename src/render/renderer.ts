// Renderer. Reads the world, never writes it. Interpolates between the last
// two simulation ticks so 20 Hz logic still draws smoothly at display rate.
//
// The map is bigger than the screen: a camera pans and zooms over it, a
// minimap shows the whole thing, and anything outside the view is skipped.

import { Application, Container, Graphics, Text } from "pixi.js";
import {
  BUILD_RADIUS_TILES,
  TILE,
  TILE_BLOCKED,
  TILE_SLOW,
  type Content,
  type Terrain,
  type Unit,
  type World,
} from "../sim";
import { Camera } from "./camera";
import { Fog } from "./fog";

const TEAM_COLORS = [0x4ade80, 0xf87171] as const;
const SHOT_TTL_MS = 120;
const MINIMAP_WIDTH = 240;
const MINIMAP_MARGIN = 12;
// Walls must read as walls: bright, outlined, and far from the floor color.
const TERRAIN_COLORS: Record<number, number> = {
  [TILE_BLOCKED]: 0x3b4a5c,
  [TILE_SLOW]: 0x123845,
};
const WALL_EDGE = 0x7d8fa3;

interface Shot {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  team: 0 | 1;
  age: number;
}

export interface Ghost {
  col: number;
  row: number;
  footprint: number;
  valid: boolean;
  /** Attack range to preview, in pixels, if the building shoots. */
  range: number;
}

export class Renderer {
  readonly app = new Application();
  readonly camera = new Camera();
  private readonly worldLayer = new Container();
  /** `?reveal` in the URL turns fog off, for debugging. */
  readonly fog = new Fog(!new URLSearchParams(location.search).has("reveal"));
  private readonly terrainLayer = new Graphics();
  private readonly dynamic = new Graphics();
  private readonly overlay = new Graphics();
  private readonly minimap = new Container();
  private readonly minimapTerrain = new Graphics();
  private readonly minimapDynamic = new Graphics();
  private readonly banner = new Text({
    text: "",
    style: { fill: 0xd6e2f0, fontFamily: "monospace", fontSize: 40, fontWeight: "bold" },
  });
  private previous = new Map<number, { x: number; y: number }>();
  private shots: Shot[] = [];
  private bannerAge = Infinity;
  private terrain: Terrain | null = null;
  private minimapScale = 1;

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: host, background: 0x0b0f14, antialias: true });
    host.appendChild(this.app.canvas);
    // resizeTo only listens for window resizes; the stage also changes size
    // when the HUD around it reflows.
    new ResizeObserver(() => this.app.resize()).observe(host);

    this.worldLayer.addChild(this.terrainLayer, this.dynamic, this.fog.worldSprite, this.overlay);
    this.minimap.addChild(this.minimapTerrain, this.fog.minimapSprite, this.minimapDynamic);
    this.banner.anchor.set(0.5, 0);
    this.app.stage.addChild(this.worldLayer, this.minimap, this.banner);
  }

  /** Call when a new match starts: redraws terrain and centers on the core. */
  setWorld(world: World): void {
    const { terrain } = world;
    this.terrain = terrain;
    this.previous.clear();
    this.shots = [];
    this.camera.setBounds(terrain.cols * TILE, terrain.rows * TILE);
    this.drawTerrain(this.terrainLayer, terrain, TILE);
    this.minimapScale = MINIMAP_WIDTH / (terrain.cols * TILE);
    this.minimapTerrain.clear();
    this.minimapTerrain
      .rect(0, 0, terrain.cols * TILE * this.minimapScale, terrain.rows * TILE * this.minimapScale)
      .fill({ color: 0x0e141b })
      .stroke({ width: 1, color: 0x243142 });
    this.drawTerrain(this.minimapTerrain, terrain, TILE * this.minimapScale);
    this.fog.reset(world);
    this.fog.setMinimapScale(this.minimapScale);
    const home = this.home(world);
    if (home) this.camera.centerOn(home.x, home.y);
  }

  /** Your core, or your builder before the core is founded. */
  home(world: World) {
    const team = world.teams[0];
    return world.entities.find((entity) => entity.id === (team.coreId !== -1 ? team.coreId : team.builderId));
  }

  /** Whether the local player may see this entity right now. */
  private shows(world: World, entity: World["entities"][number], x: number, y: number): boolean {
    if (world.teams[entity.team].controller === "human") return true;
    return entity.kind === "building" ? this.fog.isExplored(x, y) : this.fog.isVisible(x, y);
  }

  /** Call right before stepping so interpolation has the pre-step positions. */
  capturePrevious(world: World): void {
    this.previous = new Map(world.entities.map((entity) => [entity.id, { x: entity.x, y: entity.y }]));
  }

  /** Call right after stepping to collect render-only events. */
  collectEvents(world: World): void {
    for (const event of world.events) {
      if (event.type === "shot") this.shots.push({ ...event, age: 0 });
      if (event.type === "founded") this.showBanner("Core online. Build within the ring; waves are on their way.");
      if (event.type === "wave") {
        const boss = event.boss ? " · BOSS" : "";
        this.showBanner(`Wave ${event.wave}: ${event.name} · ${event.units} creeps in ${event.packs} packs${boss}`);
      }
    }
  }

  showBanner(text: string): void {
    this.banner.text = text;
    this.bannerAge = 0;
  }

  draw(
    world: World,
    content: Content,
    alpha: number,
    deltaMs: number,
    ghost: Ghost | null,
    selectedId: number | null = null,
  ): void {
    const { width, height } = this.app.screen;
    this.camera.setViewport(width, height);
    this.camera.update(deltaMs);
    this.worldLayer.scale.set(this.camera.zoom);
    this.worldLayer.position.set(width / 2 - this.camera.x * this.camera.zoom, height / 2 - this.camera.y * this.camera.zoom);
    const view = this.camera.view(64);
    this.fog.update(world, content, 0, deltaMs);

    const g = this.dynamic;
    g.clear();
    for (const entity of world.entities) {
      const prev = entity.kind === "unit" ? this.previous.get(entity.id) : undefined;
      const x = prev ? prev.x + (entity.x - prev.x) * alpha : entity.x;
      const y = prev ? prev.y + (entity.y - prev.y) * alpha : entity.y;
      if (x < view.left || x > view.right || y < view.top || y > view.bottom) continue;
      if (!this.shows(world, entity, x, y)) continue;

      const color = TEAM_COLORS[entity.team];
      if (entity.kind === "building") {
        const size = entity.footprint * TILE - 4;
        const left = x - size / 2;
        const top = y - size / 2;
        const building = entity.buildRemaining > 0;
        g.rect(left, top, size, size).fill({ color: 0x121922 }).stroke({ width: 2, color, alpha: building ? 0.4 : 1 });
        this.drawGlyph(g, entity.defId, x, y, size, color, building ? 0.35 : 0.9);
        this.drawHealth(g, left, top - 6, size, entity.hp / entity.maxHp);
        const attack = content.buildings[entity.defId]?.attack;
        if (attack) g.circle(x, y, attack.range + entity.radius).stroke({ width: 1, color, alpha: 0.08 });
        continue;
      }
      if (entity.mode === "builder") {
        this.drawBuilder(g, entity, x, y);
        continue;
      }
      g.circle(x, y, entity.radius).fill({ color, alpha: 0.85 });
      if (entity.hp < entity.maxHp) {
        this.drawHealth(g, x - entity.radius, y - entity.radius - 6, entity.radius * 2, entity.hp / entity.maxHp);
      }
    }

    for (const shot of this.shots) {
      const fade = 1 - shot.age / SHOT_TTL_MS;
      shot.age += deltaMs;
      if (!this.fog.isVisible(shot.x1, shot.y1) && !this.fog.isVisible(shot.x2, shot.y2)) continue;
      g.moveTo(shot.x1, shot.y1).lineTo(shot.x2, shot.y2).stroke({ width: 1.5, color: TEAM_COLORS[shot.team], alpha: fade });
    }
    this.shots = this.shots.filter((shot) => shot.age < SHOT_TTL_MS);

    this.overlay.clear();
    this.drawSelection(world, content, selectedId);
    if (ghost) {
      const core = world.entities.find((entity) => entity.id === world.teams[0].coreId);
      if (core) this.overlay.circle(core.x, core.y, BUILD_RADIUS_TILES * TILE).stroke({ width: 2, color: 0x4ade80, alpha: 0.25 });
      const size = ghost.footprint * TILE;
      this.overlay
        .rect(ghost.col * TILE, ghost.row * TILE, size, size)
        .fill({ color: ghost.valid ? 0x4ade80 : 0xf87171, alpha: 0.3 });
      if (ghost.range > 0) {
        this.overlay
          .circle(ghost.col * TILE + size / 2, ghost.row * TILE + size / 2, ghost.range + size / 2)
          .stroke({ width: 1.5, color: 0xfacc15, alpha: 0.6 });
      }
    }

    this.drawMinimap(world, width, height);

    this.banner.position.set(width / 2, 24);
    this.bannerAge += deltaMs;
    this.banner.alpha = world.outcome ? 1 : Math.max(0, 1 - this.bannerAge / 2500);
  }

  /** Canvas-relative pointer to world pixels. */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    return this.camera.screenToWorld(clientX - rect.left, clientY - rect.top);
  }

  /** World point under the pointer if it is over the minimap, else null. */
  minimapHit(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.app.canvas.getBoundingClientRect();
    const lx = clientX - rect.left - this.minimap.x;
    const ly = clientY - rect.top - this.minimap.y;
    if (!this.terrain) return null;
    const w = this.terrain.cols * TILE * this.minimapScale;
    const h = this.terrain.rows * TILE * this.minimapScale;
    if (lx < 0 || ly < 0 || lx > w || ly > h) return null;
    return { x: lx / this.minimapScale, y: ly / this.minimapScale };
  }

  private drawMinimap(world: World, width: number, height: number): void {
    if (!this.terrain) return;
    const s = this.minimapScale;
    const h = this.terrain.rows * TILE * s;
    this.minimap.position.set(width - MINIMAP_WIDTH - MINIMAP_MARGIN, height - h - MINIMAP_MARGIN);

    const g = this.minimapDynamic;
    g.clear();
    for (const entity of world.entities) {
      if (!this.shows(world, entity, entity.x, entity.y)) continue;
      const color = TEAM_COLORS[entity.team];
      if (entity.kind === "building") {
        const size = Math.max(3, entity.footprint * TILE * s);
        g.rect(entity.x * s - size / 2, entity.y * s - size / 2, size, size).fill({ color });
      } else {
        g.rect(entity.x * s - 1, entity.y * s - 1, 2, 2).fill({ color });
      }
    }
    const view = this.camera.view(0);
    g.rect(view.left * s, view.top * s, (view.right - view.left) * s, (view.bottom - view.top) * s).stroke({
      width: 1,
      color: 0xd6e2f0,
      alpha: 0.8,
    });
  }

  /** Terrain, run-length merged per row to keep the shape count down. */
  private drawTerrain(g: Graphics, terrain: Terrain, cell: number): void {
    if (g === this.terrainLayer) {
      g.clear();
      g.rect(0, 0, terrain.cols * cell, terrain.rows * cell).fill({ color: 0x0e141b });
    }
    for (let row = 0; row < terrain.rows; row += 1) {
      let col = 0;
      while (col < terrain.cols) {
        const tile = terrain.tiles[row * terrain.cols + col]!;
        let end = col + 1;
        while (end < terrain.cols && terrain.tiles[row * terrain.cols + end] === tile) end += 1;
        const color = TERRAIN_COLORS[tile];
        if (color !== undefined) g.rect(col * cell, row * cell, (end - col) * cell, cell).fill({ color });
        col = end;
      }
    }
    if (g === this.terrainLayer) this.drawTerrainDetail(g, terrain, cell);
    for (const node of terrain.resources) {
      const cx = (node.col + 0.5) * cell;
      const cy = (node.row + 0.5) * cell;
      const r = Math.max(1.5, cell * 0.35);
      g.moveTo(cx, cy - r).lineTo(cx + r, cy).lineTo(cx, cy + r).lineTo(cx - r, cy).closePath().fill({ color: 0x38bdf8 });
    }
    if (g === this.terrainLayer) {
      g.rect(0, 0, terrain.cols * cell, terrain.rows * cell).stroke({ width: 2, color: 0x243142 });
    }
  }

  /** Outline walls where they meet walkable ground; stipple swamps. */
  private drawTerrainDetail(g: Graphics, terrain: Terrain, cell: number): void {
    const at = (c: number, r: number) =>
      c < 0 || r < 0 || c >= terrain.cols || r >= terrain.rows ? TILE_BLOCKED : terrain.tiles[r * terrain.cols + c]!;
    for (let row = 0; row < terrain.rows; row += 1) {
      for (let col = 0; col < terrain.cols; col += 1) {
        const tile = at(col, row);
        const x = col * cell;
        const y = row * cell;
        if (tile === TILE_BLOCKED) {
          if (at(col, row - 1) !== TILE_BLOCKED) g.moveTo(x, y).lineTo(x + cell, y);
          if (at(col, row + 1) !== TILE_BLOCKED) g.moveTo(x, y + cell).lineTo(x + cell, y + cell);
          if (at(col - 1, row) !== TILE_BLOCKED) g.moveTo(x, y).lineTo(x, y + cell);
          if (at(col + 1, row) !== TILE_BLOCKED) g.moveTo(x + cell, y).lineTo(x + cell, y + cell);
        }
      }
    }
    g.stroke({ width: 2, color: WALL_EDGE, alpha: 0.9 });
    for (let row = 0; row < terrain.rows; row += 1) {
      for (let col = 0; col < terrain.cols; col += 1) {
        if (at(col, row) !== TILE_SLOW) continue;
        const x = col * cell;
        const y = row * cell;
        g.circle(x + cell * 0.3, y + cell * 0.35, 1.5).circle(x + cell * 0.7, y + cell * 0.7, 1.5);
      }
    }
    g.fill({ color: 0x2b6f80, alpha: 0.8 });
  }

  /**
   * Outline the selected building and show where its units gather: its own
   * rally point, else the team's global one (drawn dashed-looking, fainter).
   */
  private drawSelection(world: World, content: Content, selectedId: number | null): void {
    if (selectedId === null) return;
    const building = world.entities.find((e) => e.id === selectedId);
    if (!building || building.kind !== "building") return;
    const g = this.overlay;
    const color = 0xfacc15;
    const size = building.footprint * TILE + 6;
    g.rect(building.x - size / 2, building.y - size / 2, size, size).stroke({ width: 2, color, alpha: 0.9 });

    const team = world.teams[building.team];
    const isCore = building.id === team.coreId;
    if (!isCore && !content.buildings[building.defId]!.spawn) return;
    const own = isCore ? team.rally : building.rally;
    const rally = own ?? team.rally;
    if (!rally) return;
    const alpha = own ? 0.9 : 0.45;
    g.moveTo(building.x, building.y).lineTo(rally.x, rally.y).stroke({ width: 2, color, alpha: alpha * 0.6 });
    // A little flag.
    g.moveTo(rally.x, rally.y).lineTo(rally.x, rally.y - 26).stroke({ width: 2, color, alpha });
    g.moveTo(rally.x, rally.y - 26).lineTo(rally.x + 16, rally.y - 20).lineTo(rally.x, rally.y - 14).closePath().fill({ color, alpha });
    g.circle(rally.x, rally.y, 40).stroke({ width: 1, color, alpha: alpha * 0.4 });
  }

  /** The deploy agent: a diamond with a pulse, plus a line to where it's headed. */
  private drawBuilder(g: Graphics, unit: Unit, x: number, y: number): void {
    const color = TEAM_COLORS[unit.team];
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
    if (unit.hp < unit.maxHp) this.drawHealth(g, x - r, y - r - 7, r * 2, unit.hp / unit.maxHp);
  }

  private drawHealth(g: Graphics, x: number, y: number, width: number, ratio: number): void {
    g.rect(x, y, width, 3).fill({ color: 0x243142 });
    g.rect(x, y, width * Math.max(0, ratio), 3).fill({ color: ratio > 0.5 ? 0x4ade80 : ratio > 0.25 ? 0xfacc15 : 0xf87171 });
  }

  private drawGlyph(g: Graphics, defId: string, x: number, y: number, size: number, color: number, alpha: number): void {
    const s = size * 0.3;
    switch (defId) {
      case "core":
        g.rect(x - s, y - s, s * 2, s * 2).stroke({ width: 3, color, alpha });
        g.circle(x, y, s * 0.5).fill({ color, alpha });
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
      case "solar-array":
        g.circle(x, y, s * 0.8).stroke({ width: 2, color, alpha });
        break;
      default:
        g.circle(x, y, s).stroke({ width: 2, color, alpha });
    }
  }
}
