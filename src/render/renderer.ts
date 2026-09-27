// Renderer. Reads the world, never writes it. Interpolates between the last
// two simulation ticks so 20 Hz logic still draws smoothly at display rate.

import { Application, Container, Graphics, Text } from "pixi.js";
import { COLS, HEIGHT, ROWS, SIDES, TILE, WIDTH, type Content, type World } from "../sim";

const TEAM_COLORS = [0x4ade80, 0xf87171] as const;
const SHOT_TTL_MS = 120;

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
}

export class Renderer {
  readonly app = new Application();
  readonly stage = new Container();
  private readonly dynamic = new Graphics();
  private readonly overlay = new Graphics();
  private readonly banner = new Text({
    text: "",
    style: { fill: 0xd6e2f0, fontFamily: "monospace", fontSize: 44, fontWeight: "bold" },
  });
  private previous = new Map<number, { x: number; y: number }>();
  private shots: Shot[] = [];
  private bannerAge = Infinity;

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: host, background: 0x0b0f14, antialias: true });
    host.appendChild(this.app.canvas);

    this.stage.addChild(this.drawBackground(), this.dynamic, this.overlay);
    this.banner.anchor.set(0.5);
    this.banner.position.set(WIDTH / 2, 80);
    this.stage.addChild(this.banner);
    this.app.stage.addChild(this.stage);

    this.fit();
    this.app.renderer.on("resize", () => this.fit());
  }

  /** Call right before stepping so interpolation has the pre-step positions. */
  capturePrevious(world: World): void {
    this.previous = new Map(world.entities.map((entity) => [entity.id, { x: entity.x, y: entity.y }]));
  }

  /** Call right after stepping to collect render-only events. */
  collectEvents(world: World): void {
    for (const event of world.events) {
      if (event.type === "shot") this.shots.push({ ...event, age: 0 });
      if (event.type === "wave") this.showBanner(`Wave ${event.index + 1}: ${event.name}`);
    }
  }

  showBanner(text: string): void {
    this.banner.text = text;
    this.bannerAge = 0;
  }

  draw(world: World, content: Content, alpha: number, deltaMs: number, ghost: Ghost | null): void {
    const g = this.dynamic;
    g.clear();

    for (const entity of world.entities) {
      const color = TEAM_COLORS[entity.team];
      if (entity.kind === "building") {
        const size = entity.footprint * TILE - 6;
        const left = entity.x - size / 2;
        const top = entity.y - size / 2;
        const building = entity.buildRemaining > 0;
        g.rect(left, top, size, size).fill({ color: 0x121922 }).stroke({ width: 2, color, alpha: building ? 0.4 : 1 });
        this.drawGlyph(g, entity.defId, entity.x, entity.y, size, color, building ? 0.35 : 0.9);
        this.drawHealth(g, left, top - 7, size, entity.hp / entity.maxHp);
        if (entity.defId === "core" || content.buildings[entity.defId]?.attack) {
          const range = content.buildings[entity.defId]!.attack!.range + entity.radius;
          g.circle(entity.x, entity.y, range).stroke({ width: 1, color, alpha: 0.08 });
        }
        continue;
      }

      const prev = this.previous.get(entity.id);
      const x = prev ? prev.x + (entity.x - prev.x) * alpha : entity.x;
      const y = prev ? prev.y + (entity.y - prev.y) * alpha : entity.y;
      g.circle(x, y, entity.radius).fill({ color, alpha: 0.85 });
      if (entity.hp < entity.maxHp) {
        this.drawHealth(g, x - entity.radius, y - entity.radius - 6, entity.radius * 2, entity.hp / entity.maxHp);
      }
    }

    for (const shot of this.shots) {
      const fade = 1 - shot.age / SHOT_TTL_MS;
      g.moveTo(shot.x1, shot.y1).lineTo(shot.x2, shot.y2).stroke({ width: 1.5, color: TEAM_COLORS[shot.team], alpha: fade });
      shot.age += deltaMs;
    }
    this.shots = this.shots.filter((shot) => shot.age < SHOT_TTL_MS);

    this.overlay.clear();
    if (ghost) {
      const size = ghost.footprint * TILE;
      this.overlay
        .rect(ghost.col * TILE, ghost.row * TILE, size, size)
        .fill({ color: ghost.valid ? 0x4ade80 : 0xf87171, alpha: 0.25 });
    }

    this.bannerAge += deltaMs;
    this.banner.alpha = world.outcome ? 1 : Math.max(0, 1 - this.bannerAge / 2500);
  }

  /** Convert a pointer position on the canvas to world pixels. */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    const scale = this.stage.scale.x;
    return {
      x: (clientX - rect.left - this.stage.x) / scale,
      y: (clientY - rect.top - this.stage.y) / scale,
    };
  }

  private fit(): void {
    const { width, height } = this.app.screen;
    const scale = Math.min(width / WIDTH, height / HEIGHT);
    this.stage.scale.set(scale);
    this.stage.position.set((width - WIDTH * scale) / 2, (height - HEIGHT * scale) / 2);
  }

  private drawBackground(): Graphics {
    const g = new Graphics();
    g.rect(0, 0, WIDTH, HEIGHT).fill({ color: 0x0e141b });
    for (const [index, side] of SIDES.entries()) {
      const zone = side.buildZone;
      g.rect(
        zone.colMin * TILE,
        zone.rowMin * TILE,
        (zone.colMax - zone.colMin + 1) * TILE,
        (zone.rowMax - zone.rowMin + 1) * TILE,
      ).fill({ color: TEAM_COLORS[index as 0 | 1], alpha: 0.04 });
    }
    for (let col = 0; col <= COLS; col += 1) {
      g.moveTo(col * TILE, 0).lineTo(col * TILE, HEIGHT);
    }
    for (let row = 0; row <= ROWS; row += 1) {
      g.moveTo(0, row * TILE).lineTo(WIDTH, row * TILE);
    }
    g.stroke({ width: 1, color: 0x1a2430 });
    return g;
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
      case "server-rack":
        for (let i = -1; i <= 1; i += 1) g.rect(x - s, y + i * s * 0.7 - 2, s * 2, 4).fill({ color, alpha });
        break;
      case "gpu-cluster":
        for (const dx of [-1, 1]) for (const dy of [-1, 1]) g.rect(x + dx * s * 0.5 - 4, y + dy * s * 0.5 - 4, 8, 8).fill({ color, alpha });
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
