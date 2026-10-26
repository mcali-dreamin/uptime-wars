// The environment map: what metal, glass and glossy paint reflect. Not a
// visible sky (the camera looks down at the ground), just light from around:
// a deep navy dome, a violet horizon glow, a dark floor, and a few soft
// panels (cool and warm) so polished surfaces show shaped highlights instead
// of black with one hot spot. Built once into a PMREM texture.

import * as THREE from "three";

export function cyberEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(100, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          float y = vDir.y;
          vec3 zenith = vec3(0.06, 0.1, 0.22);
          vec3 horizon = vec3(0.24, 0.14, 0.4);
          vec3 floor_ = vec3(0.03, 0.025, 0.05);
          vec3 col = y > 0.0 ? mix(horizon, zenith, pow(y, 0.6)) : mix(horizon, floor_, pow(-y, 0.4));
          gl_FragColor = vec4(col, 1.0);
        }`,
    }),
  );
  scene.add(dome);
  // Soft panels: a big cool one overhead, a warm one low on the sun's side,
  // a teal one opposite. They give glossy surfaces readable reflections.
  const panel = (color: number, intensity: number, w: number, h: number, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
    );
    mesh.position.set(x, y, z);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  };
  panel(0xb8ccff, 0.55, 50, 50, 0, 80, 0);
  panel(0xffc890, 2.2, 60, 20, -60, 30, -40);
  panel(0x40e0d0, 1.2, 50, 16, 60, 20, 50);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(scene, 0.04).texture;
  pmrem.dispose();
  scene.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry.dispose();
      (node.material as THREE.Material).dispose();
    }
  });
  return texture;
}
