// Procedural models for every building and unit, built from primitives so
// there are no asset files to ship. Each kind is built once per colour as a
// template and cloned per entity (clones share geometry and materials).
//
// `team` below is always a team's colour (see teamColor in ../palette).
//
// The look: dark metal hardware with your team's colour as paint and light
// (it glows, and bloom picks it up). The botnet is the opposite: organic,
// spiky, red. Moving parts are tagged so the view can animate them.

import * as THREE from "three";
import { HORDE_COLOR } from "../palette";
import type { FogTexture } from "./fog3d";

export type Anim =
  | { type: "spin"; speed: number; axis: "x" | "y" | "z" }
  | { type: "bob"; amount: number; speed: number; base: number }
  | { type: "pulse"; amount: number; speed: number }
  | { type: "wiggle"; amount: number; speed: number; phase: number; base: number }
  | { type: "flicker" };

type Mat = "body" | "frame" | "trim" | "glow" | "screen" | "solar" | "flesh" | "hot" | "flame" | "dark";

export class Models {
  private readonly templates = new Map<string, THREE.Group>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly holograms = new Map<number, THREE.Material>();
  /** Shared animated materials (blinking LEDs, flames), keyed for update(). */
  private readonly blinking: THREE.MeshStandardMaterial[] = [];

  constructor(private readonly fog: FogTexture) {}

