import { RACE_LOOKS, type Content } from "./schema";

/** Fail loudly on broken references so bad content never reaches a match. */
export function validateContent(content: Content): void {
  const errors: string[] = [];

  const ROLES = ["scanner", "phisher", "miner", "jammer", "siege"];
  for (const [id, unit] of Object.entries(content.units)) {
    if (unit.role && !ROLES.includes(unit.role.kind)) errors.push(`unit ${id} has unknown role ${(unit.role as { kind: string }).kind}`);
  }

  for (const [id, building] of Object.entries(content.buildings)) {
    if (building.onWell && building.footprint !== 1) errors.push(`building ${id} goes on a well, so it must be 1x1`);
    if (building.invoke && !content.units[building.invoke.unit]) errors.push(`building ${id} invokes unknown unit ${building.invoke.unit}`);
    if (building.invoke && building.spawn) errors.push(`building ${id} can't both spawn and invoke`);
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
    if (race.controller === "human" && !RACE_LOOKS.includes(race.look!)) errors.push(`race ${id} needs a look (${RACE_LOOKS.join(", ")})`);
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
  for (const [id, race] of Object.entries(content.races)) {
    for (const hero of race.heroes ?? []) {
      if (!content.units[hero]) errors.push(`race ${id} has unknown hero unit ${hero}`);
      if (!content.heroes.heroes[hero]) errors.push(`race ${id} hero ${hero} has no entry in heroes.json`);
    }
  }
  for (const [id, hero] of Object.entries(content.heroes.heroes)) {
    if (hero.abilities.length > 4) errors.push(`hero ${id} has more than 4 abilities (hotkeys 1-4)`);
    for (const ability of hero.abilities) if (!content.heroes.abilities[ability]) errors.push(`hero ${id} has unknown ability ${ability}`);
  }
  for (const [id, ability] of Object.entries(content.heroes.abilities)) {
    if (ability.effect === "summon" && (!ability.unit || !content.units[ability.unit] || !ability.durationTicks || ability.amount < 1)) {
      errors.push(`ability ${id} summons: it needs a known unit, durationTicks, and amount >= 1`);
    }
    if (ability.effect === "buff" && (!ability.durationTicks || ability.amount <= 0)) errors.push(`ability ${id} buffs: it needs durationTicks and amount > 0`);
    if (ability.effect === "decoy" && (!ability.unit || !content.units[ability.unit] || !ability.durationTicks || !ability.radius)) {
      errors.push(`ability ${id} is a decoy: it needs a known unit, durationTicks, and radius`);
    }
    if ((ability.effect === "blast" || ability.effect === "heal") && !ability.radius) errors.push(`ability ${id} needs a radius`);
    if (ability.effect === "strike" && ability.target !== "enemy") errors.push(`ability ${id} strikes, so it targets an enemy`);
    if (ability.target === "self" && ability.range !== 0) errors.push(`ability ${id} targets self, so its range is 0`);
  }
  if (!content.units[content.waves.bosses.unit]) errors.push(`wave boss is unknown unit ${content.waves.bosses.unit}`);
  const fortress = content.waves.fortress;
  if (!content.buildings[fortress.building]?.attack) errors.push(`fortress building ${fortress.building} must be a building that shoots`);
  if (!(fortress.rebuildEvery >= 1)) errors.push("fortress.rebuildEvery must be at least 1");
  const farm = content.buildings[fortress.farms.building];
  if (!farm?.spawn) errors.push(`fortress farm ${fortress.farms.building} must be a building that spawns`);
  else if (farm.footprint !== 2) errors.push(`fortress farm ${fortress.farms.building} must be 2x2`);
  if (!(fortress.farms.rebuildEvery >= 1)) errors.push("fortress.farms.rebuildEvery must be at least 1");
  if (!content.waves.roster.some((entry) => entry.fromWave <= 1)) errors.push("wave roster needs a unit from wave 1");
  if (errors.length > 0) {
    throw new Error(`Invalid content:\n- ${errors.join("\n- ")}`);
  }
}
