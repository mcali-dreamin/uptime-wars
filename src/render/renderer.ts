// Renderer. Reads the world, never writes it. Interpolates between the last
// two simulation ticks so 20 Hz logic still draws smoothly at display rate.
//
// The map is bigger than the screen: a camera pans and zooms over it, a
// minimap shows the whole thing, and anything outside the view is skipped.

import { Application, Container, Graphics, Text } from "pixi.js";
import {
  networkProviders,
  isCore,
  TILE,
  type Content,
  type Terrain,
  type Unit,
  type World,
} from "../sim";
import { Camera } from "./camera";
import type { Point } from "../sim";
import { Fog } from "./fog";
import { drawTerrainBase, drawTerrainDetail, drawWells } from "./terrain-art";

export const TEAM_COLORS = [0x4ade80, 0xf87171] as const;
export const SHOT_TTL_MS = 120;
export const PING_MS = 600;
const MINIMAP_WIDTH = 240;
const MINIMAP_MARGIN = 12;

export interface Shot {
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

/** Everything a world view needs to draw one frame. Render-only. */
export interface Frame {
  world: World;
  content: Content;
  alpha: number;
  deltaMs: number;
  ghost: Ghost | null;
  selectedId: number | null;
  width: number;
  height: number;
  camera: Camera;
  fog: Fog;
  shots: readonly Readonly<Shot>[];
  pings: readonly Readonly<{ x: number; y: number; age: number }>[];
  /** Interpolated position of an entity this frame. */
  position(entity: World["entities"][number]): Point;
  /** Whether the local player may see this entity right now. */
  shows(entity: World["entities"][number], x: number, y: number): boolean;
}

/**
 * An alternative view of the world (the Three.js one). When attached, the
 * Pixi renderer stops drawing the world itself and keeps only the minimap,
 * banner, and fog bookkeeping.
 */
export interface WorldView {
  setWorld(world: World): void;
  draw(frame: Frame): void;
  /** Canvas-local pixels to a world point, or null if nothing is there. */
  pick(x: number, y: number): Point | null;
  /** The world rectangle the view covers, for the minimap. */
  viewRect(): { left: number; right: number; top: number; bottom: number } | null;
}

export class Renderer {
  readonly app = new Application();
  private view3d: WorldView | null = null;
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
    style: { fill: 0xd6e2f0, fontFamily: "monospace", fontSize: 26, fontWeight: "bold" },
  });
  private previous = new Map<number, { x: number; y: number }>();
  private shots: Shot[] = [];
  /** Order markers: a ring that shrinks where you just sent something. */
  private pings: { x: number; y: number; age: number }[] = [];
  private bannerAge = Infinity;
  private terrain: Terrain | null = null;
  private minimapScale = 1;

  async init(host: HTMLElement, options: { transparent?: boolean } = {}): Promise<void> {
    await this.app.init({
      resizeTo: host,
      background: 0x0b0f14,
      backgroundAlpha: options.transparent ? 0 : 1,
      antialias: true,
    });
    host.appendChild(this.app.canvas);
    // resizeTo only listens for window resizes; the stage also changes size
    // when the HUD around it reflows.
    new ResizeObserver(() => this.app.resize()).observe(host);

    this.worldLayer.addChild(this.terrainLayer, this.dynamic, this.fog.worldSprite, this.overlay);
    this.minimap.addChild(this.minimapTerrain, this.fog.minimapSprite, this.minimapDynamic);
    this.banner.anchor.set(0.5, 0);
    this.app.stage.addChild(this.worldLayer, this.minimap, this.banner);
  }

  /** Hand world drawing to another view (3D). The Pixi world layer goes quiet. */
  attach(view: WorldView): void {
    this.view3d = view;
    this.worldLayer.visible = false;
  }

  /** Call when a new match starts: redraws terrain and centers on the core. */
  setWorld(world: World): void {
    const { terrain } = world;
    this.terrain = terrain;
    this.previous.clear();
    this.shots = [];
    this.pings = [];
    this.camera.setBounds(terrain.cols * TILE, terrain.rows * TILE);
    if (!this.view3d) this.drawTerrain(this.terrainLayer, terrain, TILE);
    this.view3d?.setWorld(world);
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
      if (event.type === "founded") this.showBanner("Core online");
      if (event.type === "wave") {
        const boss = event.boss ? " · BOSS" : "";
        this.showBanner(`Wave ${event.wave} · ${event.name}${boss}`);
      }
    }
  }

  /** Mark where an order was given. Render-only. */
  ping(x: number, y: number): void {
    this.pings.push({ x, y, age: 0 });
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

    if (this.view3d) {
      this.view3d.draw({
        world,
        content,
        alpha,
        deltaMs,
        ghost,
        selectedId,
        width,
        height,
        camera: this.camera,
        fog: this.fog,
        shots: this.shots,
        pings: this.pings,
        position: (entity) => {
          const prev = entity.kind === "unit" ? this.previous.get(entity.id) : undefined;
          return prev ? { x: prev.x + (entity.x - prev.x) * alpha, y: prev.y + (entity.y - prev.y) * alpha } : entity;
        },
        shows: (entity, x, y) => this.shows(world, entity, x, y),
      });
      for (const shot of this.shots) shot.age += deltaMs;
      this.shots = this.shots.filter((shot) => shot.age < SHOT_TTL_MS);
      for (const ping of this.pings) ping.age += deltaMs;
      this.pings = this.pings.filter((ping) => ping.age < PING_MS);
      this.drawMinimap(world, width, height);
      this.drawBanner(world, width, deltaMs);
      return;
    }

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
    for (const ping of this.pings) {
      const t = ping.age / PING_MS;
      this.overlay.circle(ping.x, ping.y, 28 * (1 - t) + 6).stroke({ width: 2.5, color: 0xfacc15, alpha: 1 - t });
      ping.age += deltaMs;
    }
    this.pings = this.pings.filter((ping) => ping.age < PING_MS);
    if (ghost) {
      // Your network: every finished core, node, or PoP and its build radius.
      for (const provider of networkProviders(world, content, 0)) {
        const reach = content.buildings[provider.defId]!.buildRadius! * TILE;
        this.overlay.circle(provider.x, provider.y, reach).stroke({ width: 2, color: 0x4ade80, alpha: 0.25 });
      }
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
    this.drawBanner(world, width, deltaMs);
  }

  private drawBanner(world: World, width: number, deltaMs: number): void {
    this.banner.position.set(width / 2, 24);
    this.bannerAge += deltaMs;
    this.banner.alpha = world.outcome ? 1 : Math.max(0, 1 - this.bannerAge / 2500);
  }

  /** Canvas-relative pointer to world pixels. */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return this.view3d?.pick(x, y) ?? this.camera.screenToWorld(x, y);
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
    const view = this.view3d?.viewRect() ?? this.camera.view(0);
    g.rect(view.left * s, view.top * s, (view.right - view.left) * s, (view.bottom - view.top) * s).stroke({
      width: 1,
      color: 0xd6e2f0,
      alpha: 0.8,
    });
  }

  /** The whole map at `cell` pixels per tile; details only at full size. */
  private drawTerrain(g: Graphics, terrain: Terrain, cell: number): void {
    const full = g === this.terrainLayer;
    if (full) g.clear();
    drawTerrainBase(g, terrain, cell);
    if (full) drawTerrainDetail(g, terrain, cell);
    drawWells(g, terrain, cell);
    if (full) g.rect(0, 0, terrain.cols * cell, terrain.rows * cell).stroke({ width: 2, color: 0x243142 });
  }

  /**
   * Outline the selected building and show where its units gather: its own
   * rally point, else the team's global one (drawn dashed-looking, fainter).
   */
  private drawSelection(world: World, content: Content, selectedId: number | null): void {
    if (selectedId === null) return;
    const building = world.entities.find((e) => e.id === selectedId);
    if (!building) return;
    const g = this.overlay;
    const color = 0xfacc15;
    if (building.kind === "unit") {
      g.circle(building.x, building.y, building.radius + 9).stroke({ width: 2, color, alpha: 0.9 });
      return;
    }
    const size = building.footprint * TILE + 6;
    g.rect(building.x - size / 2, building.y - size / 2, size, size).stroke({ width: 2, color, alpha: 0.9 });

    const team = world.teams[building.team];
    const core = isCore(content, team, building);
    if (!core && !content.buildings[building.defId]!.spawn) return;
    const own = core ? team.rally : building.rally;
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
}
