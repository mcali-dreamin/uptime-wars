// Transient things drawn over the world: bolts in flight, sparks and
// explosions, health bars, and the ground rings for selection, range,
// network reach, rally flags, and order pings. All pooled: nothing here
// allocates per frame once warmed up.

import * as THREE from "three";

const MAX_BOLTS = 600;
const MAX_PARTICLES = 3000;
const MAX_BARS = 700;
const MAX_RINGS = 700;

/** Bolts: short glowing streaks that travel from shooter to target. */
export class Bolts {
  readonly mesh: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3(0, 0, 1);
  private readonly color = new THREE.Color();
  private count = 0;

  constructor() {
    const geometry = new THREE.BoxGeometry(1.6, 1.6, 1);
    const material = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_BOLTS);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOLTS * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  begin(): void {
    this.count = 0;
  }

  /** A bolt `t` (0..1) of the way from a to b, in team colour. */
  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, color: number): void {
    if (this.count >= MAX_BOLTS) return;
    this.dir.set(bx - ax, by - ay, bz - az);
    const length = this.dir.length();
    if (length < 1) return;
    this.dir.divideScalar(length);
    const streak = Math.min(length, 26);
    const head = Math.min(1, t * 1.25);
    this.p.set(ax, ay, az).addScaledVector(this.dir, head * length - streak / 2);
    this.q.setFromUnitVectors(this.fwd, this.dir);
    this.s.set(1, 1, streak);
    this.mesh.setMatrixAt(this.count, this.m.compose(this.p, this.q, this.s));
    this.mesh.setColorAt(this.count, this.color.setHex(color).multiplyScalar(2.4));
    this.count += 1;
  }

  end(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/** Sparks, embers, and explosions. Points with additive blending, simulated on the CPU. */
export class Particles {
  readonly points: THREE.Points;
  private readonly position = new Float32Array(MAX_PARTICLES * 3);
  private readonly color = new Float32Array(MAX_PARTICLES * 3);
  private readonly size = new Float32Array(MAX_PARTICLES);
  private readonly velocity = new Float32Array(MAX_PARTICLES * 3);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly base = new Float32Array(MAX_PARTICLES * 3);
  private next = 0;
  private readonly tmp = new THREE.Color();

  constructor() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.position, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(this.color, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(this.size, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float size; attribute vec3 color; varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (900.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(vColor * (1.0 - d * 2.0), 1.0);
        }`,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
  }

  /** A burst of `count` sparks at a point. `power` scales speed and size. */
  burst(x: number, y: number, z: number, count: number, color: number, power = 1): void {
    this.tmp.setHex(color);
    for (let n = 0; n < count; n += 1) {
      const i = this.next;
      this.next = (this.next + 1) % MAX_PARTICLES;
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      const speed = (40 + Math.random() * 140) * power;
      this.position.set([x, y, z], i * 3);
      this.velocity.set([Math.cos(a) * speed * (1 - up * 0.5), (40 + up * 160) * power, Math.sin(a) * speed * (1 - up * 0.5)], i * 3);
      const life = 0.35 + Math.random() * 0.5 * power;
      this.life[i] = life;
      this.maxLife[i] = life;
      this.size[i] = (2 + Math.random() * 3) * power;
      const k = 1.5 + Math.random();
      this.base.set([this.tmp.r * k, this.tmp.g * k, this.tmp.b * k], i * 3);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      if (this.life[i]! <= 0) {
        if (this.size[i] !== 0) {
          this.size[i] = 0;
          this.color.fill(0, i * 3, i * 3 + 3);
        }
        continue;
      }
      this.life[i]! -= dt;
      const v = i * 3;
      this.velocity[v + 1]! -= 420 * dt;
      for (let k = 0; k < 3; k += 1) this.position[v + k]! += this.velocity[v + k]! * dt;
      if (this.position[v + 1]! < 0) this.position[v + 1] = 0;
      const fade = Math.max(0, this.life[i]! / this.maxLife[i]!);
      for (let k = 0; k < 3; k += 1) this.color[v + k] = this.base[v + k]! * fade;
    }
    const g = this.points.geometry;
    g.getAttribute("position").needsUpdate = true;
    g.getAttribute("color").needsUpdate = true;
    g.getAttribute("size").needsUpdate = true;
  }
}

/** Health bars: camera-facing quads, a dark back and a coloured fill. */
export class Bars {
  readonly group = new THREE.Group();
  private readonly back: THREE.InstancedMesh;
  private readonly fill: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private count = 0;
  private quaternion = new THREE.Quaternion();
  private right = new THREE.Vector3();

  constructor() {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const make = (color: number, order: number) => {
      const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, toneMapped: false }), MAX_BARS);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      mesh.count = 0;
      return mesh;
    };
    this.back = make(0x0b1018, 10);
    this.fill = make(0xffffff, 11);
    this.fill.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BARS * 3), 3);
    this.group.add(this.back, this.fill);
  }

  begin(camera: THREE.Camera): void {
    this.count = 0;
    this.quaternion.copy(camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion);
  }

  add(x: number, y: number, z: number, width: number, ratio: number): void {
    if (this.count >= MAX_BARS) return;
    const r = Math.max(0, Math.min(1, ratio));
    this.p.set(x, y, z);
    this.s.set(width + 2, 5, 1);
    this.back.setMatrixAt(this.count, this.m.compose(this.p, this.quaternion, this.s));
    this.offset.copy(this.right).multiplyScalar((-width * (1 - r)) / 2);
    this.p.add(this.offset);
    this.s.set(Math.max(0.01, width * r), 3, 1);
    this.fill.setMatrixAt(this.count, this.m.compose(this.p, this.quaternion, this.s));
    this.fill.setColorAt(this.count, this.color.setHex(r > 0.5 ? 0x4ade80 : r > 0.25 ? 0xfacc15 : 0xf87171));
    this.count += 1;
  }

  end(): void {
    for (const mesh of [this.back, this.fill]) {
      mesh.count = this.count;
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.fill.instanceColor) this.fill.instanceColor.needsUpdate = true;
  }
}

/** Flat rings on the ground (selection, ranges, network reach, pings). */
export class Rings {
  readonly mesh: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private count = 0;

  /** `inner`: the ring's inner radius as a share of its outer one (thickness scales with size). */
  constructor(inner: number) {
    const geometry = new THREE.RingGeometry(inner, 1, 96);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_RINGS);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.count = 0;
  }

  begin(): void {
    this.count = 0;
  }

  /** Brightness stands in for opacity (additive-ish over dark ground). */
  add(x: number, y: number, z: number, radius: number, color: number, strength: number): void {
    if (this.count >= MAX_RINGS || radius <= 0) return;
    this.p.set(x, y, z);
    this.s.set(radius, radius, 1);
    this.mesh.setMatrixAt(this.count, this.m.compose(this.p, this.q, this.s));
    this.mesh.setColorAt(this.count, this.color.setHex(color).multiplyScalar(strength));
    this.count += 1;
  }

  end(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
