// The web as WC3-style terrain: terraced plateaus with steep rock cliffs,
// ramps you can see, and doodads that say what each tile is.
//
// - Ground is one heightfield, two vertices per tile, split into chunks so
//   the camera and the shadow pass skip what they can't see.
// - 2075: the map is one arcology. Height levels read by material, not
//   shade alone: the deep web is the undercity, black wet glass with violet
//   neon traces; the surface web a graphite hex deck with cyan seams; the
//   backbone pale titanium plating with light strips. Cliffs are monolith
//   walls with light bands; ramps are lit gateways with amber chevrons.
// - Dead links are derelict server towers, their status lights dead red.
//
// Everything is drawn from the terrain alone, so it is a pure function of
// the seed, like the map itself.

import * as THREE from "three";
import { TILE, TILE_BLOCKED, TILE_CLIFF, TILE_OPEN, TILE_RAMP, type Terrain } from "../../sim";
import type { FogTexture } from "./fog3d";
import { NETWORK_GLSL_EMISSIVE, NETWORK_GLSL_HEAD, type NetworkOverlay } from "./network3d";

/** Height of one level step, in world units (a tile is 48). */
export const STEP = 44;
/** Ground height at level 0. */
export const BASE = 0;
const CHUNK = 40;
/** Vertices per tile edge. */
const SUB = 2;

export function floorTop(level: number): number {
  return BASE + level * STEP;
}