  /** A fresh instance of an entity's model. */
  make(defId: string, team: number, size: number, isUnit: boolean): THREE.Group {
    // Keyed by colour too: a new match may bring a new player colour.
    const key = `${defId}:${team}:${size}`;
    let template = this.templates.get(key);
    if (!template) {
      template = isUnit ? this.unit(defId, team, size) : this.building(defId, team);
      template.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });
      this.templates.set(key, template);
    }
    const copy = template.clone(true);
    // Clones share userData by reference; give each its own anim list.
    copy.traverse((node) => {
      if (node.userData.anim) node.userData = { ...node.userData };
    });
    return copy;
  }

  /** Translucent "being deployed" look for buildings under construction. */
  hologram(team: number): THREE.Material {
    const color = team;
    let material = this.holograms.get(color);
    if (!material) {
      material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.holograms.set(color, material);
    }
    return material;
  }

  /** Blink LEDs and flicker flames. Once per frame. */
  update(t: number): void {
    for (let i = 0; i < this.blinking.length; i += 1) {
      const m = this.blinking[i]!;
      m.emissiveIntensity = (m.userData.base as number) * (0.6 + 0.4 * Math.sin(t * (m.userData.speed as number) + i * 1.7));
    }
  }

  // --- materials ------------------------------------------------------------

  private mat(kind: Mat, team: number): THREE.Material {
    const color = team;
    const key = `${kind}:${color}`;
    let material = this.materials.get(key);
    if (material) return material;
    const standard = (p: THREE.MeshStandardMaterialParameters) => this.fog.apply(new THREE.MeshStandardMaterial(p));
    switch (kind) {
      case "body":
        material = standard({ color: 0x1b2431, metalness: 0.55, roughness: 0.45 });
        break;
      case "frame":
        material = standard({ color: 0x55657a, metalness: 0.75, roughness: 0.32 });
        break;
      case "dark":
        material = standard({ color: 0x0d1118, metalness: 0.4, roughness: 0.6 });
        break;
      case "trim":
        material = standard({ color, emissive: color, emissiveIntensity: 0.18, metalness: 0.4, roughness: 0.4 });
        break;
      case "glow": {
        const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.2, roughness: 0.3 });
        m.userData = { base: 2.2, speed: 2.2 };
        this.blinking.push(m);
        material = this.fog.apply(m);
        break;
      }
      case "screen":
        material = standard({ color: 0x0a1424, emissive: 0x3b82f6, emissiveIntensity: 1.3, roughness: 0.2 });
        break;
      case "solar":
        material = standard({ color: 0x1a2f6b, emissive: 0x0b1d4d, emissiveIntensity: 0.6, metalness: 0.85, roughness: 0.2 });
        break;
      case "flesh":
        material = standard({ color: 0x2a0b12, emissive: 0x4c0816, emissiveIntensity: 0.5, roughness: 0.55, metalness: 0.1, flatShading: true });
        break;
      case "hot": {
        const m = new THREE.MeshStandardMaterial({ color: 0xff3b4e, emissive: 0xff1f3d, emissiveIntensity: 2.6, roughness: 0.3 });
        m.userData = { base: 2.6, speed: 3.1 };
        this.blinking.push(m);
        material = this.fog.apply(m);
        break;
      }
      case "flame": {
        const m = new THREE.MeshStandardMaterial({ color: 0xffa040, emissive: 0xff7a1a, emissiveIntensity: 3, roughness: 0.4 });
        m.userData = { base: 3, speed: 9 };
        this.blinking.push(m);
        material = this.fog.apply(m);
        break;
      }
    }
    this.materials.set(key, material);
    return material;
  }

  // --- building blocks ------------------------------------------------------

  private box(g: THREE.Group, team: number, kind: Mat, w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d)), this.mat(kind, team));
    mesh.position.set(x, y + h / 2, z);
    g.add(mesh);
    return mesh;
  }

  private cyl(g: THREE.Group, team: number, kind: Mat, rTop: number, rBottom: number, h: number, sides: number, x = 0, y = 0, z = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(
      geometry(`cyl:${rTop}:${rBottom}:${h}:${sides}`, () => new THREE.CylinderGeometry(rTop, rBottom, h, sides)),
      this.mat(kind, team),
    );
    mesh.position.set(x, y + h / 2, z);
    g.add(mesh);
    return mesh;
  }

  private shape(g: THREE.Group, team: number, kind: Mat, key: string, make: () => THREE.BufferGeometry, x = 0, y = 0, z = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry(key, make), this.mat(kind, team));
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  }

  // --- buildings ------------------------------------------------------------

  private building(defId: string, team: number): THREE.Group {
    const g = new THREE.Group();
    switch (defId) {
      case "core": {
        this.box(g, team, "frame", 88, 8, 88);
        this.box(g, team, "body", 70, 46, 70, 0, 8);
        for (const y of [18, 30, 42]) this.box(g, team, "glow", 71.5, 2.2, 71.5, 0, y);
        this.box(g, team, "trim", 74, 3, 74, 0, 54);
        this.box(g, team, "frame", 40, 14, 40, 0, 57);
        this.cyl(g, team, "frame", 2, 3, 30, 6, 0, 71);
        const ring = this.shape(g, team, "glow", "torus:30", () => new THREE.TorusGeometry(30, 1.8, 8, 48), 0, 92, 0);
        ring.rotation.x = Math.PI / 2;
        anim(ring, { type: "spin", speed: 0.6, axis: "z" });
        const gem = this.shape(g, team, "glow", "octa:9", () => new THREE.OctahedronGeometry(9), 0, 104, 0);
        anim(gem, { type: "bob", amount: 4, speed: 1.6, base: 104 });
        break;
      }
      case "server-rack":
      case "hyperscale-rack": {
        const big = defId === "hyperscale-rack";
        const w = big ? 40 : 30;
        const h = big ? 60 : 52;
        const d = big ? 32 : 24;
        this.box(g, team, "frame", w + 4, 4, d + 4);
        this.box(g, team, "body", w, h, d, 0, 4);
        const rows = big ? 7 : 5;
        for (let i = 0; i < rows; i += 1) this.box(g, team, i % 2 ? "glow" : "trim", w - 8, 2, 1.5, 0, 10 + i * ((h - 12) / rows), d / 2 + 0.5);
        for (let i = 0; i < rows; i += 1) this.box(g, team, "glow", w - 8, 2, 1.5, 0, 10 + i * ((h - 12) / rows), -d / 2 - 0.5);
        this.box(g, team, "trim", w + 2, 3, d + 2, 0, h + 4);
        if (big) for (const x of [-12, 12]) this.cyl(g, team, "frame", 4, 4, 6, 8, x, h + 7, 0);
        break;
      }
      case "gpu-cluster": {
        this.box(g, team, "frame", 42, 4, 42);
        this.box(g, team, "body", 38, 18, 38, 0, 4);
        this.box(g, team, "glow", 39, 2, 39, 0, 14);
        for (const [x, z] of [[-10, -10], [10, -10], [-10, 10], [10, 10]] as const) {
          this.cyl(g, team, "dark", 8, 8, 3, 16, x, 22, z);
          const blades = this.shape(g, team, "trim", "fan", () => fanGeometry(7), x, 25.5, z);
          anim(blades, { type: "spin", speed: 9, axis: "y" });
        }
        break;
      }
      case "firewall":
      case "cdn-edge": {
        if (defId === "firewall") {
          this.cyl(g, team, "frame", 15, 19, 8, 6);
          this.cyl(g, team, "body", 11, 15, 40, 6, 0, 8);
          this.cyl(g, team, "trim", 16, 12, 5, 6, 0, 48);
          for (let i = 0; i < 3; i += 1) {
            const fin = this.box(g, team, "frame", 4, 30, 14, 0, 12, 0);
            fin.rotation.y = (i * Math.PI * 2) / 3;
            fin.translateX(13);
          }
          const flame = this.shape(g, team, "flame", "flame", () => new THREE.ConeGeometry(8, 22, 7), 0, 64, 0);
          anim(flame, { type: "pulse", amount: 0.18, speed: 11 });
          this.shape(g, team, "glow", "torus:12", () => new THREE.TorusGeometry(12, 1.5, 6, 24), 0, 54, 0).rotation.x = Math.PI / 2;
        } else {
          this.cyl(g, team, "frame", 14, 18, 8, 8);
          this.cyl(g, team, "body", 5, 8, 62, 8, 0, 8);
          for (const y of [24, 44]) this.cyl(g, team, "trim", 9, 9, 3, 8, 0, y);
          const globe = this.shape(g, team, "glow", "globe", () => new THREE.IcosahedronGeometry(16, 1), 0, 86, 0);
          (globe as THREE.Mesh).material = wireframe(team);
          anim(globe, { type: "spin", speed: 0.8, axis: "y" });
          this.shape(g, team, "glow", "sphere:6", () => new THREE.SphereGeometry(6, 12, 8), 0, 86, 0);
        }
        break;
      }
      case "solar-array":
      case "power-plant": {
        if (defId === "solar-array") {
          this.box(g, team, "frame", 40, 3, 40);
          for (const z of [-10, 10]) {
            this.cyl(g, team, "frame", 1.5, 1.5, 14, 6, 0, 3, z);
            const panel = this.box(g, team, "solar", 38, 2, 16, 0, 0, 0);
            panel.position.set(0, 18, z);
            panel.rotation.x = -0.45;
            const edge = this.box(g, team, "trim", 39, 1, 1, 0, 0, 0);
            edge.position.set(0, 18 + 3.5, z - 7.3);
            edge.rotation.x = -0.45;
          }
        } else {
          this.box(g, team, "frame", 42, 4, 42);
          this.shape(g, team, "body", "cooling", coolingTower, 0, 4, 0);
          const rim = this.shape(g, team, "glow", "torus:13", () => new THREE.TorusGeometry(13.5, 1.6, 6, 32), 0, 52, 0);
          rim.rotation.x = Math.PI / 2;
          this.box(g, team, "trim", 10, 14, 10, 15, 4, 15);
        }
        break;
      }
      case "web-app": {
        this.box(g, team, "frame", 40, 4, 40);
        this.box(g, team, "body", 32, 24, 28, 0, 4);
        this.box(g, team, "trim", 34, 2, 30, 0, 28);
        this.cyl(g, team, "frame", 1.5, 1.5, 16, 6, 0, 30);
        const screen = new THREE.Group();
        screen.position.y = 54;
        this.box(screen, team, "screen", 38, 24, 2, 0, -12);
        this.box(screen, team, "trim", 38, 4, 2.4, 0, 10);
        for (const x of [-15, -11, -7]) this.box(screen, team, "glow", 2.2, 2.2, 2.6, x, 10.9);
        for (const [y, w] of [[2, 26], [-3, 30], [-8, 20]] as const) this.box(screen, team, "frame", w, 1.4, 2.4, -2, y);
        anim(screen, { type: "bob", amount: 2.5, speed: 1.2, base: 54 });
        g.add(screen);
        break;
      }
      case "mesh-node":
      case "edge-pop": {
        if (defId === "mesh-node") {
          this.cyl(g, team, "frame", 8, 10, 4, 6);
          this.cyl(g, team, "frame", 1.6, 2.4, 34, 6, 0, 4);
          for (let i = 0; i < 4; i += 1) {
            const arm = new THREE.Group();
            arm.rotation.y = (i * Math.PI) / 2;
            this.box(arm, team, "frame", 12, 1.4, 1.4, 6, 24);
            this.shape(arm, team, "glow", "sphere:2.6", () => new THREE.SphereGeometry(2.6, 8, 6), 12, 25, 0);
            g.add(arm);
          }
          const top = this.shape(g, team, "glow", "sphere:4", () => new THREE.SphereGeometry(4, 10, 8), 0, 40, 0);
          anim(top, { type: "pulse", amount: 0.25, speed: 3 });
        } else {
          this.cyl(g, team, "frame", 20, 22, 8, 6);
          this.cyl(g, team, "body", 15, 19, 20, 6, 0, 8);
          this.cyl(g, team, "glow", 16, 16, 2, 6, 0, 22);
          const dish = this.shape(g, team, "frame", "dish", () => new THREE.SphereGeometry(13, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3), 0, 44, 0);
          dish.rotation.x = Math.PI + 0.5;
          anim(dish, { type: "spin", speed: 0.4, axis: "y" });
          this.cyl(g, team, "trim", 2, 2, 12, 6, 0, 28);
        }
        break;
      }
      case "data-pump": {
        // A derrick over the well: four legs around the crystals, a pumping
        // head on top, and a glowing pipe running down into the data.
        for (const [x, z] of [[-17, -17], [17, -17], [-17, 17], [17, 17]] as const) {
          const leg = this.box(g, team, "frame", 3, 62, 3, x * 0.82, 0, z * 0.82);
          leg.rotation.set(z > 0 ? -0.16 : 0.16, 0, x > 0 ? 0.16 : -0.16);
        }
        for (const y of [20, 42]) {
          const ring = this.shape(g, team, "trim", `pump-ring:${y}`, () => new THREE.TorusGeometry(y === 20 ? 16 : 11, 1.2, 6, 4), 0, y, 0);
          ring.rotation.set(Math.PI / 2, 0, Math.PI / 4);
        }
        this.box(g, team, "body", 18, 8, 18, 0, 58);
        this.box(g, team, "glow", 19, 1.6, 19, 0, 61);
        const head = new THREE.Group();
        head.position.y = 66;
        this.box(head, team, "frame", 30, 4, 5, 6, 0);
        this.box(head, team, "body", 8, 8, 8, 19, -2);
        g.add(head);
        const piston = this.cyl(g, team, "glow", 2.2, 2.2, 30, 8, 0, 28);
        anim(piston, { type: "bob", amount: 6, speed: 2.4, base: 28 });
        break;
      }
      case "c2-server": {
        // A spiked obelisk with a hot eye that watches the gateway.
        this.cyl(g, team, "flesh", 16, 20, 8, 5);
        this.shape(g, team, "flesh", "c2-spire", () => new THREE.ConeGeometry(10, 64, 5), 0, 40, 0);
        for (let i = 0; i < 5; i += 1) {
          const a = (i / 5) * Math.PI * 2;
          const spike = this.shape(g, team, "hot", "c2-spike", () => new THREE.ConeGeometry(2.5, 18, 4), Math.cos(a) * 12, 16, Math.sin(a) * 12);
          spike.rotation.set(Math.sin(a) * 0.7, 0, -Math.cos(a) * 0.7);
        }
        const eye = this.shape(g, team, "hot", "c2-eye", () => new THREE.OctahedronGeometry(6), 0, 50, 0);
        anim(eye, { type: "spin", speed: 1.8, axis: "y" });
        const halo = this.shape(g, team, "hot", "c2-halo", () => new THREE.TorusGeometry(11, 0.9, 6, 24), 0, 50, 0);
        halo.rotation.x = Math.PI / 2;
        anim(halo, { type: "pulse", amount: 0.2, speed: 3 });
        break;
      }
      case "malware-nest": {
        this.shape(g, team, "flesh", "nest", () => {
          const geo = new THREE.IcosahedronGeometry(36, 1);
          geo.scale(1.2, 0.6, 1.2);
          const pos = geo.getAttribute("position");
          for (let i = 0; i < pos.count; i += 1) {
            const k = 1 + 0.18 * Math.sin(i * 12.9898);
            pos.setXYZ(i, pos.getX(i) * k, Math.max(0, pos.getY(i) * k), pos.getZ(i) * k);
          }
          geo.computeVertexNormals();
          return geo;
        }, 0, 4, 0);
        for (let i = 0; i < 9; i += 1) {
          const a = (i / 9) * Math.PI * 2;
          const r = 26 + (i % 3) * 6;
          const spike = this.shape(g, team, i % 2 ? "flesh" : "hot", `spike:${i % 3}`, () => new THREE.ConeGeometry(4 + (i % 3), 30 + (i % 3) * 10, 5), Math.cos(a) * r, 22, Math.sin(a) * r);
          spike.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
        }
        const heart = this.shape(g, team, "hot", "heart", () => new THREE.IcosahedronGeometry(13, 0), 0, 34, 0);
        anim(heart, { type: "pulse", amount: 0.22, speed: 2.4 });
        break;
      }
      default:
        this.box(g, team, "body", 36, 30, 36);
        this.box(g, team, "glow", 37, 2, 37, 0, 24);
    }
    return g;
  }

  // --- units ----------------------------------------------------------------

  private unit(defId: string, team: number, r: number): THREE.Group {
    const g = new THREE.Group();
    switch (defId) {
      case "process": {
        this.shape(g, team, "trim", `capsule:${r}`, () => new THREE.CapsuleGeometry(r * 0.55, r * 0.8, 4, 8), 0, r * 0.95, 0);
        this.box(g, team, "body", r * 1.1, r * 0.75, r * 0.9, 0, r * 1.7);
        this.box(g, team, "glow", r * 0.9, r * 0.22, 0.6, 0, r * 1.95, r * 0.46);
        for (const x of [-1, 1]) this.box(g, team, "frame", r * 0.3, r * 0.6, r * 0.3, x * r * 0.75, r * 0.7);
        break;
      }
      case "inference-drone": {
        const hover = new THREE.Group();
        this.cyl(hover, team, "body", r * 0.9, r * 1.1, r * 0.5, 10, 0, -r * 0.25);
        this.shape(hover, team, "glow", `dome:${r}`, () => new THREE.SphereGeometry(r * 0.55, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2));
        const ring = this.shape(hover, team, "glow", `ring:${r}`, () => new THREE.TorusGeometry(r * 1.35, r * 0.12, 6, 24));
        ring.rotation.x = Math.PI / 2;
        for (let i = 0; i < 3; i += 1) {
          const rotor = this.cyl(hover, team, "frame", r * 0.35, r * 0.35, 0.8, 8, 0, 0, 0);
          const a = (i / 3) * Math.PI * 2;
          rotor.position.set(Math.cos(a) * r * 1.35, 0.6, Math.sin(a) * r * 1.35);
        }
        anim(hover, { type: "bob", amount: 3, speed: 2.5, base: r * 2.2 });
        hover.position.y = r * 2.2;
        g.add(hover);
        break;
      }
      case "load-balancer": {
        for (const x of [-1, 1]) this.box(g, team, "dark", r * 0.5, r * 0.6, r * 1.9, x * r * 0.75);
        this.box(g, team, "body", r * 1.3, r * 0.7, r * 1.6, 0, r * 0.4);
        this.box(g, team, "trim", r * 1.35, r * 0.12, r * 1.65, 0, r * 0.95);
        this.shape(g, team, "frame", `turret:${r}`, () => new THREE.SphereGeometry(r * 0.55, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, r * 1.1, 0);
        this.box(g, team, "frame", r * 0.18, r * 0.18, r * 1.1, 0, r * 1.3, r * 0.6);
        this.shape(g, team, "glow", `lb-eye:${r}`, () => new THREE.SphereGeometry(r * 0.15, 6, 4), 0, r * 1.45, r * 0.3);
        break;
      }
      case "deploy-agent": {
        const core = this.shape(g, team, "glow", `agent:${r}`, () => new THREE.OctahedronGeometry(r * 0.9), 0, r * 2.4, 0);
        anim(core, { type: "spin", speed: 1.4, axis: "y" });
        const ring = this.shape(g, team, "trim", `agent-ring:${r}`, () => new THREE.TorusGeometry(r * 1.4, r * 0.12, 6, 28), 0, r * 2.4, 0);
        ring.rotation.x = Math.PI / 2.4;
        anim(ring, { type: "spin", speed: -2, axis: "z" });
        this.shape(g, team, "glow", `agent-pad:${r}`, () => new THREE.CylinderGeometry(r * 0.8, r * 0.8, 0.6, 16), 0, 0.4, 0);
        break;
      }
      case "bot": {
        this.shape(g, team, "flesh", `bot:${r}`, () => new THREE.IcosahedronGeometry(r * 0.75, 0), 0, r * 0.9, 0);
        this.shape(g, team, "hot", `bot-eye:${r}`, () => new THREE.SphereGeometry(r * 0.22, 6, 4), 0, r * 1.05, r * 0.6);
        for (let i = 0; i < 6; i += 1) {
          const a = ((i % 3) - 1) * 0.6 + (i < 3 ? 0 : Math.PI);
          const leg = this.box(g, team, "flesh", r * 1.1, r * 0.14, r * 0.14);
          leg.position.set(Math.cos(a) * r * 0.85, r * 0.5, Math.sin(a) * r * 0.85);
          leg.rotation.set(0, -a, i < 3 ? -0.6 : 0.6);
        }
        break;
      }
      case "worm": {
        for (let i = 0; i < 5; i += 1) {
          const s = r * (1 - i * 0.13);
          const seg = this.shape(g, team, i === 0 ? "hot" : "flesh", `worm:${r}:${i}`, () => new THREE.SphereGeometry(s, 8, 6), 0, s, -i * r * 1.25);
          anim(seg, { type: "wiggle", amount: r * 0.5, speed: 9, phase: i * 0.9, base: 0 });
        }
        break;
      }
      case "trojan": {
        // A gift you shouldn't open: a box with a hot ribbon.
        this.box(g, team, "flesh", r * 1.6, r * 1.3, r * 1.6);
        this.box(g, team, "hot", r * 1.65, r * 1.32, r * 0.25);
        this.box(g, team, "hot", r * 0.25, r * 1.32, r * 1.65);
        this.box(g, team, "flesh", r * 1.75, r * 0.3, r * 1.75, 0, r * 1.3);
        for (const s of [-1, 1]) {
          const bow = this.shape(g, team, "hot", `bow:${r}`, () => new THREE.TorusGeometry(r * 0.35, r * 0.1, 6, 12), s * r * 0.3, r * 1.85, 0);
          bow.rotation.y = Math.PI / 2;
        }
        break;
      }
      case "ransomware": {
        // The boss: a floating padlock.
        const lock = new THREE.Group();
        this.box(lock, team, "flesh", r * 1.6, r * 1.3, r * 0.8, 0, 0);
        const shackle = this.shape(lock, team, "frame", `shackle:${r}`, () => new THREE.TorusGeometry(r * 0.55, r * 0.16, 8, 20, Math.PI), 0, r * 1.3, 0);
        shackle.rotation.z = 0;
        for (const x of [-1, 1]) this.box(lock, team, "frame", r * 0.32, r * 0.3, r * 0.32, x * r * 0.55, r * 1.0);
        this.shape(lock, team, "hot", `keyhole:${r}`, () => new THREE.CylinderGeometry(r * 0.16, r * 0.16, r * 0.1, 10), 0, r * 0.75, r * 0.42).rotation.x = Math.PI / 2;
        this.box(lock, team, "hot", r * 0.12, r * 0.35, r * 0.1, 0, r * 0.35, r * 0.42);
        lock.position.y = r * 0.6;
        anim(lock, { type: "bob", amount: 3, speed: 1.4, base: r * 0.6 });
        g.add(lock);
        const halo = this.shape(g, team, "hot", `halo:${r}`, () => new THREE.TorusGeometry(r * 1.4, r * 0.06, 6, 32), 0, 1, 0);
        halo.rotation.x = Math.PI / 2;
        anim(halo, { type: "pulse", amount: 0.15, speed: 2 });
        break;
      }
      // --- heroes: bigger, taller, and each with a silhouette of its own ----
      case "maintainer": {
        // Hooded figure carrying a glowing laptop, with a floating commit ring.
        this.shape(g, team, "body", `m-robe:${r}`, () => new THREE.ConeGeometry(r * 0.85, r * 2.2, 10), 0, r * 1.1, 0);
        this.shape(g, team, "trim", `m-hood:${r}`, () => new THREE.SphereGeometry(r * 0.5, 10, 8), 0, r * 2.35, 0);
        this.shape(g, team, "glow", `m-eyes:${r}`, () => new THREE.BoxGeometry(r * 0.5, r * 0.1, r * 0.1), 0, r * 2.35, r * 0.42);
        this.box(g, team, "screen", r * 0.9, r * 0.06, r * 0.6, 0, r * 1.35, r * 0.55).rotation.x = -0.5;
        const ring = this.shape(g, team, "glow", `m-ring:${r}`, () => new THREE.TorusGeometry(r * 0.8, r * 0.06, 6, 24), 0, r * 3.2, 0);
        ring.rotation.x = Math.PI / 2;
        anim(ring, { type: "spin", speed: 1.6, axis: "z" });
        break;
      }
      case "bdfl": {
        // Broad armoured figure on a throne-like base, with a crown of spikes.
        this.box(g, team, "frame", r * 1.7, r * 0.5, r * 1.4);
        this.box(g, team, "body", r * 1.4, r * 1.5, r * 1.0, 0, r * 0.5);
        for (const x of [-1, 1]) this.box(g, team, "trim", r * 0.5, r * 0.4, r * 0.9, x * r * 0.95, r * 1.6);
        this.shape(g, team, "body", `b-head:${r}`, () => new THREE.SphereGeometry(r * 0.42, 10, 8), 0, r * 2.35, 0);
        for (let i = 0; i < 5; i += 1) {
          const spike = this.shape(g, team, "glow", `b-spike:${r}`, () => new THREE.ConeGeometry(r * 0.1, r * 0.45, 5), 0, 0, 0);
          const a = (i / 5) * Math.PI * 2;
          spike.position.set(Math.sin(a) * r * 0.35, r * 2.75, Math.cos(a) * r * 0.35);
        }
        this.box(g, team, "glow", r * 0.18, r * 1.8, r * 0.18, r * 1.05, r * 0.6).rotation.z = 0.2;
        break;
      }
      case "bug-hunter": {
        // Lean, cloaked, a long scope-rifle and a bug-lens visor.
        this.shape(g, team, "dark", `h-body:${r}`, () => new THREE.CapsuleGeometry(r * 0.38, r * 1.3, 4, 8), 0, r * 1.2, 0);
        this.shape(g, team, "trim", `h-cape:${r}`, () => new THREE.ConeGeometry(r * 0.75, r * 1.7, 4, 1, true), 0, r * 1.15, -r * 0.1);
        this.shape(g, team, "glow", `h-visor:${r}`, () => new THREE.TorusGeometry(r * 0.22, r * 0.07, 6, 16), 0, r * 2.15, r * 0.3);
        const rifle = this.box(g, team, "frame", r * 0.14, r * 0.14, r * 2.2, r * 0.45, r * 1.25, r * 0.5);
        rifle.rotation.x = 0.15;
        this.shape(g, team, "glow", `h-tip:${r}`, () => new THREE.SphereGeometry(r * 0.1, 6, 4), r * 0.45, r * 1.4, r * 1.6);
        break;
      }
      case "sre": {
        // Big rig in a hazard harness, pager glowing, two hard shoulder-lamps.
        this.box(g, team, "body", r * 1.5, r * 1.6, r * 1.1, 0, r * 0.4);
        this.box(g, team, "trim", r * 1.55, r * 0.25, r * 1.15, 0, r * 1.2);
        for (const x of [-1, 1]) {
          this.box(g, team, "frame", r * 0.45, r * 1.1, r * 0.5, x * r * 1.0, r * 0.2);
          this.shape(g, team, "glow", `s-lamp:${r}`, () => new THREE.CylinderGeometry(r * 0.16, r * 0.2, r * 0.25, 10), x * r * 0.8, r * 2.15, 0);
        }
        this.shape(g, team, "frame", `s-helm:${r}`, () => new THREE.SphereGeometry(r * 0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, r * 2.0, 0);
        this.box(g, team, "glow", r * 0.3, r * 0.2, r * 0.08, r * 0.35, r * 1.5, r * 0.58);
        break;
      }
      case "architect": {
        // Floating figure inside a slowly turning wireframe cube of boxes.
        const body = new THREE.Group();
        this.shape(body, team, "body", `a-body:${r}`, () => new THREE.CylinderGeometry(r * 0.35, r * 0.6, r * 1.6, 8), 0, r * 0.8, 0);
        this.shape(body, team, "trim", `a-head:${r}`, () => new THREE.OctahedronGeometry(r * 0.38), 0, r * 1.95, 0);
        body.position.y = r * 0.6;
        anim(body, { type: "bob", amount: 2.5, speed: 1.6, base: r * 0.6 });
        g.add(body);
        const frame = new THREE.Group();
        for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          this.box(frame, team, "glow", r * 0.3, r * 0.3, r * 0.3, x * r * 1.05, r * 2.2, z * r * 1.05);
        }
        anim(frame, { type: "spin", speed: 0.7, axis: "y" });
        g.add(frame);
        break;
      }
      case "evangelist": {
        // On a stage: a figure with a megaphone and a spotlight halo.
        this.cyl(g, team, "frame", r * 1.0, r * 1.1, r * 0.35, 12);
        this.shape(g, team, "trim", `e-body:${r}`, () => new THREE.CapsuleGeometry(r * 0.42, r * 1.0, 4, 8), 0, r * 1.35, 0);
        this.shape(g, team, "body", `e-head:${r}`, () => new THREE.SphereGeometry(r * 0.38, 10, 8), 0, r * 2.35, 0);
        const horn = this.shape(g, team, "glow", `e-horn:${r}`, () => new THREE.ConeGeometry(r * 0.3, r * 0.8, 10, 1, true), r * 0.55, r * 1.85, r * 0.45);
        horn.rotation.x = -Math.PI / 2.4;
        const halo = this.shape(g, team, "glow", `e-halo:${r}`, () => new THREE.TorusGeometry(r * 1.2, r * 0.05, 6, 32), 0, r * 0.4, 0);
        halo.rotation.x = Math.PI / 2;
        anim(halo, { type: "pulse", amount: 0.12, speed: 2.4 });
        break;
      }

      // --- decoys --------------------------------------------------------
      case "honeypot": {
        // A server box dripping honey-gold.
        this.box(g, team, "body", r * 1.6, r * 1.8, r * 1.4);
        this.box(g, team, "flame", r * 1.7, r * 0.3, r * 1.5, 0, r * 1.8);
        for (let i = -1; i <= 1; i += 1) this.box(g, team, "flame", r * 0.18, r * 0.6, r * 0.18, i * r * 0.5, r * 1.2, r * 0.72);
        break;
      }
      case "flame-war": {
        // A burning thread: stacked speech boxes on fire.
        for (let i = 0; i < 3; i += 1) this.box(g, team, i % 2 ? "trim" : "body", r * (1.6 - i * 0.3), r * 0.5, r * 0.5, i * r * 0.15, i * r * 0.55);
        for (let i = 0; i < 4; i += 1) {
          const f = this.shape(g, team, "flame", `fw-f:${r}`, () => new THREE.ConeGeometry(r * 0.25, r * 0.9, 6), (i - 1.5) * r * 0.4, r * 1.9, 0);
          anim(f, { type: "flicker" });
        }
        break;
      }
      case "canary": {
        // A little bird on a perch.
        this.cyl(g, team, "frame", r * 0.08, r * 0.08, r * 1.4, 6);
        this.shape(g, team, "flame", `c-body:${r}`, () => new THREE.SphereGeometry(r * 0.55, 10, 8), 0, r * 1.75, 0);
        this.shape(g, team, "flame", `c-head:${r}`, () => new THREE.SphereGeometry(r * 0.35, 10, 8), 0, r * 2.3, r * 0.35);
        this.shape(g, team, "frame", `c-beak:${r}`, () => new THREE.ConeGeometry(r * 0.12, r * 0.3, 6), 0, r * 2.3, r * 0.75).rotation.x = Math.PI / 2;
        anim(g, { type: "bob", amount: 1.5, speed: 3, base: 0 });
        break;
      }
      case "free-tier": {
        // A glowing gift-card sign on a post.
        this.cyl(g, team, "frame", r * 0.1, r * 0.1, r * 1.5, 6);
        this.box(g, team, "glow", r * 1.8, r * 1.1, r * 0.15, 0, r * 1.5);
        this.box(g, team, "screen", r * 1.5, r * 0.8, r * 0.17, 0, r * 1.65);
        break;
      }
      default:
        this.cyl(g, team, team === HORDE_COLOR ? "flesh" : "trim", r * 0.8, r, r * 1.8, 10);
    }
    return g;
  }
}

