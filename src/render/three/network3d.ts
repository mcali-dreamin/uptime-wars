// Your network on the ground: where you can build, always visible. A texture
// at two texels per tile marks the area every network building of yours
// reaches; the ground shader tints it faintly in your colour and draws a
// bright line where it ends, so overlapping reaches read as one territory.
// Brighter while you're placing a building.

import * as THREE from "three";
import { TILE, networkProviders, reachOf, type Content, type TeamId, type World } from "../../sim";

const SUB = 2;

export class NetworkOverlay {
  readonly uniforms = {
    uNet: { value: null as THREE.DataTexture | null },
    uNetColor: { value: new THREE.Color(0x4ade80) },
    uNetStrength: { value: 0 },
  };
  private data = new Uint8Array(1);
  private w = 0;
  private h = 0;
  private key = "";

  setWorld(world: World): void {
    this.w = world.terrain.cols * SUB;
    this.h = world.terrain.rows * SUB;
    this.data = new Uint8Array(this.w * this.h);
    const texture = new THREE.DataTexture(this.data, this.w, this.h, THREE.RedFormat, THREE.UnsignedByteType);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.uniforms.uNet.value?.dispose();
    this.uniforms.uNet.value = texture;
    this.key = "";
  }

  /** Recompute only when your network buildings (or their reach) change. */
  update(world: World, content: Content, team: TeamId, color: number, placing: boolean): void {
    this.uniforms.uNetColor.value.setHex(color);
    this.uniforms.uNetStrength.value = placing ? 1 : 0.45;
    const texture = this.uniforms.uNet.value;
    if (!texture) return;
    const providers = networkProviders(world, content, team).map((p) => ({ x: p.x, y: p.y, r: reachOf(world, content, p) }));
    const key = providers.map((p) => `${p.x},${p.y},${p.r}`).join(";");
    if (key === this.key) return;
    this.key = key;
    const data = this.data;
    data.fill(0);
    const cell = TILE / SUB;
    for (const p of providers) {
      const c0 = Math.max(0, Math.floor((p.x - p.r) / cell));
      const c1 = Math.min(this.w - 1, Math.ceil((p.x + p.r) / cell));
      const r0 = Math.max(0, Math.floor((p.y - p.r) / cell));
      const r1 = Math.min(this.h - 1, Math.ceil((p.y + p.r) / cell));
      for (let r = r0; r <= r1; r += 1) {
        const dy = (r + 0.5) * cell - p.y;
        for (let c = c0; c <= c1; c += 1) {
          const dx = (c + 0.5) * cell - p.x;
          if (dx * dx + dy * dy <= p.r * p.r) data[r * this.w + c] = 255;
        }
      }
    }
    texture.needsUpdate = true;
  }
}

/** GLSL for the ground shader: emissive tint inside, bright line at the edge. */
export const NETWORK_GLSL_HEAD = /* glsl */ `
  uniform sampler2D uNet;
  uniform vec3 uNetColor;
  uniform float uNetStrength;
`;

export const NETWORK_GLSL_EMISSIVE = /* glsl */ `
  {
    float net = texture2D(uNet, vFogWorld.xz / uFogSize).r;
    float inside = smoothstep(0.35, 0.65, net);
    float edge = 1.0 - smoothstep(0.0, 0.16, abs(net - 0.5));
    float flatGround = 1.0 - gTerrainSteep;
    totalEmissiveRadiance += uNetColor * flatGround * uNetStrength * (inside * 0.07 + edge * 0.55);
  }
`;
