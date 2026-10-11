// Fog of war on the GPU. The shell's per-tile fog becomes a one-texel-per-tile
// texture with linear filtering (soft edges for free), and any material can
// be "fogged": it darkens by that texture at its own world position, so
// terrain, props, and remembered buildings all agree.

import * as THREE from "three";
import { TILE, type Terrain } from "../../sim";
import type { Fog } from "../fog";

/** Brightness kept for explored-but-not-visible ground, 0..255. */
const EXPLORED = 105;

export class FogTexture {
  readonly uniforms = {
    uFog: { value: null as THREE.DataTexture | null },
    uFogSize: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
  };
  private data = new Uint8Array(1);
  private cols = 0;
  private version = -1;

  setTerrain(terrain: Terrain): void {
    this.cols = terrain.cols;
    this.data = new Uint8Array(terrain.cols * terrain.rows);
    const texture = new THREE.DataTexture(this.data, terrain.cols, terrain.rows, THREE.RedFormat, THREE.UnsignedByteType);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.uniforms.uFog.value?.dispose();
    this.uniforms.uFog.value = texture;
    this.uniforms.uFogSize.value.set(terrain.cols * TILE, terrain.rows * TILE);
    this.version = -1;
  }

  update(fog: Fog, timeSeconds: number): void {
    this.uniforms.uTime.value = timeSeconds;
    if (fog.version === this.version || !this.uniforms.uFog.value) return;
    this.version = fog.version;
    const { data } = this;
    for (let i = 0; i < data.length; i += 1) {
      const state = fog.stateAt(i);
      data[i] = state === 2 ? 255 : state === 1 ? EXPLORED : 0;
    }
    this.uniforms.uFog.value.needsUpdate = true;
  }

  get columns(): number {
    return this.cols;
  }

  /**
   * Patch a built-in material so it darkens by the fog. `extra` can inject
   * more fragment code that runs on the lit colour (gl_FragColor) first.
   */
  apply<T extends THREE.Material>(material: T, extra?: FogExtra): T {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, extra?.uniforms ?? {});
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\nvarying vec3 vFogWorld;\n${extra?.vertex ?? ""}`)
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>
          #ifdef USE_INSTANCING
            vFogWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          #else
            vFogWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          #endif`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FOG_GLSL}`)
        .replace(
          "#include <tonemapping_fragment>",
          `${extra?.fragment ?? ""}\ngl_FragColor.rgb *= fogLight(vFogWorld.xz);\n#include <tonemapping_fragment>`,
        );
      extra?.patch?.(shader);
    };
    material.customProgramCacheKey = () => `fog:${extra?.key ?? ""}`;
    return material;
  }
}

export interface FogExtra {
  /** Distinguishes differently patched programs. */
  key?: string;
  vertex?: string;
  fragment?: string;
  uniforms?: Record<string, THREE.IUniform>;
  /** Further edits to the shader source, after the fog patch. */
  patch?: (shader: THREE.WebGLProgramParametersWithUniforms) => void;
}

/** Shared GLSL: fog brightness at a world xz. Usable from raw ShaderMaterials too. */
export const FOG_GLSL = /* glsl */ `
  uniform sampler2D uFog;
  uniform vec2 uFogSize;
  uniform float uTime;
  varying vec3 vFogWorld;
  float fogLight(vec2 xz) {
    vec2 uv = xz / uFogSize;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
    float f = texture2D(uFog, uv).r;
    return smoothstep(0.0, 1.0, f);
  }
`;