/** A stable per-tile random number in [0, 1). */
export function hash01(a: number, b = 0): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class Terrain3D {
  readonly group = new THREE.Group();
  /** Ground chunks, for picking. */
  readonly chunks: THREE.Mesh[] = [];
  private heights = new Float32Array(0);
  private vw = 0;
  private vh = 0;
  private terrain: Terrain | null = null;
  private readonly groundMaterial: THREE.MeshStandardMaterial;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(
    private readonly fog: FogTexture,
    network: NetworkOverlay,
  ) {
    this.groundMaterial = fog.apply(
      new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.05, color: 0xffffff }),
      { key: "ground", patch: patchGround, uniforms: network.uniforms },
    );
  }

  build(terrain: Terrain): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.chunks.length = 0;
    this.terrain = terrain;
    this.computeHeights(terrain);
    this.buildGround(terrain);
    this.buildShards(terrain);
    this.buildDoodads(terrain);
    this.buildVoid(terrain);
  }

  /** Ground height at a world point (bilinear over the heightfield). */
  heightAt(x: number, y: number): number {
    if (!this.terrain) return 0;
    const fx = Math.min(this.vw - 1.001, Math.max(0, (x / TILE) * SUB));
    const fy = Math.min(this.vh - 1.001, Math.max(0, (y / TILE) * SUB));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const h = this.heights;
    const i = y0 * this.vw + x0;
    const top = h[i]! * (1 - tx) + h[i + 1]! * tx;
    const bottom = h[i + this.vw]! * (1 - tx) + h[i + this.vw + 1]! * tx;
    return top * (1 - ty) + bottom * ty;
  }

  /** The floor a walker on this tile stands on (flat on plateaus, sloped on ramps). */
  floorAt(x: number, y: number): number {
    const terrain = this.terrain;
    if (!terrain) return 0;
    const col = Math.min(terrain.cols - 1, Math.max(0, Math.floor(x / TILE)));
    const row = Math.min(terrain.rows - 1, Math.max(0, Math.floor(y / TILE)));
    const i = row * terrain.cols + col;
    const tile = terrain.tiles[i];
    if (tile === TILE_RAMP) return this.heightAt(x, y);
    return floorTop(terrain.heights[i]!);
  }

  // --- heightfield ----------------------------------------------------------

  /**
   * One height per vertex from the tiles that touch it. A vertex takes the
   * lowest of them, so a cliff tile (the high edge of a plateau) drops to the
   * low ground across its own far edge: walls are steep and every walkable
   * tile stays flat. Ramps run from the low floor up to the high one.
   */
  private computeHeights(terrain: Terrain): void {
    const { cols, rows, tiles, heights } = terrain;
    this.vw = cols * SUB + 1;
    this.vh = rows * SUB + 1;
    const out = new Float32Array(this.vw * this.vh);
    const touched: number[] = [];
    for (let vy = 0; vy < this.vh; vy += 1) {
      for (let vx = 0; vx < this.vw; vx += 1) {
        touched.length = 0;
        const cs = vx % SUB === 0 ? [vx / SUB - 1, vx / SUB] : [Math.floor(vx / SUB)];
        const rs = vy % SUB === 0 ? [vy / SUB - 1, vy / SUB] : [Math.floor(vy / SUB)];
        for (const r of rs) for (const c of cs) if (c >= 0 && r >= 0 && c < cols && r < rows) touched.push(r * cols + c);
        out[vy * this.vw + vx] = vertexHeight(tiles, heights, touched);
      }
    }
    this.heights = out;
  }

  private buildGround(terrain: Terrain): void {
    const { cols, rows } = terrain;
    const normals = this.computeNormals();
    const shade = this.computeShade();
    for (let cy = 0; cy < rows; cy += CHUNK) {
      for (let cx = 0; cx < cols; cx += CHUNK) {
        const c1 = Math.min(cols, cx + CHUNK);
        const r1 = Math.min(rows, cy + CHUNK);
        const w = (c1 - cx) * SUB + 1;
        const h = (r1 - cy) * SUB + 1;
        const position = new Float32Array(w * h * 3);
        const normal = new Float32Array(w * h * 3);
        const kind = new Float32Array(w * h * 3);
        const shading = new Float32Array(w * h * 2);
        for (let j = 0; j < h; j += 1) {
          for (let i = 0; i < w; i += 1) {
            const vx = cx * SUB + i;
            const vy = cy * SUB + j;
            const v = vy * this.vw + vx;
            const k = (j * w + i) * 3;
            position[k] = (vx * TILE) / SUB;
            position[k + 1] = this.heights[v]!;
            position[k + 2] = (vy * TILE) / SUB;
            normal[k] = normals[v * 3]!;
            normal[k + 1] = normals[v * 3 + 1]!;
            normal[k + 2] = normals[v * 3 + 2]!;
            // Kind weights from the tile(s) this vertex touches: (unused), ramp, dead ground.
            kind.set(kindAround(terrain, vx, vy), k);
            shading[(j * w + i) * 2] = shade[v * 2]!;
            shading[(j * w + i) * 2 + 1] = shade[v * 2 + 1]!;
          }
        }
        const index: number[] = [];
        for (let j = 0; j < h - 1; j += 1) {
          for (let i = 0; i < w - 1; i += 1) {
            const a = j * w + i;
            const b = a + 1;
            const c = a + w;
            const d = c + 1;
            index.push(a, c, b, b, c, d);
          }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
        geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
        geometry.setAttribute("aKind", new THREE.BufferAttribute(kind, 3));
        geometry.setAttribute("aShade", new THREE.BufferAttribute(shading, 2));
        geometry.setIndex(index);
        geometry.computeBoundingSphere();
        geometry.computeBoundingBox();
        const mesh = new THREE.Mesh(geometry, this.groundMaterial);
        mesh.receiveShadow = true;
        this.chunks.push(mesh);
        this.group.add(mesh);
        this.disposables.push(geometry);
      }
    }
  }

  /**
   * Two baked terms per vertex: occlusion (how much higher ground crowds it,
   * so the foot of a cliff sits in shade) and lip (the top edge of a drop, so
   * a plateau's rim catches a highlight). Both 0..1, from the heightfield.
   */
  private computeShade(): Float32Array {
    const { vw, vh, heights } = this;
    const out = new Float32Array(vw * vh * 2);
    const R = 5;
    for (let y = 0; y < vh; y += 1) {
      for (let x = 0; x < vw; x += 1) {
        const h0 = heights[y * vw + x]!;
        let occ = 0;
        let weight = 0;
        let lip = 0;
        for (let dy = -R; dy <= R; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= vh) continue;
          for (let dx = -R; dx <= R; dx += 1) {
            const nx = x + dx;
            if (nx < 0 || nx >= vw || (dx === 0 && dy === 0)) continue;
            const d = Math.hypot(dx, dy);
            if (d > R) continue;
            const rise = (heights[ny * vw + nx]! - h0) / STEP;
            const falloff = 1 - d / (R + 1);
            occ += Math.min(1, Math.max(0, rise)) * falloff;
            weight += falloff;
            if (d <= 1.5) lip = Math.max(lip, Math.min(1, Math.max(0, -rise)));
          }
        }
        out[(y * vw + x) * 2] = Math.min(1, (occ / weight) * 2.2);
        out[(y * vw + x) * 2 + 1] = lip;
      }
    }
    return out;
  }

  private computeNormals(): Float32Array {
    const { vw, vh, heights } = this;
    const out = new Float32Array(vw * vh * 3);
    const spacing = TILE / SUB;
    const v = new THREE.Vector3();
    for (let y = 0; y < vh; y += 1) {
      for (let x = 0; x < vw; x += 1) {
        const l = heights[y * vw + Math.max(0, x - 1)]!;
        const r = heights[y * vw + Math.min(vw - 1, x + 1)]!;
        const u = heights[Math.max(0, y - 1) * vw + x]!;
        const d = heights[Math.min(vh - 1, y + 1) * vw + x]!;
        v.set(l - r, 2 * spacing, u - d).normalize();
        out.set([v.x, v.y, v.z], (y * vw + x) * 3);
      }
    }
    return out;
  }

  // --- doodads --------------------------------------------------------------

  /** Dead links: a cluster of derelict server towers per blocked tile, a ruined skyline. */
  private buildShards(terrain: Terrain): void {
    const spots = tilesOf(terrain, (t) => t === TILE_BLOCKED);
    const towers = towerGeometry();
    const leds = ledGeometry();
    const body = this.fog.apply(
      new THREE.MeshStandardMaterial({ color: 0x1a1d26, roughness: 0.45, metalness: 0.75, emissive: 0x05060a }),
    );
    // Dead status lights: red, over the bloom threshold so a ruin glows faintly.
    const light = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff2a4a, emissiveIntensity: 1.6, roughness: 1 }));
    const mesh = new THREE.InstancedMesh(towers, body, spots.length);
    const lit = new THREE.InstancedMesh(leds, light, spots.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const e = new THREE.Euler();
    spots.forEach((i, n) => {
      const col = i % terrain.cols;
      const row = Math.floor(i / terrain.cols);
      const r1 = hash01(i, 1);
      const r2 = hash01(i, 2);
      const r3 = hash01(i, 3);
      const x = (col + 0.4 + r1 * 0.2) * TILE;
      const z = (row + 0.4 + r2 * 0.2) * TILE;
      p.set(x, this.heightAt(x, z) - 2, z);
      // Quarter turns keep the skyline on the grid; a slight lean says ruin.
      e.set((r3 - 0.5) * 0.08, Math.floor(r1 * 4) * (Math.PI / 2), (r2 - 0.5) * 0.08);
      q.setFromEuler(e);
      s.set(0.9 + r2 * 0.2, 0.6 + r3 * 0.8, 0.9 + r1 * 0.2);
      m.compose(p, q, s);
      mesh.setMatrixAt(n, m);
      lit.setMatrixAt(n, m);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.add(mesh, towers, body);
    this.add(lit, leds, light);
  }

  /** Street furniture: neon beacons in the undercity, floating data cubes on the deck, vents on the backbone. */
  private buildDoodads(terrain: Terrain): void {
    const kinds: { level: number; geometry: THREE.BufferGeometry; material: THREE.Material; chance: number }[] = [
      {
        level: 0,
        geometry: beaconGeometry(),
        material: this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x2a1a40, emissive: 0xa855f7, emissiveIntensity: 1.1, roughness: 0.4 })),
        chance: 0.035,
      },
      {
        level: 1,
        geometry: pixelGeometry(),
        material: this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x0e3a44, emissive: 0x22d3ee, emissiveIntensity: 0.9, roughness: 0.3, transparent: true, opacity: 0.85 })),
        chance: 0.04,
      },
      {
        level: 2,
        geometry: ventGeometry(),
        material: this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x8796a8, emissive: 0x38bdf8, emissiveIntensity: 0.15, roughness: 0.4, metalness: 0.7 })),
        chance: 0.03,
      },
    ];
    const m = new THREE.Matrix4();
    const s = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const kind of kinds) {
      const spots = tilesOf(terrain, (t, i) => t === TILE_OPEN && terrain.heights[i] === kind.level && hash01(i, 11 + kind.level) < kind.chance);
      const mesh = new THREE.InstancedMesh(kind.geometry, kind.material, spots.length);
      spots.forEach((i, n) => {
        const col = i % terrain.cols;
        const row = Math.floor(i / terrain.cols);
        const x = (col + 0.15 + hash01(i, 21) * 0.7) * TILE;
        const z = (row + 0.15 + hash01(i, 22) * 0.7) * TILE;
        p.set(x, floorTop(kind.level), z);
        q.setFromAxisAngle(up, hash01(i, 23) * Math.PI * 2);
        const size = 0.7 + hash01(i, 24) * 0.7;
        s.set(size, size, size);
        mesh.setMatrixAt(n, m.compose(p, q, s));
      });
      mesh.receiveShadow = true;
      this.add(mesh, kind.geometry, kind.material);
    }
  }

  /** Beyond the map: a dark void with a faint grid, so the edge reads as an edge. */
  private buildVoid(terrain: Terrain): void {
    const w = terrain.cols * TILE;
    const h = terrain.rows * TILE;
    const geometry = new THREE.PlaneGeometry(w * 4, h * 4);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(w / 2, -STEP * 1.5, h / 2);
    const material = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: /* glsl */ `varying vec3 vW; void main(){ vW = (modelMatrix*vec4(position,1.0)).xyz; gl_Position = projectionMatrix*viewMatrix*vec4(vW,1.0); }`,
      fragmentShader: /* glsl */ `varying vec3 vW; void main(){
        vec2 g = abs(fract(vW.xz / 192.0) - 0.5);
        float line = 1.0 - smoothstep(0.0, 0.012, min(g.x, g.y));
        gl_FragColor = vec4(vec3(0.012, 0.02, 0.035) + vec3(0.03, 0.08, 0.12) * line, 1.0);
      }`,
    });
    this.add(new THREE.Mesh(geometry, material), geometry, material);
  }

  private add(object: THREE.Object3D, ...disposables: { dispose(): void }[]): void {
    this.group.add(object);
    this.disposables.push(...disposables);
  }
}

