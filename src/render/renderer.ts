// The renderer shell. Reads the world, never writes it.
//
// It owns what every view shares: the Pixi app (the HUD-level overlay over
// the 3D view), the camera, fog, minimap, banner, entity interpolation
// between 20 Hz ticks, and transient effects (shots, order pings). The world
// itself is drawn by a WorldView: the Three.js view once attached (the
// default), or World2D (`?2d`).

import { Application, Text } from "pixi.js";
import { TILE, hostile, type Content, type TeamId, type World } from "../sim";
import { Camera } from "./camera";
import { Fog } from "./fog";
import { PING_MS, SHOT_TTL_MS, type Ghost, type Shot, type WorldView } from "./frame";
import { Minimap } from "./minimap";
import { World2D } from "./pixi/world2d";

export class Renderer {
  readonly app = new Application();
  readonly camera = new Camera();
  /** `?reveal` in the URL turns fog off, for debugging. */
  readonly fog = new Fog(!new URLSearchParams(location.search).has("reveal"));
  private readonly minimap = new Minimap(this.fog);
  private readonly world2d = new World2D(this.camera, this.fog);
  private view: WorldView = this.world2d;
  /** The team this browser plays: whose home, whose fog, whose network. */
  localTeam: TeamId = 0;
  private readonly banner = new Text({
    text: "",
    style: { fill: 0xd6e2f0, fontFamily: "monospace", fontSize: 26, fontWeight: "bold" },
  });
  private bannerAge = Infinity;
  private previous = new Map<number, { x: number; y: number }>();
  private shots: Shot[] = [];
  /** Order markers: a ring that shrinks where you just sent something. */
  private pings: { x: number; y: number; age: number }[] = [];

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
    this.banner.anchor.set(0.5, 0);
    this.app.stage.addChild(this.world2d.layer, this.minimap.root, this.banner);
  }

  /** Draw the world with another view (the 3D one). The 2D world layer goes quiet. */
  attach(view: WorldView): void {
    this.view = view;
    this.world2d.layer.visible = false;
  }

  /** Call when a new match starts: redraws terrain and centers on home. */
  setWorld(world: World): void {
    const { terrain } = world;
    this.previous.clear();
    this.shots = [];
    this.pings = [];
    this.camera.setBounds(terrain.cols * TILE, terrain.rows * TILE);
    this.view.setWorld(world);
    this.fog.reset(world);
    this.minimap.setWorld(world);
    const home = this.home(world);
    if (home) this.camera.centerOn(home.x, home.y);
  }

  /** Your core, or your builder before the core is founded. */
  home(world: World) {
    const team = world.teams[this.localTeam]!;
    return world.entities.find((entity) => entity.id === (team.coreId !== -1 ? team.coreId : team.builderId));
  }

  /** Call right before stepping so interpolation has the pre-step positions. */
  capturePrevious(world: World): void {
    this.previous = new Map(world.entities.map((entity) => [entity.id, { x: entity.x, y: entity.y }]));
  }

  /** Call right after stepping to collect render-only events. */
  collectEvents(world: World): void {
    for (const event of world.events) {
      this.view.event?.(event);
      if (event.type === "shot") this.shots.push({ ...event, age: 0 });
      if (event.type === "founded") this.showBanner("Core online");
      if (event.type === "fortified") this.showBanner(`The botnet rebuilt ${event.rebuilt} C2 Server${event.rebuilt > 1 ? "s" : ""}`);
      if (event.type === "wave") this.showBanner(`Wave ${event.wave} · ${event.name}${event.boss ? " · BOSS" : ""}`);
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

  draw(world: World, content: Content, alpha: number, deltaMs: number, ghost: Ghost | null, selectedId: number | null = null, selected: readonly number[] = []): void {
    const { width, height } = this.app.screen;
    this.camera.setViewport(width, height);
    this.camera.update(deltaMs);
    this.fog.update(world, content, this.localTeam, deltaMs);

    const shows = (entity: World["entities"][number], x: number, y: number) => this.shows(world, entity, x, y);
    this.view.draw({
      world,
      content,
      alpha,
      deltaMs,
      ghost,
      selectedId,
      selectedIds: new Set(selected),
      localTeam: this.localTeam,
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
      shows,
    });
    this.age(deltaMs);
    this.minimap.draw(world, width, height, this.view.viewRect() ?? this.camera.view(0), (e) => shows(e, e.x, e.y));
    this.banner.position.set(width / 2, 24);
    this.bannerAge += deltaMs;
    this.banner.alpha = world.outcome ? 1 : Math.max(0, 1 - this.bannerAge / 2500);
  }

  /** Canvas-relative pointer to world pixels. */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const { x, y } = this.local(clientX, clientY);
    return this.view.pick(x, y) ?? this.camera.screenToWorld(x, y);
  }

  /** The entity drawn under the pointer, if the view can tell (3D models stand up off the ground). */
  entityUnder(clientX: number, clientY: number): number | null {
    const { x, y } = this.local(clientX, clientY);
    return this.view.entityAt?.(x, y) ?? null;
  }

  /** A world ground point to client (page) pixels. */
  toScreen(x: number, y: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    const p = this.view.project(x, y);
    return { x: rect.left + p.x, y: rect.top + p.y };
  }

  /** World point under the pointer if it is over the minimap, else null. */
  minimapHit(clientX: number, clientY: number): { x: number; y: number } | null {
    const { x, y } = this.local(clientX, clientY);
    return this.minimap.hit(x, y);
  }

  private local(clientX: number, clientY: number) {
    const rect = this.app.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  /** Whether the local player may see this entity right now. */
  private shows(world: World, entity: World["entities"][number], x: number, y: number): boolean {
    // You and your allies are always visible to you.
    if (!hostile(world, entity.team, this.localTeam)) return true;
    return entity.kind === "building" ? this.fog.isExplored(x, y) : this.fog.isVisible(x, y);
  }

  private age(deltaMs: number): void {
    for (const shot of this.shots) shot.age += deltaMs;
    this.shots = this.shots.filter((shot) => shot.age < SHOT_TTL_MS);
    for (const ping of this.pings) ping.age += deltaMs;
    this.pings = this.pings.filter((ping) => ping.age < PING_MS);
  }
}
