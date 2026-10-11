import type { Content } from "./schema";

/** Fail loudly on broken references so bad content never reaches a match. */
export function validateContent(content: Content): void {
  const errors: string[] = [];

  for (const [id, building] of Object.entries(content.buildings)) {
    if (building.onWell && building.footprint !== 1) errors.push(`building ${id} goes on a well, so it must be 1x1`);
    if (building.spawn && !content.units[building.spawn.unit]) {
      errors.push(`building ${id} spawns unknown unit ${building.spawn.unit}`);
    }
  }
  for (const [id, race] of Object.entries(content.races)) {
    const core = content.buildings[race.core];
    if (!core) errors.push(`race ${id} has unknown core ${race.core}`);
    else if (core.footprint !== 2) errors.push(`race ${id} core ${race.core} must have a 2x2 footprint`);
    else if (race.controller === "human" && !core.buildRadius) errors.push(`race ${id} core ${race.core} needs a buildRadius`);
    if (race.builder && !content.units[race.builder]) errors.push(`race ${id} has unknown builder ${race.builder}`);
    for (const buildingId of race.buildings) {
      const building = content.buildings[buildingId];
      if (!building) errors.push(`race ${id} lists unknown building ${buildingId}`);
      else if (!building.buildable) errors.push(`race ${id} lists unbuildable ${buildingId}`);
    }
  }
  for (const entry of content.waves.roster) {
    if (!content.units[entry.unit]) errors.push(`wave roster uses unknown unit ${entry.unit}`);
    if (entry.cost <= 0) errors.push(`wave roster unit ${entry.unit} must cost more than 0`);
  }
  for (const [id, upgrade] of Object.entries(content.upgrades)) {
    if (upgrade.maxLevel < 1 || upgrade.cost <= 0 || upgrade.researchTicks <= 0) errors.push(`upgrade ${id} needs maxLevel, cost, and researchTicks > 0`);
  }
  if (!content.units[content.waves.bosses.unit]) errors.push(`wave boss is unknown unit ${content.waves.bosses.unit}`);
  if (!content.waves.roster.some((entry) => entry.fromWave <= 1)) errors.push("wave roster needs a unit from wave 1");
  if (errors.length > 0) {
    throw new Error(`Invalid content:\n- ${errors.join("\n- ")}`);
  }
}