// --- height rules -----------------------------------------------------------

function vertexHeight(tiles: Uint8Array, heights: Uint8Array, touched: number[]): number {
  if (touched.length === 0) return 0;
  const hasRamp = touched.some((i) => tiles[i] === TILE_RAMP);
  if (!hasRamp) {
    let min = Infinity;
    for (const i of touched) min = Math.min(min, floorTop(heights[i]!));
    return min;
  }
  // Ramps: the low floor at its foot, the high floor at its top, halfway between in the middle.
  const level = Math.max(...touched.filter((i) => tiles[i] === TILE_RAMP).map((i) => heights[i]!));
  let low = false;
  let high = false;
  for (const i of touched) {
    const t = tiles[i];
    if (t === TILE_RAMP || t === TILE_CLIFF || t === TILE_BLOCKED) continue;
    if (heights[i]! < level) low = true;
    else high = true;
  }
  if (low) return floorTop(level - 1);
  if (high) return floorTop(level);
  return floorTop(level) - STEP / 2;
}

/** (unused) / ramp / dead-ground weights for a vertex: the share of touching tiles of each kind. */
function kindAround(terrain: Terrain, vx: number, vy: number): [number, number, number] {
  const { cols, rows, tiles } = terrain;
  const cs = vx % SUB === 0 ? [vx / SUB - 1, vx / SUB] : [Math.floor(vx / SUB)];
  const rs = vy % SUB === 0 ? [vy / SUB - 1, vy / SUB] : [Math.floor(vy / SUB)];
  let n = 0;
  let ramp = 0;
  let dead = 0;
  for (const r of rs) {
    for (const c of cs) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const t = tiles[r * cols + c];
      n += 1;
      if (t === TILE_RAMP) ramp += 1;
      if (t === TILE_BLOCKED) dead += 1;
    }
  }
  return n === 0 ? [0, 0, 0] : [0, ramp / n, dead / n];
}

