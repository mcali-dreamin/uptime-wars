// The 2D world view: terrain, buildings, units, shots, selection, rally
// flags, placement preview, and order pings, drawn with PixiJS over a camera
// that pans and zooms. Anything outside the camera is skipped.

import { Container, Graphics } from "pixi.js";
import { TILE, isCore, networkProviders, type Content, type World } from "../../sim";
import type { Camera } from "../camera";
import type { Fog } from "../fog";
import { PING_MS, SHOT_TTL_MS, type Frame, type WorldView } from "../frame";
import { HIGHLIGHT, INVALID, VALID, teamColor } from "../palette";
import { drawBuilder, drawGlyph, drawHealth } from "./glyphs";
import { drawTerrainBase, drawTerrainDetail, drawWells } from "./terrain-art";

/** How far outside the camera (world px) things still get drawn. */
const CULL_MARGIN = 64;

export class World2D implements WorldView {
  readonly layer = new Container();
  private readonly terrainLayer = new Graphics();
  private readonly dynamic = new Graphics();
  private readonly overlay = new Graphics();

  constructor(
    private readonly camera: Camera,
    fog: Fog,
  ) {
    this.layer.addChild(this.terrainLayer, this.dynamic, fog.worldSprite, this.overlay);
  }

  setWorld(world: World): void {
    const g = this.terrainLayer;
    const { terrain } = world;
    g.clear();
    drawTerrainBase(g, terrain, TILE);
    drawTerrainDetail(g, terrain, TILE);
    drawWells(g, terrain, TILE);
    g.rect(0, 0, terrain.cols * TILE, terrain.rows * TILE).stroke({ width: 2, color: 0x243142 });
  }

  pick(x: number, y: number) {
    return this.camera.screenToWorld(x, y);
  }

  viewRect() {
    return this.camera.view(0);
  }

  project(x: number, y: number) {
    const c = this.camera;
    const view = c.view(0);
    return { x: (x - view.left) * c.zoom, y: (y - view.top) * c.zoom };
  }

  draw(frame: Frame): void {
    const { camera } = this;
    this.layer.scale.set(camera.zoom);
    this.layer.position.set(frame.width / 2 - camera.x * camera.zoom, frame.height / 2 - camera.y * camera.zoom);
    this.drawEntities(frame);
    this.drawShots(frame);
    this.overlay.clear();
    this.drawSelection(frame.world, frame.content, frame.selectedId);
    this.drawPings(frame);
    this.drawPlacement(frame);
  }

  private drawEntities(frame: Frame): void {
    const { world, content } = frame;
    const g = this.dynamic;
    g.clear();
    const view = this.camera.view(CULL_MARGIN);
    for (const entity of world.entities) {
      const { x, y } = frame.position(entity);
      if (x < view.left || x > view.right || y < view.top || y > view.bottom) continue;
      if (!frame.shows(entity, x, y)) continue;

      const color = teamColor(world, entity.team);
      if (entity.kind === "building") {
        const size = entity.footprint * TILE - 4;
        const left = x - size / 2;
        const top = y - size / 2;
        const building = entity.buildRemaining > 0;
        g.rect(left, top, size, size).fill({ color: 0x121922 }).stroke({ width: 2, color, alpha: building ? 0.4 : 1 });
        drawGlyph(g, entity.defId, x, y, size, color, building ? 0.35 : 0.9);
        drawHealth(g, left, top - 6, size, entity.hp / entity.maxHp);
        const attack = content.buildings[entity.defId]?.attack;
        if (attack) g.circle(x, y, attack.range + entity.radius).stroke({ width: 1, color, alpha: 0.08 });
        continue;
      }
      if (entity.mode === "builder") {
        drawBuilder(g, entity, x, y, color);
        continue;
      }
      g.circle(x, y, entity.radius).fill({ color, alpha: 0.85 });
      if (entity.mode === "hero") g.circle(x, y, entity.radius + 6).stroke({ width: 2.5, color: HIGHLIGHT, alpha: 0.9 });
      if (entity.hp < entity.maxHp) {
        drawHealth(g, x - entity.radius, y - entity.radius - 6, entity.radius * 2, entity.hp / entity.maxHp);
      }
    }
  }

