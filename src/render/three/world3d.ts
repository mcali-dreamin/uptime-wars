// The Three.js world view, and the default way the game is drawn: the same
// simulation as WC3-style terrain under an angled camera, with lit models,
// shadows, glow, and effects. Render-only, like every view; the Pixi shell
// keeps the minimap, banner, and fog bookkeeping and hands us each frame.
//
// Units: x and z are world pixels (z = the sim's y), y is height.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { TILE, isCore, networkProviders, type Entity, type Point, type SimEvent, type World } from "../../sim";
import { PING_MS, SHOT_TTL_MS, type Frame, type WorldView } from "../frame";
import { HIGHLIGHT, INVALID, VALID, teamColor } from "../palette";
import { Bars, Bolts, Particles, Rings } from "./effects";
import { FogTexture } from "./fog3d";
import { Models, animate } from "./models";
import { Terrain3D } from "./terrain3d";

/** Camera distance at zoom 1, pitch above the horizon, and field of view. */
const DISTANCE = 1000;
const PITCH = (56 * Math.PI) / 180;
const FOV = 40;
/** Rough top of each building model, for health bars. */
const BUILDING_TOP: Record<string, number> = {
  core: 116,
  "malware-nest": 70,
  "c2-server": 76,
  "server-rack": 62,
  "hyperscale-rack": 72,
  "gpu-cluster": 32,
  firewall: 80,
  "cdn-edge": 108,
  "solar-array": 30,
  "power-plant": 58,
  "web-app": 72,
  "mesh-node": 48,
  "edge-pop": 50,
  "data-pump": 74,
};
/** Turn rate for units changing heading, per second. */
const TURN = 10;
const SKY = 0x060a12;

interface Shown {
  object: THREE.Group;
  kind: "unit" | "building";
  /** The team colour it was built in. */
  color: number;
  defId: string;
  size: number;
  seed: number;
  heading: number;
  lastX: number;
  lastY: number;
  holo: boolean;
}