function tilesOf(terrain: Terrain, test: (tile: number, index: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < terrain.tiles.length; i += 1) if (test(terrain.tiles[i]!, i)) out.push(i);
  return out;
}

// --- doodad geometry --------------------------------------------------------

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Hand-rolled merge (non-indexed) so we don't pull in addons for terrain.
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  let count = 0;
  for (const g of flat) count += g.getAttribute("position").count;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  let offset = 0;
  for (const g of flat) {
    g.computeVertexNormals();
    position.set(g.getAttribute("position").array as Float32Array, offset * 3);
    normal.set(g.getAttribute("normal").array as Float32Array, offset * 3);
    offset += g.getAttribute("position").count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  return out;
}

/** Towers of one ruin: [x, z, width, depth, height], local to the tile's center. */
const TOWERS = [
  [0, 0, 18, 16, 64],
  [15, 9, 11, 12, 38],
  [-14, 7, 12, 11, 46],
  [5, -15, 12, 10, 28],
  [-10, -12, 9, 9, 20],
] as const;

function towerGeometry(): THREE.BufferGeometry {
  return merge(
    TOWERS.flatMap(([x, z, w, d, h]) => {
      const box = new THREE.BoxGeometry(w, h, d);
      box.translate(x, h / 2, z);
      // A cap a little narrower: a roof line, so towers aren't plain bricks.
      const cap = new THREE.BoxGeometry(w * 0.7, 2.5, d * 0.7);
      cap.translate(x, h + 1.25, z);
      return [box, cap];
    }),
  );
}

