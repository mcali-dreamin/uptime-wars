import * as THREE from "three";

/** Static fortifications share geometry/material batches, like terrain's many-copy meshes. */
export class Fortifications {
  readonly object = new THREE.Group();
  private readonly batches = new Map<string, { mesh: THREE.InstancedMesh; matrices: THREE.Matrix4[] }>();

  begin(): void {
    for (const batch of this.batches.values()) batch.matrices.length = 0;
  }

  add(object: THREE.Group): void {
    object.updateMatrixWorld(true);
    object.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const material = node.material as THREE.Material;
      const key = `${node.geometry.uuid}:${material.uuid}`;
      let batch = this.batches.get(key);
      if (!batch) {
        const mesh = new THREE.InstancedMesh(node.geometry, material, 128);
        mesh.castShadow = node.castShadow;
        mesh.receiveShadow = node.receiveShadow;
        // Positions change as walls are placed/destroyed; don't retain stale bounds.
        mesh.frustumCulled = false;
        this.object.add(mesh);
        batch = { mesh, matrices: [] };
        this.batches.set(key, batch);
      }
      batch.matrices.push(node.matrixWorld.clone());
    });
  }

  end(): void {
    for (const batch of this.batches.values()) {
      if (batch.matrices.length > batch.mesh.instanceMatrix.count) {
        const old = batch.mesh;
        batch.mesh = new THREE.InstancedMesh(old.geometry, old.material, batch.matrices.length * 2);
        batch.mesh.castShadow = old.castShadow;
        batch.mesh.receiveShadow = old.receiveShadow;
        batch.mesh.frustumCulled = false;
        this.object.remove(old);
        old.dispose();
        this.object.add(batch.mesh);
      }
      batch.mesh.count = batch.matrices.length;
      batch.matrices.forEach((matrix, i) => batch.mesh.setMatrixAt(i, matrix));
      batch.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  clear(): void {
    for (const { mesh } of this.batches.values()) mesh.dispose();
    this.batches.clear();
    this.object.clear();
  }
}
