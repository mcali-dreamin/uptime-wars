// Procedural models for every building and unit, built from primitives so
// there are no asset files to ship. Each kind is built once per colour as a
// template and cloned per entity (clones share geometry and materials).
//
// `team` below is always a team's colour (see teamColor in ../palette).
//
// The look: hardware with your team's colour as paint and light (it glows,
// and bloom picks it up). What the hardware is made of depends on the race's
// look, so races read apart at a glance whatever colour they play in:
// - scrappy (Open Source): warm, cobbled together. Dark brown metal, copper
//   frames, rusty patch panels, pipes, droopy cables, home-made antennas.
// - monolith (Hyperscaler): cold and polished. Pale chrome, glass shells,
//   chrome plinths, and white light strips.
// - ephemeral (Serverless): wireframe and smoked glass, as if only half
//   there. Functions are drawn as holograms while cold and turn solid while
//   their units are running (see world3d).
// - garden (Walled Garden): glossy white ceramic, rose-gold trim, and neat
//   trimmed hedges on top. Pristine, rounded, a little smug.
// The botnet is none of these: organic, spiky, red. Moving parts are tagged so the
// view can animate them.

import * as THREE from "three";
import { HORDE_COLOR } from "../palette";
import type { FogTexture } from "./fog3d";

export type Anim =
  | { type: "spin"; speed: number; axis: "x" | "y" | "z" }
  | { type: "bob"; amount: number; speed: number; base: number }
  | { type: "pulse"; amount: number; speed: number }
  | { type: "wiggle"; amount: number; speed: number; phase: number; base: number }
  | { type: "flicker" };

type Mat =
  | "body" | "frame" | "trim" | "glow" | "screen" | "solar" | "flesh" | "hot" | "flame" | "dark"
  | "copper" | "rust" | "cable" | "glass" | "chrome" | "white" | "hedge";

/** A race's look (see RaceDef.look), or "default" for the botnet and anything without one. */
export type Look = "scrappy" | "monolith" | "ephemeral" | "garden" | "default";

/**
 * What a building is for. Race decides what it's made of; role decides its
 * shape and its signal light, so you can tell a tower from a barracks from a
 * generator at a glance in any race:
 * - spawner: wide and low, with a big lit door (team colour) on the camera side
 * - tower:   the tallest, slimmest thing in the base, with a red beacon on top
 * - power:   low and flat, with an amber band of light round its base
 * - users:   a cyan screen, tall
 * - network: a thin mast with a white tip
 * - lab:     a violet ring turning over the top
 */
export type Role = "spawner" | "tower" | "power" | "users" | "network" | "lab" | "wall" | "core";

/** The role a building plays, from what its definition says it does. */
export function roleOf(def: { spawn?: unknown; invoke?: unknown; attack?: unknown; compute?: number; income?: unknown; userCapacity?: number; buildRadius?: number; blocks?: boolean }, isCore: boolean): Role {
  if (isCore) return "core";
  if (def.blocks) return "wall";
  if (def.spawn || def.invoke) return "spawner";
  if (def.attack) return "tower";
  if (def.compute || def.income) return "power";
  if (def.userCapacity) return "users";
  if (def.buildRadius) return "network";
  return "lab";
}

/** Target size of each role's body (world units; a tile is 48), and its signal colour. */
const ROLE_SHAPE: Partial<Record<Role, { width: number; height: number; light: number | null }>> = {
  spawner: { width: 46, height: 30, light: null },
  tower: { width: 28, height: 96, light: 0xff3b3b },
  power: { width: 46, height: 20, light: 0xffb020 },
  users: { width: 38, height: 68, light: 0x22d3ee },
  network: { width: 16, height: 60, light: 0xffffff },
  lab: { width: 40, height: 42, light: 0xa855f7 },
};

export class Models {
  private readonly templates = new Map<string, THREE.Group>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly holograms = new Map<number, THREE.Material>();
  /** Shared animated materials (blinking LEDs, flames), keyed for update(). */
  private readonly blinking: THREE.MeshStandardMaterial[] = [];
  /** The look of the template being built right now (see make). */
  private look: Look = "default";

  constructor(private readonly fog: FogTexture) {}

  /** A fresh instance of an entity's model. */
  make(
    defId: string,
    team: number,
    size: number,
    isUnit: boolean,
    look: Look = "default",
    role?: Role,
    tier = 0,
    emblem?: { unit: string; size: number },
  ): THREE.Group {
    // Keyed by colour and look too: a new match may bring a new colour or race.
    const key = `${defId}:${team}:${size}:${look}:${role ?? ""}:${tier}:${emblem?.unit ?? ""}`;
    let template = this.templates.get(key);
    if (!template) {
      this.look = look;
      template = isUnit ? this.unit(defId, team, size) : this.building(defId, team);
      // Players' buildings take their role's shape (the botnet keeps its own).
      const shaped = !isUnit && role !== undefined && look !== "default" && ROLE_SHAPE[role] !== undefined;
      if (shaped) template = this.shapeForRole(template, role!, tier);
      this.dress(template, defId, team, isUnit);
      if (shaped) this.signal(template, role!, team, tier);
      if (shaped && emblem) this.emblem(template, emblem, team);
      this.look = "default";
      template.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) {
          node.castShadow = !node.userData.noShadow;
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
      m.emissiveIntensity = (m.userData.base as number) * (0.9 + 0.1 * Math.sin(t * (m.userData.speed as number) + i * 1.7));
    }
  }

  // --- materials ------------------------------------------------------------

