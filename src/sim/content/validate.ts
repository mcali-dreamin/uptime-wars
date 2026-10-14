import { RACE_LOOKS, type Content } from "./schema";

/** Fail loudly on broken references so bad content never reaches a match. */
export function validateContent(content: Content): void {
  const errors: string[] = [];

  const ROLES = ["scanner", "phisher", "miner", "jammer", "siege"];
  for (const [id, unit] of Object.entries(content.units)) {
    if (unit.role && !ROLES.includes(unit.role.kind)) errors.push(`unit ${id} has unknown role ${(unit.role as { kind: string }).kind}`);
  }

  for (const [id, building] of Object.entries(content.buildings)) {
    if (building.invoke && !content.units[building.invoke.unit]) errors.push(`building ${id} invokes unknown unit ${building.invoke.unit}`);
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
    for (const [i, rank] of (race.spawnerRanks ?? []).entries()) {
      if (rank.tier < 0 || rank.tier >= content.economy.tiers.length) errors.push(`race ${id} rank ${i + 1} needs a known core tier`);
      if (rank.costPermille <= 0 || rank.ticks <= 0 || rank.hpPermille <= 0 || rank.damagePermille <= 0 || rank.upkeepPermille <= 0) {
        errors.push(`race ${id} rank ${i + 1} needs cost, ticks, hp, damage, and upkeep > 0`);
      }
    }
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
  const spread = content.waves.spread;
  if (!content.units[spread.unit]) errors.push(`spread unit ${spread.unit} is unknown`);
  if (content.buildings[spread.building]?.footprint !== 2) errors.push(`spread building ${spread.building} must exist and be 2x2`);
  if (!(spread.everyWaves >= 1)) errors.push("spread.everyWaves must be at least 1");
  const farm = content.buildings[fortress.farms.building];
  if (!farm?.spawn) errors.push(`fortress farm ${fortress.farms.building} must be a building that spawns`);
  else if (farm.footprint !== 2) errors.push(`fortress farm ${fortress.farms.building} must be 2x2`);
  if (!(fortress.farms.rebuildEvery >= 1)) errors.push("fortress.farms.rebuildEvery must be at least 1");
  if (!content.waves.roster.some((entry) => entry.fromWave <= 1)) errors.push("wave roster needs a unit from wave 1");
  const tierUpgrades = Object.entries(content.upgrades).filter(([, u]) => u.stat === "tier");
  if (tierUpgrades.length > 1) errors.push("only one upgrade can be the core tier");
  const tiers = content.economy.tiers ?? [];
  if (tierUpgrades[0] && tiers.length !== tierUpgrades[0][1].maxLevel + 1) errors.push("economy.tiers needs one entry per core tier (maxLevel + 1)");
  for (const [id, b] of Object.entries(content.buildings)) {
    if (b.tier !== undefined && !tiers[b.tier]) errors.push(`building ${id} needs tier ${b.tier}, which doesn't exist`);
    if (b.limitPerTier && b.limitPerTier.length !== tiers.length) errors.push(`building ${id} limitPerTier needs one entry per tier`);
  }
  for (const [id, race] of Object.entries(content.races)) {
    const perks = race.tierPerks;
    if (perks && perks.length !== tiers.length) errors.push(`race ${id} tierPerks needs one entry per tier`);
    for (const perk of perks ?? []) {
      for (const wall of perk?.mechanics?.thorns?.buildings ?? []) if (!content.buildings[wall]) errors.push(`race ${id} thorns on unknown building ${wall}`);
    }
  }
  for (const [id, unit] of Object.entries(content.units)) {
    if (unit.heal && (unit.heal.perSecond <= 0 || unit.heal.radius <= 0)) errors.push(`unit ${id} heal needs perSecond and radius > 0`);
  }
  for (const [id, race] of Object.entries(content.races)) {
    if (race.center && !content.buildings[race.center]?.buildable) errors.push(`race ${id} has unknown upgrade center ${race.center}`);
    if (race.center && !race.buildings.includes(race.center)) errors.push(`race ${id} can't build its upgrade center ${race.center}`);
  }
  for (const [id, up] of Object.entries(content.upgrades)) {
    if (up.stat === "trait" && (!up.unit || !content.units[up.unit] || !up.trait)) errors.push(`trait ${id} needs a known unit and a trait`);
    if (up.tiers && up.tiers.length !== up.maxLevel) errors.push(`upgrade ${id} tiers needs one entry per level`);
    for (const r of up.races ?? []) if (!content.races[r]) errors.push(`upgrade ${id} names unknown race ${r}`);
  }
  if (errors.length > 0) {
    throw new Error(`Invalid content:\n- ${errors.join("\n- ")}`);
  }
}