export class World3D implements WorldView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 10, 40000);
  private readonly raycaster = new THREE.Raycaster();
  private readonly sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
  private readonly composer: EffectComposer | null;
  private readonly bloom: UnrealBloomPass | null;
  private readonly fogTexture = new FogTexture();
  private readonly terrain3d = new Terrain3D(this.fogTexture);
  private readonly models = new Models(this.fogTexture);
  private readonly bolts = new Bolts();
  private readonly particles = new Particles();
  private readonly bars = new Bars();
  private readonly thinRings = new Rings(0.975);
  private readonly rings = new Rings(0.82);
  private readonly entityLayer = new THREE.Group();
  private readonly shown = new Map<number, Shown>();
  private readonly ghost: THREE.Mesh;
  private readonly flag = new THREE.Group();
  private readonly rallyLine: THREE.Line;
  private readonly deaths: Extract<SimEvent, { type: "death" }>[] = [];
  private world: World | null = null;
  private lastTime = performance.now();
  /** Software rendering (CI, old machines): no shadows, no bloom. */
  readonly lowQuality: boolean;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    // `?low` forces the cheap path; `?hq` forces the full one even in software.
    const params = new URLSearchParams(location.search);
    this.lowQuality = params.has("low") || (isSoftwareRenderer(this.renderer) && !params.has("hq"));
    this.renderer.setPixelRatio(this.lowQuality ? 1 : Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(SKY);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = !this.lowQuality;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.style.pointerEvents = "none";
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    host.insertBefore(canvas, host.firstChild);

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 2000, 6000);
    this.scene.add(new THREE.HemisphereLight(0x9cc2ff, 0x241634, 1.1));
    this.sun.castShadow = !this.lowQuality;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
    // A cool rim light from the opposite side, so cliffs read from both faces.
    const rim = new THREE.DirectionalLight(0x5b8cff, 0.55);
    rim.position.set(1, 0.6, 1);
    this.scene.add(rim);

    this.ghost = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }),
    );
    this.ghost.visible = false;
    this.buildFlag();
    this.rallyLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: HIGHLIGHT, transparent: true, opacity: 0.6, toneMapped: false }),
    );
    this.rallyLine.frustumCulled = false;
    this.rallyLine.visible = false;

    this.scene.add(
      this.terrain3d.group,
      this.entityLayer,
      this.bolts.mesh,
      this.particles.points,
      this.thinRings.mesh,
      this.rings.mesh,
      this.bars.group,
      this.ghost,
      this.flag,
      this.rallyLine,
    );

    if (this.lowQuality) {
      this.composer = null;
      this.bloom = null;
    } else {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.55, 0.82);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  // --- WorldView ------------------------------------------------------------

  setWorld(world: World): void {
    this.world = world;
    for (const s of this.shown.values()) this.entityLayer.remove(s.object);
    this.shown.clear();
    this.deaths.length = 0;
    this.fogTexture.setTerrain(world.terrain);
    this.terrain3d.build(world.terrain);
  }

  event(event: SimEvent): void {
    if (event.type === "death") this.deaths.push(event);
  }

  draw(frame: Frame): void {
    if (!this.world) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const t = now / 1000;
    this.placeCamera(frame);
    this.fogTexture.update(frame.fog, t);
    this.models.update(t);
    this.syncEntities(frame, t, dt);
    this.drawDeaths(frame);
    this.drawShots(frame);
    this.drawOverlay(frame, t);
    this.particles.update(dt);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  pick(x: number, y: number): Point | null {
    this.aim(x, y);
    const hit = this.raycaster.intersectObjects(this.terrain3d.chunks, false)[0];
    return hit ? { x: hit.point.x, y: hit.point.z } : null;
  }

  entityAt(x: number, y: number): number | null {
    this.aim(x, y);
    const hits = this.raycaster.intersectObject(this.entityLayer, true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node && node.userData.entityId === undefined) node = node.parent;
      if (node && node.visible) return node.userData.entityId as number;
    }
    return null;
  }

  project(x: number, y: number): Point {
    const v = new THREE.Vector3(x, this.terrain3d.floorAt(x, y), y).project(this.camera);
    const { width, height } = this.size();
    return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
  }

  viewRect() {
    const { width, height } = this.size();
    const ground = (x: number, y: number): Point | null => {
      this.aim(x, y);
      const hit = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      return hit ? { x: hit.x, y: hit.z } : null;
    };
    const corners = [ground(0, 0), ground(width, 0), ground(0, height), ground(width, height)].filter((p): p is Point => p !== null);
    if (corners.length === 0 || !this.world) return null;
    const w = this.world.terrain.cols * TILE;
    const h = this.world.terrain.rows * TILE;
    const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
    return {
      left: clamp(Math.min(...corners.map((p) => p.x)), w),
      right: clamp(Math.max(...corners.map((p) => p.x)), w),
      top: clamp(Math.min(...corners.map((p) => p.y)), h),
      bottom: clamp(Math.max(...corners.map((p) => p.y)), h),
    };
  }

  // --- camera ---------------------------------------------------------------

  /** Follow the shell's camera: same centre and zoom, seen from an angle. */
  private placeCamera(frame: Frame): void {
    const { camera } = frame;
    const ground = this.terrain3d.floorAt(camera.x, camera.y);
    const target = new THREE.Vector3(camera.x, ground, camera.y);
    const distance = DISTANCE / camera.zoom;
    this.camera.position.set(target.x, target.y + distance * Math.sin(PITCH), target.z + distance * Math.cos(PITCH));
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();

    const fog = this.scene.fog as THREE.Fog;
    fog.near = distance * 1.25;
    fog.far = distance * 3.4;

    // The sun's shadow box follows what you're looking at.
    const half = Math.min(3200, Math.max(500, distance * 1.05));
    const shadow = this.sun.shadow.camera;
    shadow.left = -half;
    shadow.right = half;
    shadow.top = half;
    shadow.bottom = -half;
    shadow.near = 10;
    shadow.far = 6000;
    shadow.updateProjectionMatrix();
    this.sun.target.position.copy(target);
    this.sun.position.set(target.x - 900, target.y + 1700, target.z - 600);
  }

  private aim(x: number, y: number): void {
    const { width, height } = this.size();
    this.raycaster.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), this.camera);
  }

  // --- entities -------------------------------------------------------------

  private syncEntities(frame: Frame, t: number, dt: number): void {
    const { world } = frame;
    const alive = new Set<number>();
    this.bars.begin(this.camera);
    for (const entity of world.entities) {
      alive.add(entity.id);
      const at = frame.position(entity);
      let s = this.shown.get(entity.id);
      if (!s) {
        s = this.make(world, entity);
        this.shown.set(entity.id, s);
        this.entityLayer.add(s.object);
      }
      const visible = frame.shows(entity, at.x, at.y) && entity.hp > 0;
      s.object.visible = visible;
      if (!visible) continue;

      const floor = this.terrain3d.floorAt(at.x, at.y);
      s.object.position.set(at.x, floor, at.y);
      animate(s.object, t, s.seed);

      if (entity.kind === "unit") {
        const dx = at.x - s.lastX;
        const dy = at.y - s.lastY;
        if (dx * dx + dy * dy > 0.04) {
          const target = Math.atan2(dx, dy);
          let delta = target - s.heading;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          s.heading += delta * Math.min(1, TURN * dt);
        }
        s.lastX = at.x;
        s.lastY = at.y;
        s.object.rotation.y = s.heading;
        if (entity.hp < entity.maxHp || frame.selectedIds.has(entity.id)) {
          this.bars.add(at.x, floor + s.size * 3.4, at.y, Math.max(16, s.size * 2.4), entity.hp / entity.maxHp);
        }
        continue;
      }

      // Buildings: a hologram that rises while it's being deployed.
      const building = entity.buildRemaining > 0;
      if (building !== s.holo) this.setHologram(s, building);
      s.object.scale.y = building ? Math.max(0.08, entity.hp / entity.maxHp) : 1;
      const top = BUILDING_TOP[entity.defId] ?? 50;
      const selected = frame.selectedId === entity.id;
      if (entity.hp < entity.maxHp || selected) {
        this.bars.add(at.x, floor + top * s.object.scale.y + 12, at.y, entity.footprint * TILE * 0.8, entity.hp / entity.maxHp);
      }
    }
    this.bars.end();
    for (const [id, s] of this.shown) {
      if (alive.has(id)) continue;
      this.entityLayer.remove(s.object);
      this.shown.delete(id);
    }
  }

  private make(world: World, entity: Entity): Shown {
    const color = teamColor(world, entity.team);
    const horde = world.teams[entity.team]?.controller !== "human";
    const size = entity.kind === "unit" ? entity.radius : entity.footprint;
    const object = this.models.make(entity.defId, color, size, entity.kind === "unit");
    object.userData.entityId = entity.id;
    object.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) node.userData.material = (node as THREE.Mesh).material;
    });
    return {
      object,
      kind: entity.kind,
      color,
      defId: entity.defId,
      size,
      seed: (entity.id * 1.618) % (Math.PI * 2),
      heading: horde ? 0 : Math.PI,
      lastX: entity.x,
      lastY: entity.y,
      holo: false,
    };
  }

  private setHologram(s: Shown, on: boolean): void {
    s.holo = on;
    const holo = this.models.hologram(s.color);
    s.object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = on ? holo : (mesh.userData.material as THREE.Material);
      mesh.castShadow = !on;
    });
  }

  // --- effects --------------------------------------------------------------

  private drawDeaths(frame: Frame): void {
    for (const death of this.deaths) {
      if (!frame.fog.isVisible(death.x, death.y)) continue;
      const s = this.shown.get(death.id);
      const floor = this.terrain3d.floorAt(death.x, death.y);
      const color = teamColor(frame.world, death.team);
      if (s?.kind === "building") {
        this.particles.burst(death.x, floor + 30, death.y, 90, color, 1.8);
        this.particles.burst(death.x, floor + 20, death.y, 60, 0xffb347, 1.4);
      } else {
        const big = (s?.size ?? 8) > 14;
        this.particles.burst(death.x, floor + 10, death.y, big ? 70 : 18, color, big ? 1.5 : 0.8);
      }
    }
    this.deaths.length = 0;
  }

  private drawShots(frame: Frame): void {
    this.bolts.begin();
    for (const shot of frame.shots) {
      if (!frame.fog.isVisible(shot.x1, shot.y1) && !frame.fog.isVisible(shot.x2, shot.y2)) continue;
      const progress = Math.min(1, shot.age / SHOT_TTL_MS);
      const y1 = this.terrain3d.floorAt(shot.x1, shot.y1) + 22;
      const y2 = this.terrain3d.floorAt(shot.x2, shot.y2) + 12;
      this.bolts.add(shot.x1, y1, shot.y1, shot.x2, y2, shot.y2, progress, teamColor(frame.world, shot.team));
      // A spark where it lands, once.
      if (shot.age === 0) this.particles.burst(shot.x2, y2, shot.y2, 3, teamColor(frame.world, shot.team), 0.45);
    }
    this.bolts.end();
  }

  // --- overlay: selection, rally, placement, pings --------------------------

  private drawOverlay(frame: Frame, t: number): void {
    const { world, content } = frame;
    this.rings.begin();
    this.thinRings.begin();
    this.flag.visible = false;
    this.rallyLine.visible = false;
    const ground = (x: number, y: number) => this.terrain3d.floorAt(x, y) + 1.5;

    // A group of units: a ring under each, and a marker where each is headed.
    const destinations = new Set<string>();
    for (const entity of world.entities) {
      if (entity.kind !== "unit" || entity.hp <= 0 || !frame.selectedIds.has(entity.id) || entity.id === frame.selectedId) continue;
      const at = frame.position(entity);
      this.rings.add(at.x, ground(at.x, at.y), at.y, entity.radius + 7, HIGHLIGHT, 0.9);
      if (entity.order) {
        const key = `${Math.round(entity.homeX / 24)}:${Math.round(entity.homeY / 24)}`;
        if (destinations.has(key)) continue;
        destinations.add(key);
        const color = entity.order === "attack" ? INVALID : VALID;
        this.thinRings.add(entity.homeX, ground(entity.homeX, entity.homeY), entity.homeY, 6, color, 0.8);
      }
    }

    if (frame.selectedId !== null) {
      const selected = world.entities.find((e) => e.id === frame.selectedId);
      if (selected && selected.hp > 0) {
        const at = frame.position(selected);
        const radius = selected.kind === "building" ? (selected.footprint * TILE) / 2 + 10 : selected.radius + 9;
        this.rings.add(at.x, ground(at.x, at.y), at.y, radius + Math.sin(t * 4) * 1.5, HIGHLIGHT, 1);
        if (selected.kind === "building") {
          const def = content.buildings[selected.defId]!;
          if (def.attack) this.thinRings.add(at.x, ground(at.x, at.y), at.y, def.attack.range + selected.radius, HIGHLIGHT, 0.35);
          const team = world.teams[selected.team]!;
          const core = isCore(content, team, selected);
          if (core || def.spawn) {
            const own = core ? team.rally : selected.rally;
            const rally = own ?? team.rally;
            if (rally) this.showRally(at, rally, own ? 1 : 0.5);
          }
        }
      }
    }

    if (frame.ghost) {
      for (const provider of networkProviders(world, content, frame.localTeam)) {
        const reach = content.buildings[provider.defId]!.buildRadius! * TILE;
        this.thinRings.add(provider.x, ground(provider.x, provider.y), provider.y, reach, VALID, 0.45);
      }
      const g = frame.ghost;
      const size = g.footprint * TILE;
      const cx = g.col * TILE + size / 2;
      const cz = g.row * TILE + size / 2;
      this.ghost.visible = true;
      this.ghost.scale.set(size - 4, 36, size - 4);
      this.ghost.position.set(cx, this.terrain3d.floorAt(cx, cz) + 18, cz);
      (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(g.valid ? VALID : INVALID);
      if (g.range > 0) this.thinRings.add(cx, ground(cx, cz), cz, g.range + size / 2, HIGHLIGHT, 0.6);
    } else {
      this.ghost.visible = false;
    }

    for (const ping of frame.pings) {
      const k = ping.age / PING_MS;
      this.rings.add(ping.x, ground(ping.x, ping.y), ping.y, 30 * (1 - k) + 6, HIGHLIGHT, 1 - k);
    }
    this.rings.end();
    this.thinRings.end();
  }

  private showRally(from: Point, to: Point, strength: number): void {
    const y = this.terrain3d.floorAt(to.x, to.y);
    this.flag.visible = true;
    this.flag.position.set(to.x, y, to.y);
    this.flag.scale.setScalar(strength > 0.75 ? 1 : 0.8);
    this.rings.add(to.x, y + 1.5, to.y, 40, HIGHLIGHT, 0.4 * strength);
    const line = this.rallyLine.geometry.getAttribute("position") as THREE.BufferAttribute;
    line.setXYZ(0, from.x, this.terrain3d.floorAt(from.x, from.y) + 6, from.y);
    line.setXYZ(1, to.x, y + 6, to.y);
    line.needsUpdate = true;
    (this.rallyLine.material as THREE.LineBasicMaterial).opacity = 0.6 * strength;
    this.rallyLine.visible = true;
  }

  private buildFlag(): void {
    const material = new THREE.MeshBasicMaterial({ color: HIGHLIGHT, toneMapped: false });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 40, 6), material);
    pole.position.y = 20;
    const banner = new THREE.Mesh(new THREE.BoxGeometry(18, 11, 1), material);
    banner.position.set(9, 34, 0);
    this.flag.add(pole, banner);
    this.flag.visible = false;
  }

  // --- helpers --------------------------------------------------------------

  private size() {
    return { width: this.host.clientWidth || 1, height: this.host.clientHeight || 1 };
  }

  private resize(): void {
    const { width, height } = this.size();
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(width, height);
    this.bloom?.resolution.set(width / 2, height / 2);
  }
}

function isSoftwareRenderer(renderer: THREE.WebGLRenderer): boolean {
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software/i.test(name);
}
