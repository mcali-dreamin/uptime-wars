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
import { TILE, isCore, tierOf, type Content, type Entity, type Point, type SimEvent, type World } from "../../sim";
import { PING_MS, SHOT_TTL_MS, type Frame, type WorldView } from "../frame";
import { HIGHLIGHT, INVALID, VALID, teamColor } from "../palette";
import { Bars, Bolts, Debris, Particles, Rings } from "./effects";
import { FogTexture } from "./fog3d";
import { roleOf, Models, animate } from "./models";
import { Terrain3D } from "./terrain3d";
import { NetworkOverlay } from "./network3d";

/** Camera distance at zoom 1, pitch above the horizon, and field of view. */
/** Gold underfoot marks heroes. */
const HERO_RING = 0xfacc15;
/** Heroes are drawn this much bigger than their footprint suggests. */
const HERO_SCALE = 1.35;

let beaconGeometry: THREE.BufferGeometry | null = null;
let beaconMaterial: THREE.Material | null = null;
function heroBeaconGeometry(): THREE.BufferGeometry {
  return (beaconGeometry ??= new THREE.OctahedronGeometry(1));
}
function heroBeaconMaterial(): THREE.Material {
  return (beaconMaterial ??= new THREE.MeshBasicMaterial({ color: 0xfde047, toneMapped: false }));
}
const SHOCKWAVE_S = 0.6;
const DISTANCE = 1000;
const PITCH = (56 * Math.PI) / 180;
const FOV = 40;
/** Rough top of each building model, for health bars. */
const BUILDING_TOP: Record<string, number> = {
  core: 116,
  monorepo: 60,
  "compute-pool": 20,
  "ci-server": 56,
  "rnd-lab": 40,
  "build-pipeline": 36,
  "design-studio": 40,
  "edge-fleet": 52,
  "mainframe-bay": 50,
  "state-machine": 44,
  "trust-safety": 44,
  "legal-dept": 42,
  "malware-nest": 70,
  "c2-server": 76,
  "botnet-farm": 64,
  "infected-node": 72,
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
};
/** How a shot reads: melee is a strike at the target, ranged a bolt, towers a heavier bolt. */
type ShotStyle = "melee" | "ranged" | "tower";
/** A unit attacking from this close (px) is melee: no bolt, it lunges. */
const MELEE_RANGE = 40;
/** A hit this hard or harder lands with a bang. */
const HEAVY_DAMAGE = 30;
/** Hit reaction (flinch and knock-back) and attack lunge, in ms. */
const FLINCH_MS = 160;
const LUNGE_MS = 140;
/** A unit's health bar stays up this long after its last hit, then fades. */
const BAR_MS = 2600;
const BAR_FADE_MS = 500;
/** A building this hurt keeps its bar up. */
const BUILDING_BAR_BELOW = 0.6;
/** Camera shake from a building going down on screen. */
const SHAKE_S = 0.45;
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
  /** Top of the model (buildings), measured once, for health bars. */
  top?: number;
  /** Its scale before any hit reaction (rank, hero). */
  scale: number;
  /** Last hit: when (ms, performance clock; may be in the future while the bolt flies) and from where. */
  hitAt: number;
  hitX: number;
  hitY: number;
  /** Last melee swing: when, and toward where. */
  lungeAt: number;
  lungeX: number;
  lungeY: number;
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
  private readonly network = new NetworkOverlay();
  private readonly terrain3d = new Terrain3D(this.fogTexture, this.network);
  private readonly models = new Models(this.fogTexture);
  private readonly bolts = new Bolts();
  private readonly particles = new Particles();
  private readonly debris = new Debris();
  /** Shots fired since the last frame, for impacts, flinches, and lunges. */
  private readonly fired: Extract<SimEvent, { type: "shot" }>[] = [];
  /** Every entity by id, refreshed each frame. */
  private readonly byId = new Map<number, Entity>();
  /** Bolts whose impact has been drawn. */
  private readonly landed = new WeakSet<object>();
  /** Screen shake left (s) and its strength (px). */
  private shake = 0;
  private shakePower = 0;
  private readonly bars = new Bars();
  private readonly thinRings = new Rings(0.975);
  private readonly rings = new Rings(0.82);
  private readonly entityLayer = new THREE.Group();
  private readonly shown = new Map<number, Shown>();
  private readonly ghost: THREE.Mesh;
  private readonly flag = new THREE.Group();
  private readonly rallyLine: THREE.Line;
  private readonly deaths: Extract<SimEvent, { type: "death" | "expired" }>[] = [];
  /** Ability casts and hero level-ups, for their effects. */
  private readonly casts: Extract<SimEvent, { type: "cast" }>[] = [];
  /** Expanding shockwave rings from casts: where, how big, how old. */
  private shockwaves: { x: number; y: number; radius: number; color: number; age: number }[] = [];
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
      this.debris.mesh,
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
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.5, 0.9);
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
    this.fired.length = 0;
    this.fogTexture.setTerrain(world.terrain);
    this.terrain3d.build(world.terrain);
    this.network.setWorld(world);
  }

  event(event: SimEvent): void {
    if (event.type === "death" || event.type === "expired") this.deaths.push(event);
    if (event.type === "cast") this.casts.push(event);
    if (event.type === "shot") this.fired.push(event);
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
    this.byId.clear();
    for (const e of frame.world.entities) this.byId.set(e.id, e);
    this.drawImpacts(frame, now);
    this.syncEntities(frame, t, dt, now);
    this.drawDeaths(frame);
    this.drawCasts(frame, dt);
    this.drawShots(frame);
    this.drawOverlay(frame, t);
    this.particles.update(dt);
    this.debris.update(dt);
    this.shake = Math.max(0, this.shake - dt);
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
    if (this.shake > 0) {
      const k = (this.shake / SHAKE_S) * this.shakePower;
      target.x += (Math.random() - 0.5) * 2 * k;
      target.z += (Math.random() - 0.5) * 2 * k;
    }
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

  /** Whether a world point is in view (roughly: inside the camera's ground rectangle). */
  private onScreen(x: number, y: number): boolean {
    const v = new THREE.Vector3(x, this.terrain3d.floorAt(x, y), y).project(this.camera);
    return Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z < 1;
  }

  private aim(x: number, y: number): void {
    const { width, height } = this.size();
    this.raycaster.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), this.camera);
  }

  // --- entities -------------------------------------------------------------

  private syncEntities(frame: Frame, t: number, dt: number, now: number): void {
    const { world } = frame;
    const alive = new Set<number>();
    // Functions with units running are warm; the rest are drawn cold.
    const running = new Set<number>();
    for (const e of world.entities) if (e.kind === "unit" && e.spawnerId >= 0 && e.hp > 0) running.add(e.spawnerId);
    this.bars.begin(this.camera);
    for (const entity of world.entities) {
      alive.add(entity.id);
      const at = frame.position(entity);
      let s = this.shown.get(entity.id);
      if (!s) {
        s = this.make(world, frame.content, entity);
        this.shown.set(entity.id, s);
        this.entityLayer.add(s.object);
      }
      const visible = frame.shows(entity, at.x, at.y) && entity.hp > 0;
      s.object.visible = visible;
      if (!visible) continue;

      const floor = this.terrain3d.floorAt(at.x, at.y);
      s.object.position.set(at.x, floor, at.y);
      animate(s.object, t, s.seed);
      this.react(s, at, now);

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
        // A hero's bar is always up, above its beacon. Anyone else's only
        // while it's selected or for a moment after it's hit: a brawl of a
        // hundred units shouldn't be a wall of bars.
        const hero = entity.mode === "hero";
        const since = now - s.hitAt;
        const recent = entity.hp < entity.maxHp && since < BAR_MS;
        if (hero || frame.selectedIds.has(entity.id) || recent) {
          const y = hero ? s.size * 5.6 : s.size * 3.4;
          const width = Math.max(16, s.size * (hero ? 3 : 2.4));
          const fade = hero || frame.selectedIds.has(entity.id) ? 1 : Math.min(1, (BAR_MS - since) / BAR_FADE_MS);
          this.bars.add(at.x, floor + y, at.y, width * fade, entity.hp / entity.maxHp);
        }
        continue;
      }

      // Buildings: a hologram that rises while it's being deployed.
      const cold = frame.content.buildings[entity.defId]?.invoke !== undefined && !running.has(entity.id);
      const building = entity.buildRemaining > 0;
      // Mid rank-up it's a hologram too: being rebuilt, not working.
      const holo = building || cold || (entity.refitRemaining ?? 0) > 0;
      if (holo !== s.holo) this.setHologram(s, holo);
      // A core grows with its team's tier: Data Center, then Region. A spawner with its rank.
      const owner = frame.world.teams[entity.team];
      const grow = owner && isCore(frame.content, owner, entity) ? 1 + 0.18 * tierOf(frame.content, owner) : 1 + 0.14 * (entity.rank ?? 0);
      s.object.scale.set(grow, building ? Math.max(0.08, entity.hp / entity.maxHp) * grow : grow, grow);
      const top = s.top ?? BUILDING_TOP[entity.defId] ?? 50;
      const selected = frame.selectedId === entity.id || frame.selectedIds.has(entity.id);
      // A building's bar: while selected, just after a hit, or once it's badly hurt.
      const since = now - s.hitAt;
      const ratio = entity.hp / entity.maxHp;
      if (selected || (ratio < 1 && (since < BAR_MS || ratio < BUILDING_BAR_BELOW))) {
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

  private make(world: World, content: Content, entity: Entity): Shown {
    const color = teamColor(world, entity.team);
    const horde = world.teams[entity.team]?.controller !== "human";
    const size = entity.kind === "unit" ? entity.radius : entity.footprint;
    const team = world.teams[entity.team];
    const look = (team && content.races[team.raceId]?.look) ?? "default";
    const def = entity.kind === "building" ? content.buildings[entity.defId] : undefined;
    const role = def && team ? roleOf(def, isCore(content, team, entity)) : undefined;
    const made = def?.spawn?.unit ?? def?.invoke?.unit;
    const emblem = made ? { unit: made, size: content.units[made]!.size } : undefined;
    const object = this.models.make(entity.defId, color, size, entity.kind === "unit", look, role, def?.tier ?? 0, emblem);
    object.userData.entityId = entity.id;
    object.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) node.userData.material = (node as THREE.Mesh).material;
    });
    // Ranked units come out bigger, so a veteran squad reads at a glance.
    if (entity.kind === "unit" && entity.rank) object.scale.setScalar(1 + 0.2 * entity.rank);
    // Heroes stand out: a size bigger than their army, with a gold beacon overhead.
    if (entity.kind === "unit" && entity.mode === "hero") {
      object.scale.setScalar(HERO_SCALE);
      const beacon = new THREE.Group();
      beacon.position.y = size * 3.3;
      beacon.userData.anim = { type: "bob", amount: 2, speed: 2.2, base: size * 3.3 };
      const gem = new THREE.Mesh(heroBeaconGeometry(), heroBeaconMaterial());
      gem.scale.set(size * 0.32, size * 0.5, size * 0.32);
      gem.userData.anim = { type: "spin", speed: 2, axis: "y" };
      beacon.add(gem);
      object.add(beacon);
    }
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
      top: entity.kind === "building" ? new THREE.Box3().setFromObject(object).max.y : undefined,
      scale: object.scale.x,
      hitAt: -Infinity,
      hitX: 0,
      hitY: 0,
      lungeAt: -Infinity,
      lungeX: 0,
      lungeY: 0,
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

  /** How a shot from this entity reads. */
  private styleOf(content: Content, from: Entity | undefined): ShotStyle {
    if (!from) return "ranged";
    if (from.kind === "building") return "tower";
    return (content.units[from.defId]?.range ?? 0) <= MELEE_RANGE ? "melee" : "ranged";
  }

  /** Whether a shot from this entity hits hard. */
  private heavy(content: Content, from: Entity | undefined): boolean {
    if (!from) return false;
    if (from.kind === "building") return (content.buildings[from.defId]?.attack?.damage ?? 0) >= HEAVY_DAMAGE;
    const def = content.units[from.defId];
    return (def?.damage ?? 0) >= HEAVY_DAMAGE || def?.siege !== undefined || (from.rank ?? 0) >= 2;
  }

  /**
   * New shots: the target flinches when the hit lands (a bolt's flight time
   * later), a melee attacker lunges, and something visible marks the hit.
   */
  private drawImpacts(frame: Frame, now: number): void {
    const { content } = frame;
    for (const shot of this.fired) {
      if (!frame.fog.isVisible(shot.x1, shot.y1) && !frame.fog.isVisible(shot.x2, shot.y2)) continue;
      const from = this.byId.get(shot.from);
      const style = this.styleOf(content, from);
      const heavy = this.heavy(content, from);
      const color = teamColor(frame.world, shot.team);
      const lands = style === "melee" ? now + LUNGE_MS * 0.5 : now + SHOT_TTL_MS;
      const target = this.shown.get(shot.to);
      if (target) {
        target.hitAt = lands;
        target.hitX = shot.x1;
        target.hitY = shot.y1;
      }
      const attacker = this.shown.get(shot.from);
      if (attacker && style === "melee") {
        attacker.lungeAt = now;
        attacker.lungeX = shot.x2;
        attacker.lungeY = shot.y2;
      }
      const floor = this.terrain3d.floorAt(shot.x2, shot.y2);
      const big = this.byId.get(shot.to)?.kind === "building";
      const y = floor + (big ? 24 : 10);
      if (style === "melee") {
        // A strike: a tight white flash and a spray of the attacker's colour.
        this.particles.burst(shot.x2, y, shot.y2, 2, 0xffffff, 0.35);
        this.particles.burst(shot.x2, y, shot.y2, heavy ? 8 : 4, color, heavy ? 0.8 : 0.45);
      } else {
        // A muzzle flash where it leaves; the impact is drawn when the bolt arrives (drawShots).
        const fy = this.terrain3d.floorAt(shot.x1, shot.y1) + (style === "tower" ? 40 : 18);
        this.particles.burst(shot.x1, fy, shot.y1, style === "tower" ? 3 : 1, 0xffffff, 0.3);
      }
      if (heavy) this.shockwaves.push({ x: shot.x2, y: shot.y2, radius: big ? 34 : 20, color, age: SHOCKWAVE_S * 0.45 });
    }
    this.fired.length = 0;
  }

  /** Flinch when hit (squash and knock-back), lunge when swinging. */
  private react(s: Shown, at: Point, now: number): void {
    const object = s.object;
    let scaleX = 1;
    let scaleY = 1;
    const hit = (now - s.hitAt) / FLINCH_MS;
    if (hit >= 0 && hit < 1) {
      const k = 1 - hit;
      const dx = at.x - s.hitX;
      const dy = at.y - s.hitY;
      const d = Math.hypot(dx, dy) || 1;
      // Buildings shudder; units get knocked back a step.
      const push = s.kind === "building" ? 1.5 * Math.sin(hit * Math.PI * 6) : 4 * k;
      object.position.x += (dx / d) * push;
      object.position.z += (dy / d) * push;
      if (s.kind === "unit") {
        scaleY -= 0.22 * k;
        scaleX += 0.14 * k;
      }
    }
    const lunge = (now - s.lungeAt) / LUNGE_MS;
    if (lunge >= 0 && lunge < 1) {
      const dx = s.lungeX - at.x;
      const dy = s.lungeY - at.y;
      const d = Math.hypot(dx, dy) || 1;
      const reach = Math.sin(lunge * Math.PI) * Math.min(7, d * 0.4);
      object.position.x += (dx / d) * reach;
      object.position.z += (dy / d) * reach;
    }
    if (s.kind === "unit") object.scale.set(s.scale * scaleX, s.scale * scaleY, s.scale * scaleX);
  }

  private drawDeaths(frame: Frame): void {
    for (const death of this.deaths) {
      if (!frame.fog.isVisible(death.x, death.y)) continue;
      const s = this.shown.get(death.id);
      if (death.type === "expired") {
        // Gone cold: a quiet fizzle, not an explosion.
        this.particles.burst(death.x, this.terrain3d.floorAt(death.x, death.y) + 12, death.y, 8, teamColor(frame.world, death.team), 0.5);
        continue;
      }
      const floor = this.terrain3d.floorAt(death.x, death.y);
      const color = teamColor(frame.world, death.team);
      if (s?.kind === "building") {
        const footprint = s.size * TILE;
        this.particles.burst(death.x, floor + 30, death.y, 90, color, 1.8);
        this.particles.burst(death.x, floor + 20, death.y, 60, 0xffb347, 1.4);
        this.debris.burst(death.x, floor + 24, death.y, floor, 18 + s.size * 8, color, 5 + s.size * 1.5, 1.3);
        this.shockwaves.push({ x: death.x, y: death.y, radius: footprint * 1.4, color: 0xffb347, age: 0 });
        // Felt as well as seen: a short shake, harder for bigger buildings.
        if (this.onScreen(death.x, death.y)) {
          this.shake = SHAKE_S;
          this.shakePower = Math.max(this.shake > 0 ? this.shakePower : 0, 3 + s.size * 2);
        }
      } else {
        const size = s?.size ?? 8;
        const big = size > 14;
        this.particles.burst(death.x, floor + 10, death.y, big ? 70 : 18, color, big ? 1.5 : 0.8);
        this.particles.burst(death.x, floor + 10, death.y, big ? 12 : 4, 0xffffff, big ? 1 : 0.5);
        this.debris.burst(death.x, floor + size, death.y, floor, big ? 14 : 5, color, Math.max(2.5, size * 0.45), big ? 1.1 : 0.7);
      }
    }
    this.deaths.length = 0;
  }

  /** Ability effects: a burst at the target and a shockwave ring the size of its area. */
  private drawCasts(frame: Frame, dt: number): void {
    for (const cast of this.casts) {
      if (!frame.fog.isVisible(cast.x, cast.y)) continue;
      const floor = this.terrain3d.floorAt(cast.x, cast.y);
      const color = teamColor(frame.world, cast.team);
      const area = cast.radius > 0;
      this.particles.burst(cast.x, floor + 20, cast.y, area ? 120 : 50, color, area ? 2.2 : 1.4);
      this.particles.burst(cast.x, floor + 30, cast.y, 30, 0xffffff, 1.2);
      this.shockwaves.push({ x: cast.x, y: cast.y, radius: area ? cast.radius : 40, color, age: 0 });
    }
    this.casts.length = 0;
    for (const wave of this.shockwaves) wave.age += dt;
    this.shockwaves = this.shockwaves.filter((wave) => wave.age < SHOCKWAVE_S);
  }

  private drawShots(frame: Frame): void {
    this.bolts.begin();
    for (const shot of frame.shots) {
      if (!frame.fog.isVisible(shot.x1, shot.y1) && !frame.fog.isVisible(shot.x2, shot.y2)) continue;
      const from = this.byId.get(shot.from);
      const style = this.styleOf(frame.content, from);
      // Melee is drawn as a strike at the target (drawImpacts), not a bolt.
      if (style === "melee") continue;
      const progress = Math.min(1, shot.age / SHOT_TTL_MS);
      const tower = style === "tower";
      const y1 = this.terrain3d.floorAt(shot.x1, shot.y1) + (tower ? 40 : 22);
      const y2 = this.terrain3d.floorAt(shot.x2, shot.y2) + 12;
      const color = teamColor(frame.world, shot.team);
      this.bolts.add(shot.x1, y1, shot.y1, shot.x2, y2, shot.y2, progress, color, tower ? 2.6 : 1.4);
      // Sparks where it lands, once, when it gets there.
      if (progress >= 0.75 && !this.landed.has(shot)) {
        this.landed.add(shot);
        const heavy = this.heavy(frame.content, from);
        this.particles.burst(shot.x2, y2, shot.y2, heavy ? 10 : tower ? 6 : 4, color, heavy ? 0.9 : 0.55);
        this.particles.burst(shot.x2, y2, shot.y2, 1, 0xffffff, heavy ? 0.8 : 0.4);
      }
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
      // Shift-queued waypoints: a smaller marker at each, in order.
      for (const wp of entity.waypoints ?? []) {
        const key = `${Math.round(wp.x / 24)}:${Math.round(wp.y / 24)}`;
        if (destinations.has(key)) continue;
        destinations.add(key);
        this.thinRings.add(wp.x, ground(wp.x, wp.y), wp.y, 4, wp.attack ? INVALID : VALID, 0.6);
      }
    }

    // A group of buildings (spawners rallied together): a ring under each, a marker at each rally.
    const rallies = new Set<string>();
    for (const entity of world.entities) {
      if (entity.kind !== "building" || entity.hp <= 0 || !frame.selectedIds.has(entity.id) || entity.id === frame.selectedId) continue;
      const at = frame.position(entity);
      this.rings.add(at.x, ground(at.x, at.y), at.y, (entity.footprint * TILE) / 2 + 10, HIGHLIGHT, 0.9);
      const rally = entity.rally ?? world.teams[entity.team]!.rally;
      if (!rally) continue;
      const key = `${Math.round(rally.x / 24)}:${Math.round(rally.y / 24)}`;
      if (rallies.has(key)) continue;
      rallies.add(key);
      this.thinRings.add(rally.x, ground(rally.x, rally.y), rally.y, 10, HIGHLIGHT, entity.rally ? 0.9 : 0.45);
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
          if (core || def.spawn || def.invoke) {
            const own = core ? team.rally : selected.rally;
            const rally = own ?? team.rally;
            if (rally) this.showRally(at, rally, own ? 1 : 0.5);
          }
        }
      }
    }

    // Your network is drawn on the ground itself (see NetworkOverlay), brighter while placing.
    this.network.update(world, content, frame.localTeam, teamColor(world, frame.localTeam), frame.ghost !== null);
    if (frame.ghost) {
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

    // Heroes stand on a ring of their own, so you can find them in a crowd.
    for (const entity of world.entities) {
      if (entity.kind !== "unit" || entity.mode !== "hero" || entity.hp <= 0) continue;
      const at = frame.position(entity);
      if (!frame.shows(entity, at.x, at.y)) continue;
      const pulse = 0.75 + 0.25 * Math.sin(t * 3);
      this.rings.add(at.x, ground(at.x, at.y), at.y, entity.radius + 16, HERO_RING, pulse);
      this.thinRings.add(at.x, ground(at.x, at.y), at.y, entity.radius + 26 + Math.sin(t * 3) * 2, HERO_RING, 0.5 * pulse);
    }
    for (const wave of this.shockwaves) {
      const k = wave.age / SHOCKWAVE_S;
      this.rings.add(wave.x, ground(wave.x, wave.y), wave.y, wave.radius * (0.3 + 0.7 * k), wave.color, 1 - k);
    }

    // Jammed buildings: a red ring that flickers like static.
    for (const e of world.entities) {
      if (e.kind !== "building" || e.jammedUntil === undefined || world.tick >= e.jammedUntil || !frame.shows(e, e.x, e.y)) continue;
      const flicker = 0.5 + 0.5 * Math.abs(Math.sin(t * 23 + e.id));
      this.rings.add(e.x, ground(e.x, e.y), e.y, (e.footprint * TILE) / 2 + 14, 0xf87171, flicker);
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