/** Status lights on each tower's face: a few short strips, most of them dead. */
function ledGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  TOWERS.forEach(([x, z, w, d, h], t) => {
    for (let y = 8; y < h - 4; y += 9) {
      if (hash01(t, y) < 0.45) continue;
      const strip = new THREE.BoxGeometry(w * (0.25 + hash01(t, y + 1) * 0.4), 1.2, 0.6);
      strip.translate(x - w * 0.15, y, z + d / 2 + 0.3);
      parts.push(strip);
    }
  });
  return merge(parts);
}

function beaconGeometry(): THREE.BufferGeometry {
  const mast = new THREE.CylinderGeometry(0.5, 0.9, 16, 5);
  mast.translate(0, 8, 0);
  const lamp = new THREE.OctahedronGeometry(2.2);
  lamp.translate(0, 17.5, 0);
  return merge([mast, lamp]);
}

function pixelGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, z, s] of [[0, 0, 4], [6, 2, 2.5], [-3, 5, 3], [3, -5, 2]] as const) {
    // Hovering a little above the deck: holograms, not litter.
    const g = new THREE.BoxGeometry(s, s, s);
    g.rotateY(0.6);
    g.rotateX(0.6);
    g.translate(x, 7 + s, z);
    parts.push(g);
  }
  return merge(parts);
}

function ventGeometry(): THREE.BufferGeometry {
  const base = new THREE.BoxGeometry(14, 3, 9);
  base.translate(0, 1.5, 0);
  const fin = new THREE.BoxGeometry(12, 2, 1.2);
  const fins = [-2.5, 0, 2.5].map((z) => fin.clone().translate(0, 3.5, z));
  return merge([base, ...fins]);
}

// --- ground shader ----------------------------------------------------------

const NOISE_GLSL = /* glsl */ `
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
  }
`;

