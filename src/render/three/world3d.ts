// A Three.js view of the world: the same simulation, drawn in 3D with a
// WC3-style angled camera. Render-only, like the 2D renderer; the Pixi
// renderer keeps the minimap, banner, and fog bookkeeping and hands us each
// frame (see WorldView in ../renderer.ts).
//
// Units: x and z are world pixels (z = the sim's y), y is height.

import * as THREE from "three";
import { TILE, TILE_BLOCKED, TILE_CLIFF, TILE_RAMP, networkProviders, type Entity, type Point, type Terrain, type World } from "../../sim";
import { PING_MS, SHOT_TTL_MS, TEAM_COLORS, type Frame, type WorldView } from "../renderer";
import { tileColor } from "../terrain-art";

/** Height of one level step, in world units. */
const STEP = 40;
/** Floor slab thickness at level 0. */
const BASE = 6;
/** How far dead links rise above their surroundings. */
const WALL_RISE = 26;
/** Camera: distance at zoom 1, and pitch above the horizon. */
const DISTANCE = 950;
const PITCH = (58 * Math.PI) / 180;
/** Fog brightness for explored-but-not-visible and unexplored tiles. */
const FOG_EXPLORED = 0.42;
const FOG_HIDDEN = 0.05;
const SELECT = 0xfacc15;

const BUILDING_HEIGHT: Record<string, number> = {
  core: 70,
  "malware-nest": 60,
  firewall: 56,
  "cdn-edge": 62,
  "mesh-node": 24,
  "edge-pop": 40,
};