  private drawShots(frame: Frame): void {
    const { shots, fog } = frame;
    const g = this.dynamic;
    for (const shot of shots) {
      if (!fog.isVisible(shot.x1, shot.y1) && !fog.isVisible(shot.x2, shot.y2)) continue;
      const fade = 1 - shot.age / SHOT_TTL_MS;
      g.moveTo(shot.x1, shot.y1).lineTo(shot.x2, shot.y2).stroke({ width: 1.5, color: teamColor(frame.world, shot.team), alpha: fade });
    }
  }

  private drawPings({ pings }: Frame): void {
    for (const ping of pings) {
      const t = ping.age / PING_MS;
      this.overlay.circle(ping.x, ping.y, 28 * (1 - t) + 6).stroke({ width: 2.5, color: HIGHLIGHT, alpha: 1 - t });
    }
  }

  /** Your network rings, the footprint, and (for towers) the range. */
  private drawPlacement({ ghost, world, content, localTeam }: Frame): void {
    if (!ghost) return;
    for (const provider of networkProviders(world, content, localTeam)) {
      const reach = content.buildings[provider.defId]!.buildRadius! * TILE;
      this.overlay.circle(provider.x, provider.y, reach).stroke({ width: 2, color: VALID, alpha: 0.25 });
    }
    const size = ghost.footprint * TILE;
    this.overlay.rect(ghost.col * TILE, ghost.row * TILE, size, size).fill({ color: ghost.valid ? VALID : INVALID, alpha: 0.3 });
    if (ghost.range > 0) {
      this.overlay
        .circle(ghost.col * TILE + size / 2, ghost.row * TILE + size / 2, ghost.range + size / 2)
        .stroke({ width: 1.5, color: HIGHLIGHT, alpha: 0.6 });
    }
  }

  /**
   * Outline the selection; for a spawner or core, show where its units
   * gather: its own rally point, else the team's global one (fainter).
   */
  private drawSelection(world: World, content: Content, selectedId: number | null): void {
    if (selectedId === null) return;
    const entity = world.entities.find((e) => e.id === selectedId);
    if (!entity) return;
    const g = this.overlay;
    if (entity.kind === "unit") {
      g.circle(entity.x, entity.y, entity.radius + 9).stroke({ width: 2, color: HIGHLIGHT, alpha: 0.9 });
      return;
    }
    const size = entity.footprint * TILE + 6;
    g.rect(entity.x - size / 2, entity.y - size / 2, size, size).stroke({ width: 2, color: HIGHLIGHT, alpha: 0.9 });

    const team = world.teams[entity.team]!;
    const core = isCore(content, team, entity);
    if (!core && !content.buildings[entity.defId]!.spawn) return;
    const own = core ? team.rally : entity.rally;
    const rally = own ?? team.rally;
    if (!rally) return;
    const alpha = own ? 0.9 : 0.45;
    g.moveTo(entity.x, entity.y).lineTo(rally.x, rally.y).stroke({ width: 2, color: HIGHLIGHT, alpha: alpha * 0.6 });
    g.moveTo(rally.x, rally.y).lineTo(rally.x, rally.y - 26).stroke({ width: 2, color: HIGHLIGHT, alpha });
    g.moveTo(rally.x, rally.y - 26).lineTo(rally.x + 16, rally.y - 20).lineTo(rally.x, rally.y - 14).closePath().fill({ color: HIGHLIGHT, alpha });
    g.circle(rally.x, rally.y, 40).stroke({ width: 1, color: HIGHLIGHT, alpha: alpha * 0.4 });
  }
}

