import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Models, type Look } from "../src/render/three/models";
import { FogTexture } from "../src/render/three/fog3d";
import { Fortifications } from "../src/render/three/fortifications";
import { content } from "./fixtures";

describe("shared fortification rendering", () => {
  it.each(["scrappy", "monolith", "ephemeral", "garden"] as Look[])("%s walls share batches across dozens of copies", (look) => {
    const models = new Models(new FogTexture());
    const batch = new Fortifications();
    batch.begin();
    for (let i = 0; i < 150; i++) {
      const wall = models.make("wall", 0x4488ff, 48, false, look, "wall");
      wall.position.x = i * 48;
      wall.traverse((node) => expect(node.userData.anim).toBeUndefined());
      batch.add(wall);
    }
    batch.end();
    expect(batch.object.children.length).toBeLessThanOrEqual(4);
    for (const child of batch.object.children) expect((child as THREE.InstancedMesh).count).toBe(150);
    batch.begin();
    batch.end();
    for (const child of batch.object.children) expect((child as THREE.InstancedMesh).count).toBe(0);
    batch.clear();
    expect(batch.object.children).toHaveLength(0);
  });

  it("Serverless has a cheaper, weaker defensive tower with an ephemeral model", () => {
    const tower = content.buildings["edge-sentinel"]!;
    const firewall = content.buildings.firewall!;
    expect(content.races.serverless!.buildings).toContain("edge-sentinel");
    expect(tower.cost).toBeLessThan(firewall.cost);
    expect(tower.hp).toBeLessThan(firewall.hp);
    expect(tower.attack!.damage).toBeLessThan(firewall.attack!.damage);
    const model = new Models(new FogTexture()).make("edge-sentinel", 0x4488ff, 48, false, "ephemeral", "tower");
    expect(model.children.length).toBeGreaterThan(0);
  });
});