// The ground shader replaces colour and emissive in the standard material.
const groundFragmentHead = /* glsl */ `
  varying vec3 vKind; varying vec3 vWN; varying vec2 vShade;
  ${NOISE_GLSL}
  vec3 levelColor(float lvl, float macro) {
    // Each level drifts between two related tones over large patches, so
    // open ground has regions instead of one flat colour.
    vec3 deep = mix(vec3(0.035, 0.025, 0.06), vec3(0.05, 0.022, 0.06), macro);
    vec3 surface = mix(vec3(0.07, 0.08, 0.1), vec3(0.08, 0.085, 0.105), macro);
    vec3 backbone = mix(vec3(0.19, 0.205, 0.235), vec3(0.165, 0.18, 0.21), macro);
    return lvl < 1.0 ? mix(deep, surface, smoothstep(0.6, 1.0, lvl)) : mix(surface, backbone, smoothstep(1.6, 2.0, lvl));
  }
  vec3 traceColor(float lvl) {
    return lvl < 0.5 ? vec3(0.75, 0.25, 1.0) : lvl < 1.5 ? vec3(0.1, 0.85, 0.95) : vec3(0.7, 0.85, 1.0);
  }
  /**
   * The deck's hex panels: x is how near the panel's edge (0 center, 0.5
   * edge), yz the panel's id, so a few panels can light up.
   */
  vec3 hexCell(vec2 p) {
    vec2 r = vec2(1.0, 1.7320508);
    vec2 h = r * 0.5;
    vec2 a = mod(p, r) - h;
    vec2 b = mod(p - h, r) - h;
    vec2 g = dot(a, a) < dot(b, b) ? a : b;
    vec2 q = abs(g);
    return vec3(max(dot(q, vec2(0.5, 0.8660254)), q.x), p - g);
  }
  /**
   * Circuit traces: long straight runs along the tile grid, a few tiles each,
   * with a pad where a run ends. Runs, not dashes, so it reads as wiring.
   */
  float traces(vec2 xz) {
    vec2 cell = floor(xz / 48.0);
    vec2 f = fract(xz / 48.0);
    // A run along x covers 6 cells of one row; along z, 6 cells of one column.
    float runX = floor(cell.x / 6.0);
    float runZ = floor(cell.y / 6.0);
    float hx = step(0.82, h21(vec2(runX, cell.y) + 0.17));
    float hz = step(0.84, h21(vec2(cell.x, runZ) + 3.71));
    float lx = (1.0 - smoothstep(0.015, 0.04, abs(f.y - 0.5))) * hx;
    float lz = (1.0 - smoothstep(0.015, 0.04, abs(f.x - 0.5))) * hz;
    float endX = hx * step(5.0, cell.x - runX * 6.0);
    float endZ = hz * step(5.0, cell.y - runZ * 6.0);
    float pad = (1.0 - smoothstep(0.07, 0.1, length(f - 0.5))) * max(endX, endZ);
    return max(max(lx, lz), pad);
  }
  /** Backbone plating: a square plate grid with bevelled seams. */
  float plates(vec2 xz) {
    vec2 f = abs(fract(xz / 96.0) - 0.5);
    return 1.0 - smoothstep(0.47, 0.49, max(f.x, f.y));
  }
`;

const GROUND_COLOR = /* glsl */ `
  {
    vec2 xz = vFogWorld.xz;
    float lvl = clamp((vFogWorld.y - ${BASE.toFixed(1)}) / ${STEP.toFixed(1)}, 0.0, 2.0);
    float macro = smoothstep(0.3, 0.7, vnoise(xz * 0.0035));
    float n = vnoise(xz * 0.015) * 0.5 + vnoise(xz * 0.06) * 0.3 + vnoise(xz * 0.25) * 0.2;
    vec3 col = levelColor(lvl, macro) * (0.7 + 0.6 * n);
    // Fine grit, so close-up ground isn't smooth plastic.
    col *= 0.92 + 0.16 * vnoise(xz * 0.9);
    if (lvl > 1.5) col *= mix(0.55, 1.0, plates(xz));
    // The deck: hex panels, their seams dark.
    float deck = smoothstep(0.6, 1.0, lvl) * (1.0 - smoothstep(1.4, 1.7, lvl));
    vec3 hex = hexCell(xz / 40.0);
    col *= mix(1.0, mix(0.45, 1.0, 1.0 - smoothstep(0.44, 0.48, hex.x)), deck);
    gHex = hex;
    gDeck = deck;
    // Ramps: paved gateway.
    vec3 paving = vec3(0.3, 0.26, 0.2) * (0.85 + 0.3 * vnoise(xz * 0.2));
    col = mix(col, paving, vKind.y);
    // Dead ground under the shards.
    col = mix(col, vec3(0.06, 0.055, 0.065), vKind.z * 0.8);
    // Cliffs: monolith walls, smooth panels with seams, by slope.
    float steep = 1.0 - smoothstep(0.5, 0.82, vWN.y);
    float seam = 1.0 - smoothstep(0.0, 0.04, abs(fract((xz.x + xz.y) / 42.0) - 0.5) - 0.44);
    vec3 wall = vec3(0.075, 0.08, 0.1) * (0.85 + 0.3 * vnoise(vec2(xz.x + xz.y, vFogWorld.y) * 0.02)) * (1.0 - 0.45 * seam);
    col = mix(col, wall, steep);
    // Baked shade: the foot of a cliff sits in shadow; a plateau's rim is lit.
    col *= mix(1.0, 0.4, vShade.x);
    col = mix(col, col * 1.35 + vec3(0.012), smoothstep(0.5, 1.0, vShade.y) * (1.0 - steep));
    diffuseColor.rgb = col;
    gTerrainSteep = steep;
    gTerrainLevel = lvl;
    // Surfaces: the undercity is wet glass (it mirrors the neon), the deck
    // satin composite, the backbone brushed titanium, walls polished stone.
    float wet = smoothstep(0.35, 0.65, vnoise(xz * 0.006));
    gRough = lvl < 0.5 ? mix(0.5, 0.26, wet) : lvl < 1.5 ? 0.62 : 0.72;
    gMetal = lvl < 0.5 ? 0.4 : lvl < 1.5 ? 0.25 : 0.3;
    gRough = mix(gRough, 0.3, steep);
    gMetal = mix(gMetal, 0.45, steep);
    gRough = mix(gRough, 0.9, max(vKind.y, vKind.z));
    gMetal = mix(gMetal, 0.1, max(vKind.y, vKind.z));
  }
`;