// --- helpers ------------------------------------------------------------------

const geometries = new Map<string, THREE.BufferGeometry>();
function geometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geometries.get(key);
  if (!g) geometries.set(key, (g = make()));
  return g;
}

const wireframes = new Map<number, THREE.Material>();
function wireframe(team: number): THREE.Material {
  const color = team;
  let m = wireframes.get(color);
  if (!m) wireframes.set(color, (m = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.85 })));
  return m;
}

function anim(node: THREE.Object3D, a: Anim): void {
  node.userData.anim = a;
}

function fanGeometry(r: number): THREE.BufferGeometry {
  const a = new THREE.BoxGeometry(r * 2, 0.6, 2);
  const b = new THREE.BoxGeometry(2, 0.6, r * 2);
  const out = new THREE.BufferGeometry();
  const pa = a.toNonIndexed();
  const pb = b.toNonIndexed();
  const pos = new Float32Array([...(pa.getAttribute("position").array as Float32Array), ...(pb.getAttribute("position").array as Float32Array)]);
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

function coolingTower(): THREE.BufferGeometry {
  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= 10; i += 1) {
    const t = i / 10;
    // A hyperboloid: wide base, waist two thirds up, flared lip.
    const r = 13 + 7 * Math.pow(Math.abs(t - 0.65) / 0.65, 2);
    points.push(new THREE.Vector2(r, t * 48));
  }
  return new THREE.LatheGeometry(points, 20);
}

/** Apply a frame of every tagged animation under `root`. */
export function animate(root: THREE.Object3D, t: number, seed: number): void {
  root.traverse((node) => {
    const a = node.userData.anim as Anim | undefined;
    if (!a) return;
    switch (a.type) {
      case "spin":
        node.rotation[a.axis] = t * a.speed + seed;
        break;
      case "bob":
        node.position.y = a.base + Math.sin(t * a.speed + seed) * a.amount;
        break;
      case "pulse": {
        const k = 1 + Math.sin(t * a.speed + seed) * a.amount;
        node.scale.setScalar(k);
        break;
      }
      case "wiggle":
        node.position.x = a.base + Math.sin(t * a.speed - a.phase + seed) * a.amount;
        break;
      case "flicker":
        break;
    }
  });
}