export class World3D implements WorldView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 10, 60000);
  private readonly raycaster = new THREE.Raycaster();
  private terrain: Terrain | null = null;
  private tiles: THREE.InstancedMesh | null = null;
  private baseColors: Float32Array | null = null;
  private fogVersion = -1;
  private readonly wells = new THREE.Group();
  private readonly entities = new Map<number, THREE.Object3D>();
  private readonly overlay = new THREE.Group();
  private readonly shotLines: THREE.LineSegments;
  private readonly materials = new Map<string, THREE.Material>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(0x05080b);
    const canvas = this.renderer.domElement;
    canvas.style.pointerEvents = "none";
    host.insertBefore(canvas, host.firstChild);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-0.5, 1, 0.35);
    this.scene.add(sun);

    this.shotLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }),
    );
    this.scene.add(this.wells, this.overlay, this.shotLines);
  }

  // --- WorldView ------------------------------------------------------------

  setWorld(world: World): void {
    this.terrain = world.terrain;
    for (const object of this.entities.values()) this.scene.remove(object);
    this.entities.clear();
    this.buildTerrain(world.terrain);
    this.fogVersion = -1;
  }

  draw(frame: Frame): void {
    if (!this.terrain) return;
    this.placeCamera(frame);
    this.applyFog(frame);
    this.syncEntities(frame);
    this.drawOverlay(frame);
    this.drawShots(frame);
    this.renderer.render(this.scene, this.camera);
  }

  pick(x: number, y: number): Point | null {
    const terrain = this.terrain;
    if (!terrain) return null;
    const { width, height } = this.size();
    this.raycaster.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), this.camera);
    const ray = this.raycaster.ray;
    // Try each floor level from the top down; the first hit that lands on a
    // tile of that level is what's under the pointer.
    for (let level = 2; level >= 0; level -= 1) {
      const hit = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorTop(level)), new THREE.Vector3());
      if (!hit) continue;
      const col = Math.floor(hit.x / TILE);
      const row = Math.floor(hit.z / TILE);
      if (col < 0 || row < 0 || col >= terrain.cols || row >= terrain.rows) continue;
      if (terrain.heights[row * terrain.cols + col] === level || level === 0) return { x: hit.x, y: hit.z };
    }
    return null;
  }

  viewRect() {
    const { width, height } = this.size();
    // The ground plane, unclamped: top corners can look past the map edge.
    const ground = (x: number, y: number): Point | null => {
      this.raycaster.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), this.camera);
      const hit = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      return hit ? { x: hit.x, y: hit.z } : null;
    };
    const corners = [ground(0, 0), ground(width, 0), ground(0, height), ground(width, height)].filter(
      (p): p is Point => p !== null,
    );
    if (corners.length === 0 || !this.terrain) return null;
    const w = this.terrain.cols * TILE;
    const h = this.terrain.rows * TILE;
    const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
    return {
      left: clamp(Math.min(...corners.map((p) => p.x)), w),
      right: clamp(Math.max(...corners.map((p) => p.x)), w),
      top: clamp(Math.min(...corners.map((p) => p.y)), h),
      bottom: clamp(Math.max(...corners.map((p) => p.y)), h),
    };
  }

  // --- terrain --------------------------------------------------------------

  /** One box per tile in a single instanced mesh; height encodes the level. */
  private buildTerrain(terrain: Terrain): void {
    if (this.tiles) {
      this.scene.remove(this.tiles);
      this.tiles.geometry.dispose();
    }
    const count = terrain.cols * terrain.rows;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), count);
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    this.baseColors = new Float32Array(count * 3);
    for (let row = 0; row < terrain.rows; row += 1) {
      for (let col = 0; col < terrain.cols; col += 1) {
        const i = row * terrain.cols + col;
        const top = tileTop(terrain, i);
        matrix.makeScale(TILE, top, TILE).setPosition((col + 0.5) * TILE, top / 2, (row + 0.5) * TILE);
        mesh.setMatrixAt(i, matrix);
        color.setHex(tileColor(terrain.tiles[i]!, terrain.heights[i]!));
        // Lift the floor colours a touch so lighting doesn't crush them.
        color.multiplyScalar(1.6);
        color.toArray(this.baseColors, i * 3);
        mesh.setColorAt(i, color);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.tiles = mesh;
    this.scene.add(mesh);

    this.wells.clear();
    const well = new THREE.OctahedronGeometry(12);
    const wellMaterial = new THREE.MeshLambertMaterial({ color: 0x38bdf8, emissive: 0x0b3a52 });
    for (const node of terrain.resources) {
      const i = node.row * terrain.cols + node.col;
      const gem = new THREE.Mesh(well, wellMaterial);
      gem.position.set((node.col + 0.5) * TILE, tileTop(terrain, i) + 16, (node.row + 0.5) * TILE);
      gem.userData.tile = i;
      this.wells.add(gem);
    }
  }

  /** Darken tiles by fog state. Only when the fog actually changed. */
  private applyFog(frame: Frame): void {
    const { tiles, baseColors, terrain } = this;
    if (!tiles || !baseColors || !terrain || frame.fog.version === this.fogVersion) return;
    this.fogVersion = frame.fog.version;
    const colors = tiles.instanceColor!.array as Float32Array;
    for (let i = 0; i < terrain.tiles.length; i += 1) {
      const state = frame.fog.stateAt(i);
      const k = state === 2 ? 1 : state === 1 ? FOG_EXPLORED : FOG_HIDDEN;
      colors[i * 3] = baseColors[i * 3]! * k;
      colors[i * 3 + 1] = baseColors[i * 3 + 1]! * k;
      colors[i * 3 + 2] = baseColors[i * 3 + 2]! * k;
    }
    tiles.instanceColor!.needsUpdate = true;
    for (const gem of this.wells.children) gem.visible = frame.fog.stateAt(gem.userData.tile as number) > 0;
  }

  // --- camera ---------------------------------------------------------------

  /** Follow the 2D camera: same center point and zoom, seen from an angle. */
  private placeCamera(frame: Frame): void {
    const { camera } = frame;
    const target = new THREE.Vector3(camera.x, this.groundAt(camera.x, camera.y), camera.y);
    const distance = DISTANCE / camera.zoom;
    this.camera.position.set(target.x, target.y + distance * Math.sin(PITCH), target.z + distance * Math.cos(PITCH));
    this.camera.lookAt(target);
  }

  // --- entities -------------------------------------------------------------

  private syncEntities(frame: Frame): void {
    const seen = new Set<number>();
    const t = performance.now() / 1000;
    for (const entity of frame.world.entities) {
      const at = frame.position(entity);
      if (!frame.shows(entity, at.x, at.y)) continue;
      seen.add(entity.id);
      let object = this.entities.get(entity.id);
      if (!object) {
        object = this.makeEntity(entity);
        this.entities.set(entity.id, object);
        this.scene.add(object);
      }
      const ground = this.groundAt(at.x, at.y);
      object.position.set(at.x, ground, at.y);
      if (entity.kind === "unit" && entity.mode === "builder") {
        object.position.y += 14 + Math.sin(t * 3) * 3;
        object.rotation.y = t;
      }
      if (entity.kind === "building") {
        const building = entity.buildRemaining > 0;
        object.scale.y = building ? Math.max(0.15, entity.hp / entity.maxHp) : 1;
      }
    }
    for (const [id, object] of this.entities) {
      if (seen.has(id)) continue;
      this.scene.remove(object);
      this.entities.delete(id);
    }
  }

  private makeEntity(entity: Entity): THREE.Object3D {
    const team = TEAM_COLORS[entity.team];
    if (entity.kind === "unit") {
      if (entity.mode === "builder") {
        const mesh = new THREE.Mesh(this.geometry("builder", () => new THREE.OctahedronGeometry(entity.radius + 4)), this.material(`glow-${team}`, () => new THREE.MeshLambertMaterial({ color: team, emissive: team, emissiveIntensity: 0.4 })));
        return mesh;
      }
      const r = entity.radius;
      const geometry = this.geometry(`unit-${r}`, () => {
        const g = new THREE.CylinderGeometry(r * 0.8, r, r * 1.8, 12);
        g.translate(0, r * 0.9, 0);
        return g;
      });
      return new THREE.Mesh(geometry, this.material(`unit-${team}`, () => new THREE.MeshLambertMaterial({ color: team })));
    }
    const size = entity.footprint * TILE - 6;
    const height = BUILDING_HEIGHT[entity.defId] ?? 34;
    const group = new THREE.Group();
    const bodyGeometry = this.geometry(`body-${size}-${height}`, () => {
      const g = new THREE.BoxGeometry(size, height, size);
      g.translate(0, height / 2, 0);
      return g;
    });
    const body = new THREE.Mesh(bodyGeometry, this.material("body", () => new THREE.MeshLambertMaterial({ color: 0x1c2733 })));
    const capGeometry = this.geometry(`cap-${size}-${height}`, () => {
      const g = new THREE.BoxGeometry(size * 0.7, 4, size * 0.7);
      g.translate(0, height + 2, 0);
      return g;
    });
    const cap = new THREE.Mesh(capGeometry, this.material(`glow-${team}`, () => new THREE.MeshLambertMaterial({ color: team, emissive: team, emissiveIntensity: 0.4 })));
    group.add(body, cap);
    return group;
  }

  // --- overlay: selection, rally, placement, pings --------------------------

  private drawOverlay(frame: Frame): void {
    for (const child of this.overlay.children) (child as THREE.Mesh).geometry?.dispose();
    this.overlay.clear();
    const { world, content } = frame;

    if (frame.selectedId !== null) {
      const selected = world.entities.find((e) => e.id === frame.selectedId);
      if (selected) {
        const at = frame.position(selected);
        const radius = selected.kind === "building" ? (selected.footprint * TILE) / 2 + 8 : selected.radius + 10;
        this.overlay.add(this.ring(at.x, at.y, radius - 2.5, radius, SELECT, 0.95));
        if (selected.kind === "building") {
          const team = world.teams[selected.team];
          const core = selected.defId === content.races[team.raceId]!.core;
          if (core || content.buildings[selected.defId]!.spawn) {
            const rally = (core ? team.rally : selected.rally) ?? team.rally;
            if (rally) this.overlay.add(this.flag(at, rally));
          }
        }
      }
    }

    if (frame.ghost) {
      for (const provider of networkProviders(world, content, 0)) {
        const reach = content.buildings[provider.defId]!.buildRadius! * TILE;
        this.overlay.add(this.ring(provider.x, provider.y, reach - 3, reach, 0x4ade80, 0.35));
      }
      const g = frame.ghost;
      const size = g.footprint * TILE;
      const cx = g.col * TILE + size / 2;
      const cz = g.row * TILE + size / 2;
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(size - 4, 30, size - 4),
        new THREE.MeshBasicMaterial({ color: g.valid ? 0x4ade80 : 0xf87171, transparent: true, opacity: 0.4 }),
      );
      box.position.set(cx, this.groundAt(cx, cz) + 15, cz);
      this.overlay.add(box);
      if (g.range > 0) this.overlay.add(this.ring(cx, cz, g.range + size / 2 - 2, g.range + size / 2, SELECT, 0.6));
    }

    for (const ping of frame.pings) {
      const t = ping.age / PING_MS;
      const r = 28 * (1 - t) + 6;
      this.overlay.add(this.ring(ping.x, ping.y, r - 3, r, SELECT, 1 - t));
    }
  }

  private ring(x: number, z: number, inner: number, outer: number, color: number, opacity: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0, inner), outer, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, this.groundAt(x, z) + 2, z);
    return mesh;
  }

  private flag(from: Point, to: Point): THREE.Object3D {
    const group = new THREE.Group();
    const y1 = this.groundAt(from.x, from.y) + 4;
    const y2 = this.groundAt(to.x, to.y);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(from.x, y1, from.y), new THREE.Vector3(to.x, y2 + 4, to.y)]),
      new THREE.LineBasicMaterial({ color: SELECT, transparent: true, opacity: 0.6 }),
    );
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 36, 6), new THREE.MeshBasicMaterial({ color: SELECT }));
    pole.position.set(to.x, y2 + 18, to.y);
    const banner = new THREE.Mesh(new THREE.ConeGeometry(7, 18, 3), new THREE.MeshBasicMaterial({ color: SELECT }));
    banner.rotation.z = -Math.PI / 2;
    banner.position.set(to.x + 9, y2 + 30, to.y);
    group.add(line, pole, banner);
    return group;
  }

  private drawShots(frame: Frame): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();
    for (const shot of frame.shots) {
      if (!frame.fog.isVisible(shot.x1, shot.y1) && !frame.fog.isVisible(shot.x2, shot.y2)) continue;
      const fade = Math.max(0, 1 - shot.age / SHOT_TTL_MS);
      positions.push(shot.x1, this.groundAt(shot.x1, shot.y1) + 18, shot.y1, shot.x2, this.groundAt(shot.x2, shot.y2) + 12, shot.y2);
      color.setHex(TEAM_COLORS[shot.team]).multiplyScalar(fade);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    const geometry = this.shotLines.geometry;
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  }

  // --- helpers --------------------------------------------------------------

  /** Top surface height at a world point. */
  private groundAt(x: number, y: number): number {
    const terrain = this.terrain;
    if (!terrain) return 0;
    const col = Math.min(terrain.cols - 1, Math.max(0, Math.floor(x / TILE)));
    const row = Math.min(terrain.rows - 1, Math.max(0, Math.floor(y / TILE)));
    const i = row * terrain.cols + col;
    // Units stand on floors; over a wall or cliff edge, use the level itself.
    return terrain.tiles[i] === TILE_BLOCKED ? floorTop(terrain.heights[i]!) : tileTop(terrain, i);
  }

  private geometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let geometry = this.geometries.get(key);
    if (!geometry) this.geometries.set(key, (geometry = make()));
    return geometry;
  }

  private material(key: string, make: () => THREE.Material): THREE.Material {
    let material = this.materials.get(key);
    if (!material) this.materials.set(key, (material = make()));
    return material;
  }

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
  }
}

function floorTop(level: number): number {
  return BASE + level * STEP;
}

/** Height of a tile's top surface. */
function tileTop(terrain: Terrain, i: number): number {
  const level = terrain.heights[i]!;
  switch (terrain.tiles[i]) {
    case TILE_BLOCKED:
      return floorTop(level) + WALL_RISE;
    case TILE_RAMP:
      // Halfway between the level below and this one.
      return floorTop(level) - STEP / 2;
    case TILE_CLIFF:
      return floorTop(level);
    default:
      return floorTop(level);
  }
}