const GROUND_EMISSIVE = /* glsl */ `
  {
    vec2 xz = vFogWorld.xz;
    float flat_ = 1.0 - gTerrainSteep;
    float tr = traces(xz) * flat_ * (1.0 - vKind.y) * (1.0 - vKind.z);
    float strength = gTerrainLevel < 0.5 ? 0.16 : gTerrainLevel < 1.5 ? 0.2 : 0.13;
    totalEmissiveRadiance += traceColor(gTerrainLevel) * tr * strength * (1.0 - vShade.x);
    // A thin lit edge along each plateau's rim, in its level's colour.
    totalEmissiveRadiance += traceColor(gTerrainLevel) * smoothstep(0.7, 1.0, vShade.y) * flat_ * 0.05;
    // Light bands along the walls: one level line per step, broken into runs.
    float band = 1.0 - smoothstep(0.0, 0.05, abs(fract(vFogWorld.y / ${(STEP / 2).toFixed(1)}) - 0.5));
    totalEmissiveRadiance += vec3(0.35, 0.8, 1.0) * band * gTerrainSteep * 0.35 * step(0.45, vnoise(xz * 0.025));
    // The deck: a faint cyan line in every seam, and now and then a lit panel.
    float lit = step(0.985, h21(gHex.yz * 0.37 + 1.3));
    totalEmissiveRadiance += vec3(0.1, 0.85, 0.95) * gDeck * flat_ * (1.0 - vShade.x) * (1.0 - vKind.y) * (1.0 - vKind.z)
      * ((1.0 - smoothstep(0.455, 0.49, gHex.x)) * smoothstep(0.42, 0.455, gHex.x) * 0.06 + lit * (1.0 - smoothstep(0.38, 0.44, gHex.x)) * 0.06);
    // Ramp chevrons.
    float chev = step(0.6, fract((xz.x + xz.y) / 32.0));
    totalEmissiveRadiance += vec3(1.0, 0.65, 0.2) * chev * vKind.y * 0.18;
  }
`;

function patchGround(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nattribute vec3 aKind; attribute vec2 aShade; varying vec3 vKind; varying vec3 vWN; varying vec2 vShade;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvKind = aKind; vShade = aShade; vWN = normalize(objectNormal);");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${groundFragmentHead}\n${NETWORK_GLSL_HEAD}\nfloat gTerrainSteep = 0.0; float gTerrainLevel = 0.0; float gRough = 0.9; float gMetal = 0.05; vec3 gHex = vec3(0.0); float gDeck = 0.0;`)
    .replace("#include <color_fragment>", `#include <color_fragment>\n${GROUND_COLOR}`)
    .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = gMetal;")
    .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = gRough;")
    .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${GROUND_EMISSIVE}\n${NETWORK_GLSL_EMISSIVE}`);
}