  private mat(kind: Mat, team: number): THREE.Material {
    const color = team;
    const look = this.look;
    const key = `${kind}:${color}:${look}`;
    let material = this.materials.get(key);
    if (material) return material;
    const standard = (p: THREE.MeshStandardMaterialParameters) => this.fog.apply(new THREE.MeshStandardMaterial(p));
    const styled = this.lookMaterial(kind, color, look, standard);
    if (styled) {
      this.materials.set(key, styled);
      return styled;
    }
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
        const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2, roughness: 0.3 });
        m.userData = { base: 1.2, speed: 2.2 };
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
        const m = new THREE.MeshStandardMaterial({ color: 0xff3b4e, emissive: 0xff1f3d, emissiveIntensity: 1.4, roughness: 0.3 });
        m.userData = { base: 1.4, speed: 3.1 };
        this.blinking.push(m);
        material = this.fog.apply(m);
        break;
      }
      case "flame": {
        const m = new THREE.MeshStandardMaterial({ color: 0xffa040, emissive: 0xff7a1a, emissiveIntensity: 1.6, roughness: 0.4 });
        m.userData = { base: 1.6, speed: 9 };
        this.blinking.push(m);
        material = this.fog.apply(m);
        break;
      }
      // Dressing materials, used by both looks.
      case "copper":
        material = standard({ color: 0xb87333, metalness: 0.9, roughness: 0.42 });
        break;
      case "rust":
        material = standard({ color: 0x6e3a1e, metalness: 0.35, roughness: 0.85 });
        break;
      case "cable":
        material = standard({ color: 0x15110e, metalness: 0.1, roughness: 0.9 });
        break;
      case "glass": {
        const m = new THREE.MeshStandardMaterial({
          color: 0xdbeafe,
          metalness: 1,
          roughness: 0.04,
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
        });
        material = this.fog.apply(m);
        break;
      }
      case "chrome":
        material = standard({ color: 0xe2e8f0, metalness: 1, roughness: 0.12 });
        break;
      case "hedge":
        material = standard({ color: 0x2f6b3a, metalness: 0, roughness: 0.95, flatShading: true });
        break;
      case "white": {
        // Cool white light, tinted a touch toward the team colour.
        const tint = new THREE.Color(0xffffff).lerp(new THREE.Color(color), 0.25);
        material = this.fog.apply(new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 1.0, roughness: 0.2 }));
        break;
      }
    }
    this.materials.set(key, material);
    return material;
  }

  /** The base materials (body, frame, dark, glow) as the look makes them; null to use the default. */
  private lookMaterial(
    kind: Mat,
    color: number,
    look: Look,
    standard: (p: THREE.MeshStandardMaterialParameters) => THREE.Material,
  ): THREE.Material | null {
    if (look === "scrappy") {
      switch (kind) {
        case "body":
          return standard({ color: 0x2b231d, metalness: 0.3, roughness: 0.82 });
        case "frame":
          return standard({ color: 0x9a6232, metalness: 0.85, roughness: 0.5 });
        case "dark":
          return standard({ color: 0x17120f, metalness: 0.2, roughness: 0.9 });
      }
    }
    if (look === "garden") {
      switch (kind) {
        case "body":
          return standard({ color: 0xf1f5f9, metalness: 0.1, roughness: 0.22 });
        case "frame":
          return standard({ color: 0xd8a7a0, metalness: 0.9, roughness: 0.3 });
        case "dark":
          return standard({ color: 0x3f3a3c, metalness: 0.2, roughness: 0.5 });
      }
    }
    if (look === "ephemeral") {
      switch (kind) {
        case "body":
          return this.fog.apply(
            new THREE.MeshStandardMaterial({ color: 0x14303d, metalness: 0.3, roughness: 0.2, transparent: true, opacity: 0.55, depthWrite: false }),
          );
        case "frame":
          return this.fog.apply(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5, wireframe: true }));
        case "dark":
          return this.fog.apply(
            new THREE.MeshStandardMaterial({ color: 0x0a1820, metalness: 0.2, roughness: 0.3, transparent: true, opacity: 0.7, depthWrite: false }),
          );
      }
    }
    if (look === "monolith") {
      switch (kind) {
        case "body":
          return standard({ color: 0xaeb8c4, metalness: 0.95, roughness: 0.16 });
        case "frame":
          return standard({ color: 0xe5eaf0, metalness: 1, roughness: 0.1 });
        case "dark":
          return standard({ color: 0x1e2733, metalness: 0.8, roughness: 0.08 });
        case "glow": {
          // Clean light: the team colour washed toward white, steady (no blinking).
          const tint = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.35);
          return this.fog.apply(new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 1.1, roughness: 0.2 }));
        }
      }
    }
    return null;
  }

  // --- role shapes ----------------------------------------------------------

  /**
   * Squash or stretch a building toward its role's proportions. The model goes
   * in a wrapper so the world view can still scale the whole thing (while
   * deploying, and for core tiers). Clamped so details never turn to mush.
   * Higher-tier buildings are a little bigger: they're the expensive ones.
   */
  private shapeForRole(model: THREE.Group, role: Role, tier: number): THREE.Group {
    const target = ROLE_SHAPE[role]!;
    const box = new THREE.Box3().setFromObject(model);
    const w = Math.max(1, Math.max(box.max.x - box.min.x, box.max.z - box.min.z));
    const h = Math.max(1, box.max.y);
    const clamp = (v: number) => Math.min(2.2, Math.max(0.45, v));
    const grow = 1 + 0.12 * tier;
    const sxz = clamp((target.width * (role === "tower" || role === "network" ? 1 : grow)) / w);
    const sy = clamp((target.height * grow) / h);
    const outer = new THREE.Group();
    model.scale.set(sxz, sy, sxz);
    outer.add(model);
    return outer;
  }

  /** The role's signal light, in a colour that means the same thing in every race. */
  private signal(g: THREE.Group, role: Role, team: number, tier: number): void {
    const box = new THREE.Box3().setFromObject(g);
    const w = box.max.x - box.min.x;
    const d = box.max.z - box.min.z;
    const h = box.max.y;
    const light = ROLE_SHAPE[role]!.light;
    const lit = light === null ? this.mat("glow", team) : this.roleLight(light);
    const add = (mesh: THREE.Mesh) => {
      mesh.material = lit;
      mesh.userData.noShadow = true;
      return mesh;
    };
    switch (role) {
      case "spawner": {
        // A wide lit door on the camera side (+z), and a lintel over it. Tier 2 gets two.
        const doors = tier >= 2 ? [-w * 0.2, w * 0.2] : [0];
        for (const x of doors) {
          add(this.box(g, team, "glow", w * (tier >= 2 ? 0.28 : 0.5), h * 0.55, 1, x, 0, box.max.z + 0.6));
          this.box(g, team, "dark", w * (tier >= 2 ? 0.34 : 0.6), 2, 2, x, h * 0.55, box.max.z + 0.8);
        }
        return;
      }
      case "tower": {
        // A beacon on a short mast, and a ring at the top: it shoots.
        this.cyl(g, team, "dark", 1.2, 1.6, 10, 6, 0, h, 0);
        const beacon = add(this.shape(g, team, "glow", "role-beacon", () => new THREE.SphereGeometry(4.5, 12, 8), 0, h + 13, 0));
        anim(beacon, { type: "pulse", amount: 0.25, speed: 4 });
        const ring = add(this.shape(g, team, "glow", `role-ring:${Math.round(w)}`, () => new THREE.TorusGeometry(Math.max(w, d) * 0.55, 1, 6, 24), 0, h - 1, 0));
        ring.rotation.x = Math.PI / 2;
        return;
      }
      case "power": {
        // A band of amber light round the base: it powers things.
        const ring = add(this.shape(g, team, "glow", `role-band:${Math.round(w)}`, () => new THREE.TorusGeometry(Math.max(w, d) * 0.62, 1.4, 6, 32), 0, 2, 0));
        ring.rotation.x = Math.PI / 2;
        add(this.box(g, team, "glow", w * 0.4, 1.5, d * 0.4, 0, h, 0));
        return;
      }
      case "users": {
        // A cyan screen facing the camera, raised: people use this.
        add(this.box(g, team, "glow", w * 0.7, h * 0.3, 1, 0, h * 0.62, box.max.z + 0.6));
        return;
      }
      case "network": {
        // A white tip on a thin mast: it reaches.
        this.cyl(g, team, "dark", 1, 1.4, 14, 6, 0, h, 0);
        const tip = add(this.shape(g, team, "glow", "role-tip", () => new THREE.OctahedronGeometry(3.5), 0, h + 17, 0));
        anim(tip, { type: "spin", speed: 1.5, axis: "y" });
        return;
      }
      case "lab": {
        // A violet ring turning over the top: research happens here.
        const ring = add(this.shape(g, team, "glow", `role-halo:${Math.round(w)}`, () => new THREE.TorusGeometry(Math.max(w, d) * 0.45, 1.3, 8, 28), 0, h + 8, 0));
        ring.rotation.x = Math.PI / 2.6;
        anim(ring, { type: "spin", speed: 0.8, axis: "z" });
        return;
      }
    }
  }

  /**
   * A spawner shows what it makes: a small copy of its unit turning on a lit
   * pad on the roof. That's what tells one barracks from another.
   */
  private emblem(g: THREE.Group, emblem: { unit: string; size: number }, team: number): void {
    const h = new THREE.Box3().setFromObject(g).max.y;
    const pad = this.cyl(g, team, "glow", 12, 13, 1.2, 16, 0, h, 0);
    pad.userData.noShadow = true;
    const figure = this.unit(emblem.unit, team, emblem.size);
    const box = new THREE.Box3().setFromObject(figure);
    const span = Math.max(1, box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    const holder = new THREE.Group();
    holder.position.y = h + 1.2;
    figure.scale.setScalar(26 / span);
    holder.add(figure);
    anim(holder, { type: "spin", speed: 0.7, axis: "y" });
    g.add(holder);
  }

  private readonly roleLights = new Map<number, THREE.Material>();

  private roleLight(color: number): THREE.Material {
    let material = this.roleLights.get(color);
    if (!material) {
      material = this.fog.apply(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.8, roughness: 0.3 }));
      this.roleLights.set(color, material);
    }
    return material;
  }

  // --- race dressing --------------------------------------------------------

  /** Add the look's details around a finished model, sized to its bounds. */
  private dress(g: THREE.Group, defId: string, team: number, isUnit: boolean): void {
    if (this.look === "default") return;
    const box = new THREE.Box3().setFromObject(g);
    if (box.isEmpty()) return;
    const w = box.max.x - box.min.x;
    const h = box.max.y;
    const d = box.max.z - box.min.z;
    const r = hashString(defId);
    if (this.look === "scrappy") {
      if (isUnit) {
        // A home-made antenna with a blinking tip.
        this.cyl(g, team, "copper", 0.5, 0.5, h * 0.45, 4, w * 0.2, h * 0.95, -d * 0.1);
        this.shape(g, team, "glow", "tip", () => new THREE.SphereGeometry(1.4, 6, 4), w * 0.2, h * 1.42, -d * 0.1);
        return;
      }
      // A copper pipe up one corner, with an elbow over the top.
      const side = r % 2 === 0 ? 1 : -1;
      const px = side * (w / 2 + 1.5);
      const pz = d / 2 - 3;
      this.cyl(g, team, "copper", 1.7, 1.7, h * 0.75, 8, px, 0, pz);
      const elbow = this.cyl(g, team, "copper", 1.7, 1.7, w * 0.35, 8, 0, 0, 0);
      elbow.rotation.z = Math.PI / 2;
      elbow.position.set(px - side * w * 0.17, h * 0.75, pz);
      // A rusty patch panel bolted on crooked.
      const patch = this.box(g, team, "rust", w * 0.38, h * 0.26, 1.2, -side * w * 0.15, h * 0.25, box.max.z + 0.4);
      patch.rotation.z = (((r >> 3) % 7) - 3) * 0.035;
      // A droopy cable on the far side.
      const cable = this.shape(g, team, "cable", `cable:${Math.round(w)}`, () => new THREE.TorusGeometry(w * 0.28, 0.9, 5, 16, Math.PI), 0, h * 0.55, box.min.z - 0.8);
      cable.rotation.z = Math.PI;
      // A home-made antenna on the roof, off to one side.
      if (w > 20) {
        this.cyl(g, team, "copper", 0.6, 0.9, 16, 5, -side * w * 0.3, h, -d * 0.2);
        this.shape(g, team, "glow", "tip", () => new THREE.SphereGeometry(1.6, 6, 4), -side * w * 0.3, h + 17, -d * 0.2);
      }
      return;
    }
    if (this.look === "garden") {
      // Walls carry their own hedge; everything else gets a trimmed hedge on top.
      if (isUnit || defId === "garden-wall" || defId === "garden-gate") return;
      // Topiaries at the corners, never on the roof: from above the roof is what tells buildings apart.
      {
        for (const [cx, cz] of [[1, 1], [-1, 1]] as const) {
          this.cyl(g, team, "frame", 2.5, 3, 4, 8, cx * (w / 2 + 4), 0, cz * (d / 2 + 4));
          this.shape(g, team, "hedge", "topiary", () => new THREE.SphereGeometry(5, 8, 6), cx * (w / 2 + 4), 9, cz * (d / 2 + 4));
        }
      }
      return;
    }
    if (this.look === "ephemeral") {
      if (isUnit) return;
      // Floating corner nodes (no cage: it hid every building's shape).
      for (const [cx, cz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const node = this.shape(g, team, "glow", "eph-node", () => new THREE.OctahedronGeometry(2), cx * (w / 2 + 3), h + 6, cz * (d / 2 + 3));
        anim(node, { type: "bob", amount: 1.5, speed: 2, base: h + 6 });
      }
      return;
    }
    // monolith
    if (isUnit) {
      // A chrome ring at the feet and a white visor line.
      const ring = this.shape(g, team, "chrome", `mono-ring:${Math.round(w)}`, () => new THREE.TorusGeometry(Math.max(w, d) * 0.55, 0.7, 6, 24), 0, 1, 0);
      ring.rotation.x = Math.PI / 2;
      return;
    }
    // A chrome plinth under it...
    this.box(g, team, "chrome", w + 8, 2.5, d + 8, 0, 0, 0);
    // ...and a white light strip along its front edge (not round the roof: that turned every building into the same lit square).
    this.box(g, team, "white", w + 2, 1.2, 1.2, 0, 2.5, d / 2 + 4);
  }

  // --- race silhouettes ----------------------------------------------------
  //
  // The buildings both races share (core, GPU Cluster, Web App) and their
  // basic units get a different *shape* per look, not just a reskin, so a base
  // reads by silhouette before colour: scrappy is low, sprawling, stacked and
  // lopsided; monolith is tall, slim, seamless and symmetric.

  private lookBuilding(defId: string, team: number): THREE.Group | null {
    if (this.look === "default") return null;
    if (this.look === "ephemeral") return this.ephemeralBuilding(defId, team);
    if (this.look === "garden") return this.gardenBuilding(defId, team);
    const g = new THREE.Group();
    const scrappy = this.look === "scrappy";
    switch (defId) {
      case "core":
        if (scrappy) {
          // A ramshackle tower of mismatched server cases, cables slung between them.
          const stack = [
            [72, 18, 64, 0, 0, 0],
            [58, 16, 60, -5, 0, 3],
            [62, 14, 50, 6, 0, -4],
            [44, 16, 46, -3, 0, 2],
            [36, 12, 34, 4, 0, 0],
          ] as const;
          let y = 6;
          this.box(g, team, "rust", 86, 6, 80);
          stack.forEach(([w, h, d, x, , z], i) => {
            const c = this.box(g, team, i % 2 ? "rust" : "body", w, h, d, x, y, z);
            c.rotation.y = ((i % 3) - 1) * 0.06;
            this.box(g, team, "glow", w * 0.7, 1.6, 0.8, x - w * 0.08, y + h * 0.55, z + d / 2 + 0.4);
            y += h;
          });
          for (const [x, z, rot] of [[30, 30, 0.2], [-34, 18, -0.4], [26, -32, 0.9]] as const) {
            const cable = this.shape(g, team, "cable", `core-cable`, () => new THREE.TorusGeometry(16, 1.1, 5, 14, Math.PI), x, 46, z);
            cable.rotation.set(0, rot, Math.PI);
          }
          // A bodged mast with a dish made from a pan.
          this.cyl(g, team, "copper", 1.4, 2.4, 34, 6, 8, y, -4);
          const dish = this.shape(g, team, "copper", "core-dish", () => new THREE.SphereGeometry(12, 12, 6, 0, Math.PI * 2, 0, Math.PI / 3), 8, y + 34, -4);
          dish.rotation.x = Math.PI + 0.7;
          anim(dish, { type: "spin", speed: 0.5, axis: "y" });
          const tip = this.shape(g, team, "glow", "core-tip", () => new THREE.SphereGeometry(3, 8, 6), 8, y + 38, -4);
          anim(tip, { type: "pulse", amount: 0.2, speed: 3 });
        } else {
          // One seamless chrome-and-glass slab with a light seam up each face.
          this.box(g, team, "chrome", 84, 4, 84);
          this.box(g, team, "body", 52, 110, 52, 0, 4);
          this.box(g, team, "dark", 53, 104, 53, 0, 8);
          for (const [sx, sz, lw, ld] of [[0, 27, 3, 0.8], [0, -27, 3, 0.8], [27, 0, 0.8, 3], [-27, 0, 0.8, 3]] as const) {
            this.box(g, team, "glow", lw, 96, ld, sx, 12, sz);
          }
          this.box(g, team, "white", 56, 2, 56, 0, 114);
          const halo = this.shape(g, team, "glow", "mono-halo", () => new THREE.TorusGeometry(34, 1, 8, 64), 0, 128, 0);
          halo.rotation.x = Math.PI / 2;
          anim(halo, { type: "bob", amount: 3, speed: 1.2, base: 128 });
        }
        return g;
      case "gpu-cluster":
        if (scrappy) {
          // A sprawl of open-frame rigs on a pallet, fans everywhere.
          this.box(g, team, "rust", 46, 3, 40);
          for (const [x, z, h] of [[-12, -8, 12], [10, -10, 18], [-8, 12, 9], [13, 10, 14]] as const) {
            this.box(g, team, "copper", 14, 1, 12, x, 3, z);
            this.box(g, team, "copper", 14, 1, 12, x, 3 + h, z);
            for (const [px, pz] of [[-6, -5], [6, -5], [-6, 5], [6, 5]] as const) this.cyl(g, team, "copper", 0.5, 0.5, h, 4, x + px, 3, z + pz);
            this.box(g, team, "glow", 10, 1.2, 8, x, 3 + h * 0.5, z);
            const fan = this.shape(g, team, "trim", "fan", () => fanGeometry(5), x, 4.4 + h, z);
            anim(fan, { type: "spin", speed: 11, axis: "y" });
          }
        } else {
          // A tall sealed tower, vented, like a liquid-cooled cabinet.
          this.box(g, team, "chrome", 34, 3, 34);
          this.box(g, team, "body", 24, 62, 24, 0, 3);
          for (let i = 0; i < 6; i += 1) this.box(g, team, "glow", 25, 1, 25, 0, 10 + i * 9);
          for (const x of [-1, 1]) this.cyl(g, team, "chrome", 2.5, 2.5, 58, 10, x * 15, 3, 0);
        }
        return g;
      case "web-app":
        if (scrappy) {
          // A shack of salvaged monitors, stacked any old way.
          this.box(g, team, "rust", 42, 3, 36);
          this.box(g, team, "body", 30, 16, 22, -4, 3, 0);
          const screens = [[-10, 19, 0.15, 18, 13], [8, 19, -0.2, 16, 12], [-2, 33, 0.05, 22, 15], [12, 6, 0.3, 12, 9]] as const;
          for (const [x, y, rot, w, h] of screens) {
            const m = new THREE.Group();
            m.position.set(x, y, 10);
            m.rotation.y = rot;
            this.box(m, team, "dark", w + 2, h + 2, 4, 0, 0, 0);
            this.box(m, team, "screen", w, h, 0.6, 0, 1, 2.2);
            g.add(m);
          }
          this.cyl(g, team, "copper", 0.8, 0.8, 16, 5, -14, 48, -4);
          this.shape(g, team, "glow", "tip", () => new THREE.SphereGeometry(1.6, 6, 4), -14, 64, -4);
        } else {
          // A slim, floating glass pane over a chrome pedestal.
          this.box(g, team, "chrome", 30, 3, 30);
          this.cyl(g, team, "chrome", 3, 5, 28, 12, 0, 3);
          const pane = new THREE.Group();
          pane.position.y = 52;
          this.box(pane, team, "screen", 44, 28, 1.2, 0, -14);
          for (const [x, y, w, h] of [[0, 14.5, 46, 1], [0, -14.5, 46, 1], [23, 0, 1, 30], [-23, 0, 1, 30]] as const) this.box(pane, team, "white", w, h, 1.6, x, y - h / 2);
          anim(pane, { type: "bob", amount: 2, speed: 1, base: 52 });
          g.add(pane);
        }
        return g;
    }
    return null;
  }

  private lookUnit(defId: string, team: number, r: number): THREE.Group | null {
    if (this.look === "default" || this.look === "ephemeral" || this.look === "garden") return null;
    const g = new THREE.Group();
    const scrappy = this.look === "scrappy";
    switch (defId) {
      case "inference-drone":
        if (scrappy) {
          // A hand-built quadcopter: cross frame, four rotors, a box hung underneath.
          const body = new THREE.Group();
          body.position.y = r * 2;
          for (const rot of [Math.PI / 4, -Math.PI / 4]) this.box(body, team, "copper", r * 3, r * 0.15, r * 0.25, 0, 0, 0).rotation.y = rot;
          for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
            const rotor = this.shape(body, team, "trim", "fan", () => fanGeometry(5), x * r * 1.05, r * 0.2, z * r * 1.05);
            rotor.scale.setScalar(r / 7);
            anim(rotor, { type: "spin", speed: 20, axis: "y" });
          }
          this.box(body, team, "rust", r * 0.9, r * 0.6, r * 0.9, 0, -r * 0.7, 0);
          this.box(body, team, "glow", r * 0.5, r * 0.15, 0.4, 0, -r * 0.4, r * 0.46);
          anim(body, { type: "bob", amount: 2, speed: 3.2, base: r * 2 });
          g.add(body);
        } else {
          // A smooth floating lens: a disc with a light ring and no visible rotors.
          const body = new THREE.Group();
          body.position.y = r * 2.4;
          this.shape(body, team, "body", `lens:${r}`, () => new THREE.SphereGeometry(r * 1.1, 16, 8).scale(1, 0.35, 1));
          const ring = this.shape(body, team, "glow", `lens-ring:${r}`, () => new THREE.TorusGeometry(r * 1.1, r * 0.08, 6, 32));
          ring.rotation.x = Math.PI / 2;
          this.shape(body, team, "white", `lens-eye:${r}`, () => new THREE.SphereGeometry(r * 0.25, 8, 6), 0, -r * 0.3, 0);
          anim(body, { type: "bob", amount: 2.5, speed: 1.8, base: r * 2.4 });
          g.add(body);
        }
        return g;
      case "deploy-agent":
        if (scrappy) {
          // A tracked little robot hauling a crate of parts.
          for (const x of [-1, 1]) this.box(g, team, "dark", r * 0.4, r * 0.5, r * 1.6, x * r * 0.6);
          this.box(g, team, "rust", r * 1, r * 0.7, r * 1.2, 0, r * 0.45);
          this.box(g, team, "copper", r * 0.8, r * 0.5, r * 0.6, 0, r * 1.15, -r * 0.2);
          this.box(g, team, "glow", r * 0.5, r * 0.15, 0.4, 0, r * 0.9, r * 0.62);
          this.cyl(g, team, "copper", 0.4, 0.4, r * 1.2, 4, r * 0.3, r * 1.15, -r * 0.3);
          return g;
        }
        return null;
    }
    return null;
  }

  /** Walled Garden: rounded white ceramic, inside its own little walls. */
  private gardenBuilding(defId: string, team: number): THREE.Group | null {
    const g = new THREE.Group();
    switch (defId) {
      case "core": {
        // A rounded white tower in a walled courtyard ringed by hedge.
        this.cyl(g, team, "frame", 46, 48, 3, 32);
        for (let i = 0; i < 12; i += 1) {
          const a = (i / 12) * Math.PI * 2;
          this.box(g, team, "hedge", 14, 7, 5, Math.cos(a) * 40, 3, Math.sin(a) * 40).rotation.y = -a + Math.PI / 2;
        }
        this.shape(g, team, "body", "garden-tower", () => new THREE.CapsuleGeometry(20, 52, 8, 24), 0, 50, 0);
        this.cyl(g, team, "frame", 21, 21, 2, 32, 0, 50);
        const logo = this.shape(g, team, "glow", "garden-logo", () => new THREE.SphereGeometry(7, 16, 12), 0, 104, 0);
        anim(logo, { type: "bob", amount: 3, speed: 1.2, base: 104 });
        return g;
      }
      case "web-app": {
        // A glossy tablet on a rose-gold stand.
        this.cyl(g, team, "frame", 12, 14, 3, 24);
        this.cyl(g, team, "frame", 1.6, 2, 18, 12, 0, 3);
        const tablet = new THREE.Group();
        tablet.position.y = 40;
        tablet.rotation.x = -0.25;
        this.box(tablet, team, "body", 34, 24, 3, 0, -12, 0);
        this.box(tablet, team, "screen", 30, 20, 0.6, 0, -10, 1.8);
        g.add(tablet);
        return g;
      }
    }
    return null;
  }

  /** Serverless: nothing heavy. Floating, scattered, barely there. */
  private ephemeralBuilding(defId: string, team: number): THREE.Group | null {
    const g = new THREE.Group();
    switch (defId) {
      case "core": {
        // A control plane: a thin pillar with a cloud of small nodes orbiting it.
        this.cyl(g, team, "dark", 34, 38, 4, 6);
        this.cyl(g, team, "body", 6, 8, 70, 6, 0, 4);
        this.cyl(g, team, "glow", 7, 7, 1.5, 6, 0, 74);
        const cloud = new THREE.Group();
        cloud.position.y = 52;
        const spots = [[26, 8, 0], [-22, -6, 14], [8, 14, -26], [-12, 22, -18], [18, -10, 22], [-26, 4, -8], [0, 28, 6]] as const;
        for (const [x, y, z] of spots) this.box(cloud, team, "body", 10, 10, 10, x, y - 5, z);
        for (const [x, y, z] of spots) this.box(cloud, team, "frame", 12, 12, 12, x, y - 6, z);
        anim(cloud, { type: "spin", speed: 0.4, axis: "y" });
        g.add(cloud);
        const gem = this.shape(g, team, "glow", "eph-gem", () => new THREE.OctahedronGeometry(8), 0, 92, 0);
        anim(gem, { type: "bob", amount: 4, speed: 1.4, base: 92 });
        return g;
      }
      case "web-app": {
        // Three floating panes at different heights: an app that's only there when called.
        this.cyl(g, team, "dark", 12, 14, 3, 6);
        for (const [y, x, rot] of [[22, -8, 0.3], [36, 6, -0.25], [50, -2, 0.05]] as const) {
          const pane = new THREE.Group();
          pane.position.set(x, y, 0);
          pane.rotation.y = rot;
          this.box(pane, team, "screen", 22, 13, 0.8, 0, 0, 0);
          this.box(pane, team, "frame", 24, 15, 1.4, 0, -1, 0);
          anim(pane, { type: "bob", amount: 1.5, speed: 1.3 + y / 60, base: y });
          g.add(pane);
        }
        return g;
      }
    }
    return null;
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
    const styled = this.lookBuilding(defId, team);
    if (styled) return styled;
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
      case "botnet-farm": {
        // A fleshy hive of server pods, glowing vents, and a hatch the bots pour out of.
        this.shape(g, team, "flesh", "farm-base", () => {
          const geo = new THREE.CylinderGeometry(40, 46, 14, 7);
          geo.translate(0, 7, 0);
          return geo;
        });
        for (let i = 0; i < 6; i += 1) {
          const a = (i / 6) * Math.PI * 2;
          const pod = this.shape(g, team, "flesh", "farm-pod", () => new THREE.CapsuleGeometry(7, 22, 4, 8), Math.cos(a) * 26, 30, Math.sin(a) * 26);
          pod.rotation.set(Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25);
          this.shape(g, team, "hot", "farm-vent", () => new THREE.SphereGeometry(3, 8, 6), Math.cos(a) * 26, 46, Math.sin(a) * 26);
        }
        this.shape(g, team, "flesh", "farm-dome", () => new THREE.SphereGeometry(20, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, 14, 0);
        const hatch = this.shape(g, team, "hot", "farm-hatch", () => new THREE.TorusGeometry(9, 2, 6, 16), 0, 34, 0);
        hatch.rotation.x = Math.PI / 2;
        anim(hatch, { type: "pulse", amount: 0.2, speed: 2 });
        break;
      }
      case "infected-node": {
        // A server rack gone wrong: a dark slab split open, red tendrils
        // rooting it into the ground, and a hot core pulsing in the crack.
        this.shape(g, team, "flesh", "node-roots", () => new THREE.CylinderGeometry(34, 42, 6, 9), 0, 3, 0);
        for (let i = 0; i < 7; i += 1) {
          const a = (i / 7) * Math.PI * 2;
          const root = this.shape(g, team, "flesh", "node-root", () => new THREE.ConeGeometry(4, 34, 5), Math.cos(a) * 30, 6, Math.sin(a) * 30);
          root.rotation.set(Math.sin(a) * 1.25, 0, -Math.cos(a) * 1.25);
        }
        for (const x of [-11, 11]) {
          const half = this.box(g, team, "dark", 18, 58, 26, x, 4, 0);
          half.rotation.z = x < 0 ? 0.12 : -0.12;
        }
        const core = this.shape(g, team, "hot", "node-core", () => new THREE.OctahedronGeometry(9), 0, 38, 0);
        anim(core, { type: "pulse", amount: 0.25, speed: 3 });
        const halo = this.shape(g, team, "hot", "node-halo", () => new THREE.TorusGeometry(16, 1.2, 6, 24), 0, 66, 0);
        halo.rotation.x = Math.PI / 2;
        anim(halo, { type: "spin", speed: 1.2, axis: "z" });
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
      case "garden-wall": {
        // A full-tile white wall with a rose-gold cap and a hedge on top, so
        // walls side by side read as one long wall.
        this.box(g, team, "body", 48, 30, 48);
        this.box(g, team, "frame", 49, 2, 49, 0, 30);
        this.box(g, team, "hedge", 44, 9, 44, 0, 32);
        break;
      }
      case "garden-gate": {
        // Two wall posts with an arch and a glowing threshold: wall-height, so
        // it lines up with the walls beside it, but plainly a way through.
        for (const x of [-1, 1]) {
          this.box(g, team, "body", 12, 30, 48, x * 18, 0, 0);
          this.box(g, team, "hedge", 10, 9, 44, x * 18, 32, 0);
        }
        this.box(g, team, "frame", 48, 4, 10, 0, 30, 0);
        const sill = this.box(g, team, "glow", 22, 1, 40, 0, 0.5, 0);
        anim(sill, { type: "pulse", amount: 0.15, speed: 2 });
        break;
      }
      case "app-review": {
        // A slim white lighthouse with a rose-gold lantern that sweeps the field.
        this.cyl(g, team, "frame", 16, 18, 4, 24);
        this.cyl(g, team, "body", 8, 13, 58, 24, 0, 4);
        this.cyl(g, team, "frame", 10, 10, 3, 24, 0, 62);
        const lamp = new THREE.Group();
        lamp.position.y = 65;
        this.cyl(lamp, team, "glow", 6, 6, 9, 16);
        this.box(lamp, team, "white", 22, 2, 2, 0, 4, 0);
        anim(lamp, { type: "spin", speed: 1.6, axis: "y" });
        g.add(lamp);
        this.shape(g, team, "frame", "ar-dome", () => new THREE.SphereGeometry(7, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, 74, 0);
        break;
      }
      case "flagship-store": {
        // A glass-fronted white cube with a glowing logo over the door.
        this.box(g, team, "frame", 44, 3, 44);
        this.box(g, team, "body", 38, 30, 38, 0, 3);
        this.box(g, team, "screen", 30, 20, 0.8, 0, 5, 19.5);
        this.shape(g, team, "glow", "fs-logo", () => new THREE.SphereGeometry(4, 12, 8), 0, 30, 20);
        break;
      }
      case "private-cloud": {
        // A white dome on a plinth, like a cloud you're not allowed into.
        this.cyl(g, team, "frame", 20, 22, 4, 24);
        this.shape(g, team, "body", "pc-dome", () => new THREE.SphereGeometry(18, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), 0, 4, 0);
        this.cyl(g, team, "glow", 18.5, 18.5, 1.5, 32, 0, 5);
        const lock = this.shape(g, team, "frame", "pc-lock", () => new THREE.TorusGeometry(4, 1.2, 8, 16, Math.PI), 0, 24, 0);
        lock.rotation.z = 0;
        break;
      }
      case "function": {
        // A floating cube with a lambda-ish chevron inside, over a small pad.
        this.cyl(g, team, "dark", 14, 16, 3, 6);
        const cube = new THREE.Group();
        cube.position.y = 26;
        this.box(cube, team, "body", 20, 20, 20, 0, -10, 0);
        const a = this.box(cube, team, "glow", 3, 16, 3, -2, -8, 0);
        a.rotation.z = 0.45;
        const b = this.box(cube, team, "glow", 3, 9, 3, 4, -10, 0);
        b.rotation.z = -0.5;
        anim(cube, { type: "bob", amount: 2.5, speed: 1.6, base: 26 });
        g.add(cube);
        break;
      }
      case "inference-endpoint": {
        // A stack of three rings around a glowing core: a model waiting for calls.
        this.cyl(g, team, "dark", 16, 18, 3, 8);
        this.cyl(g, team, "body", 3, 4, 40, 8, 0, 3);
        for (const [y, r, speed] of [[16, 15, 0.8], [27, 12, -1.2], [37, 9, 1.6]] as const) {
          const ring = this.shape(g, team, "frame", `ep-ring:${r}`, () => new THREE.TorusGeometry(r, 1.2, 6, 28), 0, y, 0);
          ring.rotation.x = Math.PI / 2;
          anim(ring, { type: "spin", speed, axis: "z" });
        }
        const orb = this.shape(g, team, "glow", "ep-orb", () => new THREE.IcosahedronGeometry(6, 0), 0, 48, 0);
        anim(orb, { type: "spin", speed: 1.5, axis: "y" });
        break;
      }
      case "compute-pool": {
        // A shallow pool of glowing cores, ready to take load.
        this.cyl(g, team, "frame", 20, 22, 4, 8);
        this.cyl(g, team, "dark", 17, 17, 3, 8, 0, 4);
        for (const [x, z] of [[-8, -8], [8, -8], [-8, 8], [8, 8], [0, 0]] as const) {
          const cell = this.box(g, team, "glow", 6, 6, 6, x, 8, z);
          anim(cell, { type: "bob", amount: 1.5, speed: 2 + (x + z) * 0.05, base: 8 });
        }
        break;
      }
      case "ci-server": {
        // A rack of build runners with a status light that never stops blinking.
        this.box(g, team, "frame", 42, 4, 42);
        this.box(g, team, "body", 30, 40, 26, 0, 4);
        for (let i = 0; i < 4; i += 1) this.box(g, team, i % 2 ? "glow" : "trim", 24, 2, 1.2, 0, 10 + i * 8, 13.6);
        const light = this.shape(g, team, "glow", "ci-light", () => new THREE.SphereGeometry(4, 10, 8), 0, 50, 0);
        anim(light, { type: "pulse", amount: 0.35, speed: 5 });
        break;
      }
      case "rnd-lab": {
        // A glass dome over a plinth, with a spinning test rig inside.
        this.cyl(g, team, "frame", 20, 22, 6, 24);
        this.shape(g, team, "screen", "rnd-dome", () => new THREE.SphereGeometry(17, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), 0, 6, 0);
        const rig = this.shape(g, team, "glow", "rnd-rig", () => new THREE.TorusKnotGeometry(5, 1.4, 48, 8), 0, 16, 0);
        anim(rig, { type: "spin", speed: 1.5, axis: "y" });
        break;
      }
      case "build-pipeline": {
        // A row of stages joined by a glowing conveyor.
        this.box(g, team, "dark", 44, 3, 20);
        for (const x of [-14, 0, 14]) this.box(g, team, "body", 10, 18 + (x + 14) / 2, 14, x, 3);
        const belt = this.box(g, team, "glow", 42, 1.5, 3, 0, 8, 8.5);
        anim(belt, { type: "pulse", amount: 0.1, speed: 3 });
        break;
      }
      case "design-studio": {
        // A white pavilion with a big rounded window and a lit logo.
        this.box(g, team, "frame", 42, 3, 42);
        this.shape(g, team, "body", "ds-hall", () => new THREE.CapsuleGeometry(14, 14, 6, 16).rotateZ(Math.PI / 2), 0, 18, 0);
        this.shape(g, team, "glow", "ds-logo", () => new THREE.TorusGeometry(5, 1.2, 8, 20), 0, 34, 0);
        break;
      }
      case "monorepo": {
        // One huge repository: a long slab of stacked layers with a glowing build light.
        this.box(g, team, "frame", 44, 4, 44);
        for (let i = 0; i < 5; i += 1) this.box(g, team, i % 2 ? "trim" : "body", 38 - i * 3, 9, 38 - i * 3, 0, 4 + i * 9);
        const light = this.shape(g, team, "glow", "mono-light", () => new THREE.OctahedronGeometry(6), 0, 56, 0);
        anim(light, { type: "spin", speed: 1.2, axis: "y" });
        break;
      }
      case "edge-fleet": {
        // A launch rack: three slim pylons with glowing tips, like a fleet waiting to go.
        this.box(g, team, "frame", 42, 4, 42);
        for (const [x, z] of [[-12, -8], [12, -8], [0, 12]] as const) {
          this.cyl(g, team, "body", 3, 5, 34, 6, x, 4, z);
          const tip = this.shape(g, team, "glow", "ef-tip", () => new THREE.ConeGeometry(4, 9, 6), x, 42, z);
          anim(tip, { type: "pulse", amount: 0.2, speed: 4 });
        }
        break;
      }
      case "mainframe-bay": {
        // A heavy hangar with a big door and a crane arm.
        this.box(g, team, "frame", 46, 4, 46);
        this.box(g, team, "body", 40, 32, 36, 0, 4);
        this.box(g, team, "dark", 26, 22, 1, 0, 4, 18.5);
        this.box(g, team, "trim", 42, 3, 38, 0, 36);
        const arm = this.box(g, team, "frame", 30, 3, 3, 8, 42, 0);
        anim(arm, { type: "spin", speed: 0.5, axis: "y" });
        break;
      }
      case "state-machine": {
        // States and transitions: four floating cubes joined in a loop.
        this.cyl(g, team, "dark", 18, 20, 3, 8);
        const loop = new THREE.Group();
        loop.position.y = 30;
        for (let i = 0; i < 4; i += 1) {
          const a = (i / 4) * Math.PI * 2;
          this.box(loop, team, i === 0 ? "glow" : "body", 9, 9, 9, Math.cos(a) * 13, -4.5, Math.sin(a) * 13);
        }
        const ring = this.shape(loop, team, "glow", "sm-ring", () => new THREE.TorusGeometry(13, 0.9, 6, 32));
        ring.rotation.x = Math.PI / 2;
        anim(loop, { type: "spin", speed: 0.9, axis: "y" });
        g.add(loop);
        break;
      }
      case "trust-safety": {
        // A guard post: a squat tower with a barrier arm.
        this.box(g, team, "frame", 40, 3, 40);
        this.cyl(g, team, "body", 12, 14, 34, 8, 0, 3);
        this.cyl(g, team, "trim", 15, 15, 4, 8, 0, 37);
        const bar = this.box(g, team, "glow", 30, 2.5, 2.5, 16, 14, 0);
        anim(bar, { type: "bob", amount: 2, speed: 1.2, base: 14 });
        break;
      }
      case "legal-dept": {
        // Columns and a pediment: very official.
        this.box(g, team, "frame", 44, 4, 36);
        for (const x of [-14, -5, 5, 14]) this.cyl(g, team, "body", 2.6, 2.6, 26, 10, x, 4, 10);
        this.box(g, team, "body", 38, 26, 18, 0, 4, -6);
        this.shape(g, team, "trim", "ld-roof", () => new THREE.ConeGeometry(28, 10, 4).rotateY(Math.PI / 4).scale(1, 1, 0.6), 0, 35, 0);
        this.shape(g, team, "glow", "ld-seal", () => new THREE.TorusGeometry(4, 1, 6, 16), 0, 30, 13);
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
    const styled = this.lookUnit(defId, team, r);
    if (styled) return styled;
    const g = new THREE.Group();
    switch (defId) {
      case "kernel": {
        // A big slow orb in a cradle, ringed by a mending halo.
        this.cyl(g, team, "frame", r * 0.9, r * 1.1, r * 0.5, 10);
        this.shape(g, team, "body", `kernel:${r}`, () => new THREE.SphereGeometry(r * 0.85, 14, 10), 0, r * 1.2, 0);
        const halo = this.shape(g, team, "glow", `kernel-halo:${r}`, () => new THREE.TorusGeometry(r * 1.4, r * 0.07, 6, 32), 0, r * 0.3, 0);
        halo.rotation.x = Math.PI / 2;
        anim(halo, { type: "pulse", amount: 0.12, speed: 2 });
        break;
      }
      case "cdn-swarm": {
        // A small fast dart.
        const dart = this.shape(g, team, "trim", `cdn:${r}`, () => new THREE.ConeGeometry(r * 0.6, r * 2.2, 5).rotateX(Math.PI / 2), 0, r * 1.2, 0);
        dart.scale.set(1, 0.6, 1);
        this.shape(g, team, "glow", `cdn-tail:${r}`, () => new THREE.SphereGeometry(r * 0.3, 6, 4), 0, r * 1.2, -r * 1.1);
        break;
      }
      case "mainframe": {
        // A rolling cabinet on treads with a ram.
        for (const x of [-1, 1]) this.box(g, team, "dark", r * 0.45, r * 0.5, r * 2, x * r * 0.8);
        this.box(g, team, "body", r * 1.5, r * 1.3, r * 1.7, 0, r * 0.4);
        for (let i = 0; i < 3; i += 1) this.box(g, team, "glow", r * 1.2, r * 0.08, 0.6, 0, r * (0.7 + i * 0.3), r * 0.86);
        this.box(g, team, "frame", r * 1.0, r * 0.5, r * 0.6, 0, r * 0.5, r * 1.15);
        break;
      }
      case "step-function": {
        // Two linked blocks: one step leading to the next.
        this.box(g, team, "body", r * 0.9, r * 0.9, r * 0.9, -r * 0.5, r * 0.3);
        this.box(g, team, "trim", r * 0.9, r * 0.9, r * 0.9, r * 0.5, r * 1.2);
        this.box(g, team, "glow", r * 0.2, r * 0.9, r * 0.2, 0, r * 0.75);
        break;
      }
      case "gatekeeper": {
        // A broad shield-bearer.
        this.shape(g, team, "body", `gk:${r}`, () => new THREE.CapsuleGeometry(r * 0.6, r * 0.8, 4, 8), 0, r * 1.0, 0);
        this.box(g, team, "trim", r * 1.8, r * 1.6, r * 0.2, 0, r * 0.3, r * 0.75);
        this.box(g, team, "glow", r * 1.2, r * 0.14, 0.4, 0, r * 1.2, r * 0.86);
        break;
      }
      case "legal-team": {
        // A briefcase on legs with a glowing seal.
        this.box(g, team, "body", r * 1.4, r * 1.0, r * 0.6, 0, r * 0.7);
        this.shape(g, team, "frame", `lt-handle:${r}`, () => new THREE.TorusGeometry(r * 0.3, r * 0.07, 6, 12, Math.PI), 0, r * 1.7, 0);
        for (const x of [-1, 1]) this.box(g, team, "frame", r * 0.18, r * 0.7, r * 0.18, x * r * 0.4, 0);
        this.shape(g, team, "glow", `lt-seal:${r}`, () => new THREE.SphereGeometry(r * 0.18, 8, 6), 0, r * 1.2, r * 0.32);
        break;
      }
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
      case "infector": {
        // A hunched carrier with a glowing seed on its back: the thing to kill.
        this.shape(g, team, "flesh", `inf-body:${r}`, () => new THREE.SphereGeometry(r * 0.85, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, r * 0.3, 0);
        for (let i = 0; i < 4; i += 1) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const leg = this.box(g, team, "flesh", r * 0.18, r * 0.9, r * 0.18, Math.cos(a) * r * 0.75, 0, Math.sin(a) * r * 0.75);
          leg.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
        }
        const seed = this.shape(g, team, "hot", `inf-seed:${r}`, () => new THREE.IcosahedronGeometry(r * 0.55, 0), 0, r * 1.45, 0);
        anim(seed, { type: "pulse", amount: 0.3, speed: 5 });
        break;
      }
      case "scanner": {
        // A floating eye with a sweeping beam.
        const eye = new THREE.Group();
        eye.position.y = r * 2.2;
        this.shape(eye, team, "flesh", `scan:${r}`, () => new THREE.SphereGeometry(r * 0.7, 10, 8));
        this.shape(eye, team, "hot", `scan-iris:${r}`, () => new THREE.SphereGeometry(r * 0.3, 8, 6), 0, 0, r * 0.55);
        const beam = this.shape(eye, team, "hot", `scan-beam:${r}`, () => new THREE.ConeGeometry(r * 0.6, r * 3, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, r * 2.2));
        beam.scale.set(1, 0.3, 1);
        anim(eye, { type: "spin", speed: 2.5, axis: "y" });
        g.add(eye);
        break;
      }
      case "phisher": {
        // A hooked, hunched thing trailing a glowing lure.
        this.shape(g, team, "flesh", `phish:${r}`, () => new THREE.ConeGeometry(r * 0.7, r * 1.8, 5), 0, r * 0.9, 0).rotation.x = 0.4;
        this.cyl(g, team, "flesh", r * 0.06, r * 0.06, r * 1.6, 4, 0, r * 1.4, r * 0.4).rotation.x = 0.9;
        const lure = this.shape(g, team, "hot", `phish-lure:${r}`, () => new THREE.SphereGeometry(r * 0.25, 8, 6), 0, r * 1.9, r * 1.4);
        anim(lure, { type: "pulse", amount: 0.3, speed: 6 });
        break;
      }
      case "ddos": {
        // A tiny buzzing cube: they come in swarms.
        const cube = this.shape(g, team, "hot", `ddos:${r}`, () => new THREE.BoxGeometry(r * 1.1, r * 1.1, r * 1.1), 0, r * 1.2, 0);
        anim(cube, { type: "spin", speed: 8, axis: "y" });
        this.shape(g, team, "flesh", `ddos-shell:${r}`, () => new THREE.OctahedronGeometry(r * 0.9, 0), 0, r * 1.2, 0);
        break;
      }
      case "cryptominer": {
        // A tick-like body with a drill, and a coin glowing on its back.
        this.shape(g, team, "flesh", `miner:${r}`, () => new THREE.SphereGeometry(r * 0.8, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, r * 0.2, 0);
        const drill = this.shape(g, team, "hot", `miner-drill:${r}`, () => new THREE.ConeGeometry(r * 0.25, r * 0.9, 6).rotateX(Math.PI / 2), 0, r * 0.4, r * 0.9);
        anim(drill, { type: "spin", speed: 12, axis: "z" });
        const coin = this.shape(g, team, "flame", `miner-coin:${r}`, () => new THREE.CylinderGeometry(r * 0.35, r * 0.35, r * 0.1, 16).rotateX(Math.PI / 2), 0, r * 1.2, -r * 0.1);
        anim(coin, { type: "spin", speed: 3, axis: "y" });
        break;
      }
      case "brute-forcer": {
        // A hulking ram: armoured hump and a battering head.
        this.box(g, team, "flesh", r * 1.4, r * 1.1, r * 1.8, 0, r * 0.2);
        this.shape(g, team, "flesh", `brute-hump:${r}`, () => new THREE.SphereGeometry(r * 0.8, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, r * 1.3, -r * 0.2);
        this.box(g, team, "hot", r * 1.2, r * 0.8, r * 0.5, 0, r * 0.4, r * 1.1);
        for (const x of [-1, 1]) this.shape(g, team, "flesh", `brute-horn:${r}`, () => new THREE.ConeGeometry(r * 0.15, r * 0.8, 5).rotateX(Math.PI / 2), x * r * 0.45, r * 0.9, r * 1.5);
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

      // --- decoys --------------------------------------------------------
      case "moderator": {
        // A tidy white figure with a rose-gold visor and a ban hammer.
        this.shape(g, team, "body", `mod:${r}`, () => new THREE.CapsuleGeometry(r * 0.5, r * 0.9, 4, 10), 0, r * 1, 0);
        this.box(g, team, "glow", r * 0.8, r * 0.18, 0.5, 0, r * 1.45, r * 0.45);
        this.cyl(g, team, "frame", r * 0.08, r * 0.08, r * 1.3, 6, r * 0.65, r * 0.6);
        this.box(g, team, "frame", r * 0.5, r * 0.3, r * 0.3, r * 0.65, r * 1.9);
        break;
      }
      case "platform-owner": {
        // Broad, black turtleneck, standing on a little white podium.
        this.cyl(g, team, "body", r * 1.1, r * 1.2, r * 0.3, 20);
        this.shape(g, team, "dark", `po-body:${r}`, () => new THREE.CapsuleGeometry(r * 0.65, r * 1.0, 4, 12), 0, r * 1.25, 0);
        this.shape(g, team, "body", `po-head:${r}`, () => new THREE.SphereGeometry(r * 0.42, 12, 8), 0, r * 2.35, 0);
        this.cyl(g, team, "glow", r * 1.3, r * 1.3, r * 0.08, 24, 0, r * 0.32);
        break;
      }
      case "lambda": {
        // A fast little wedge, low and leaning forward, with a glowing spine.
        this.shape(g, team, "body", `lambda:${r}`, () => new THREE.ConeGeometry(r * 0.75, r * 1.9, 4).rotateX(Math.PI / 2), 0, r * 0.8, 0);
        this.box(g, team, "glow", r * 0.18, r * 0.25, r * 1.5, 0, r * 1.05, 0);
        this.box(g, team, "frame", r * 1.4, r * 0.15, r * 0.4, 0, r * 0.35, -r * 0.4);
        break;
      }
      case "inference-call": {
        // A floating prism that spins while it runs.
        const prism = this.shape(g, team, "body", `call:${r}`, () => new THREE.OctahedronGeometry(r * 0.9, 0), 0, r * 2.2, 0);
        prism.scale.set(0.8, 1.3, 0.8);
        anim(prism, { type: "spin", speed: 3, axis: "y" });
        this.shape(g, team, "glow", `call-core:${r}`, () => new THREE.SphereGeometry(r * 0.3, 8, 6), 0, r * 2.2, 0);
        break;
      }
      case "function-author": {
        // Light robes, a floating keyboard, and a halo of three tiny function cubes.
        this.cyl(g, team, "body", r * 0.45, r * 0.85, r * 1.9, 8);
        this.shape(g, team, "frame", `fa-head:${r}`, () => new THREE.SphereGeometry(r * 0.42, 12, 8), 0, r * 2.2, 0);
        this.box(g, team, "glow", r * 1.2, r * 0.1, r * 0.45, 0, r * 1.25, r * 0.75);
        const halo = new THREE.Group();
        halo.position.y = r * 2.9;
        for (const [x, z] of [[r * 0.8, 0], [-r * 0.4, r * 0.7], [-r * 0.4, -r * 0.7]] as const) this.box(halo, team, "glow", r * 0.3, r * 0.3, r * 0.3, x, 0, z);
        anim(halo, { type: "spin", speed: 2, axis: "y" });
        g.add(halo);
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

/** A stable small hash of a string, so each model's dressing varies but never changes. */
function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
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

// --- ground items -------------------------------------------------------------

/** The glow colour of an item lying on the ground: nothing else uses it. */
export const PICKUP_COLOR = 0x22d3ee;

let pickupTemplate: THREE.Group | null = null;

/**
 * A glowing pickup for an item lying on the ground: a floating gem over a
 * soft ring, bright enough for bloom to catch it from across the field.
 * Clones share the template's geometry and materials.
 */
export function groundPickup(): THREE.Group {
  if (!pickupTemplate) {
    const g = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: PICKUP_COLOR, toneMapped: false });
    const gem = new THREE.Mesh(geometry("pickup-gem", () => new THREE.OctahedronGeometry(7)), material);
    gem.position.y = 14;
    gem.scale.set(1, 1.5, 1);
    anim(gem, { type: "spin", speed: 1.8, axis: "y" });
    const halo = new THREE.Mesh(geometry("pickup-halo", () => new THREE.TorusGeometry(15, 1.2, 6, 32)), material);
    halo.position.y = 2;
    halo.rotation.x = Math.PI / 2;
    anim(halo, { type: "pulse", amount: 0.2, speed: 2.4 });
    g.add(gem, halo);
    pickupTemplate = g;
  }
  const copy = pickupTemplate.clone(true);
  copy.traverse((node) => {
    if (node.userData.anim) node.userData = { ...node.userData };
  });
  return copy;
}
