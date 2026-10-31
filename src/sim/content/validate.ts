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
  for (const [id, d] of Object.entries(content.difficulties)) {
    if (d.heroEveryTicks <= 0 || d.buildEveryTicks <= 0) errors.push(`difficulty ${id} needs heroEveryTicks and buildEveryTicks > 0`);
    if (d.maxTier < 0 || d.maxTier >= content.economy.tiers.length) errors.push(`difficulty ${id} maxTier needs a known core tier`);
    if (d.revenuePermille <= 0) errors.push(`difficulty ${id} needs revenuePermille > 0`);
    if (d.creep) {
      const c = d.creep;
      for (const tier of c.tiers) if (!content.neutrals.tiers[tier]) errors.push(`difficulty ${id} creeps unknown camp tier ${tier}`);
      if (c.minUnits <= 0 || c.siteUnits <= 0) errors.push(`difficulty ${id} creep needs minUnits and siteUnits > 0`);
      if (c.oddsPermille <= 0 || c.giveUpTicks <= 0 || c.siteRangeTiles <= 0) errors.push(`difficulty ${id} creep needs oddsPermille, giveUpTicks and siteRangeTiles > 0`);
      if (c.retreatPermille < 0 || c.retreatPermille > 1000) errors.push(`difficulty ${id} creep retreatPermille must be 0-1000`);
      if (c.firstTicks < 0 || c.cooldownTicks < 0) errors.push(`difficulty ${id} creep needs firstTicks and cooldownTicks >= 0`);
    }
  }
  for (const [id, race] of Object.entries(content.races)) {
    const core = content.buildings[race.core];
    if (!core) errors.push(`race ${id} has unknown core ${race.core}`);
    else if (core.footprint !== 2) errors.push(`race ${id} core ${race.core} must have a 2x2 footprint`);
    else if (race.controller === "human" && !core.buildRadius) errors.push(`race ${id} core ${race.core} needs a buildRadius`);
    else if (race.buildings.includes(race.core)) errors.push(`race ${id} lists its core ${race.core} in its build roster: cores come from a deploy agent`);
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
  for (const [i, rank] of (content.waves.ranks?.levels ?? []).entries()) {
    if (rank.hpPermille <= 0 || rank.damagePermille <= 0 || (rank.worth ?? 1) <= 0) errors.push(`creep rank ${i + 1} needs hp, damage, and worth > 0`);
  }
  if (content.waves.ranks && content.waves.ranks.maxUnits < 1) errors.push("creep ranks need maxUnits >= 1");
  for (const entry of content.waves.roster) {
    if (!content.units[entry.unit]) errors.push(`wave roster uses unknown unit ${entry.unit}`);
    if (entry.cost <= 0) errors.push(`wave roster unit ${entry.unit} must cost more than 0`);
  }
  const camps = content.neutrals;
  if (camps.regenPermillePerSecond < 0 || camps.alertTicks < 0 || !(camps.xpPerBounty >= 0)) errors.push("neutrals need regenPermillePerSecond, alertTicks and xpPerBounty >= 0");
  for (const [id, tier] of Object.entries(camps.tiers)) {
    if (tier.fromStart <= 0 || tier.count < 0 || tier.units.length === 0) errors.push(`camp tier ${id} needs fromStart > 0, count >= 0 and units`);
    for (const unit of tier.units) if (!content.units[unit]) errors.push(`camp tier ${id} uses unknown unit ${unit}`);
  }
  const sites = camps.sites;
  const siteDef = content.buildings[sites.building];
  if (!siteDef) errors.push(`sites use unknown building ${sites.building}`);
  else if (!siteDef.site) errors.push(`sites building ${sites.building} needs site: true`);
  else if (siteDef.buildable) errors.push(`site building ${sites.building} must not be buildable`);
  for (const tier of sites.tiers) if (!camps.tiers[tier]) errors.push(`sites use unknown camp tier ${tier}`);
  if (!(sites.captureRadius > 0) || !Number.isInteger(sites.captureTicks) || sites.captureTicks < 1) errors.push("sites need captureRadius > 0 and integer captureTicks >= 1");
  if (!(sites.rearmPermille > 0 && sites.rearmPermille <= 1000) || !(sites.regenPermillePerSecond >= 0)) errors.push("sites need rearmPermille in 1..1000 and regenPermillePerSecond >= 0");
  if (content.races.neutral?.controller !== "neutral") errors.push("races needs a neutral race with controller neutral");
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
  for (const [i, tier] of tiers.entries()) {
    if (!Number.isInteger(tier.expansions) || tier.expansions < 0) errors.push(`economy.tiers[${i}].expansions must be a non-negative integer`);
  }
  const spot = content.economy.spot;
  if (!spot) errors.push("economy.spot is missing");
  else {
    if (spot.compute.length !== tiers.length || spot.cost.length !== tiers.length) errors.push("economy.spot needs one compute and cost per core tier");
    if ([...spot.compute, ...spot.cost].some((n) => !Number.isInteger(n) || n <= 0)) errors.push("economy.spot compute and cost must be positive integers");
    if (!Number.isInteger(spot.growthPermille) || spot.growthPermille < 0) errors.push("economy.spot.growthPermille must be a non-negative integer");
    if (!Number.isInteger(spot.ticks) || spot.ticks <= 0) errors.push("economy.spot.ticks must be a positive integer");
  }
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
  if (!(content.items.shopRadius > 0)) errors.push("items shopRadius must be a positive number");
  for (const [id, item] of Object.entries(content.items.items)) {
    if (item.cost <= 0) errors.push(`item ${id} needs cost > 0`);
    if (item.charges !== undefined && item.charges < 1) errors.push(`item ${id} charges must be at least 1`);
    if (item.active && !item.charges) errors.push(`item ${id} has an active, so it needs charges`);
    if (item.active && (item.active.amount <= 0 || item.active.radius <= 0)) errors.push(`item ${id} active needs amount and radius > 0`);
    const stats = item.stats ?? {};
    for (const [stat, value] of Object.entries(stats)) {
      if (!(value! > 0)) errors.push(`item ${id} stat ${stat} must be > 0`);
    }
  }
  for (const [i, entry] of content.items.drops.table.entries()) {
    if (!content.items.items[entry.item]) errors.push(`drop table ${i + 1} rolls unknown item ${entry.item}`);
    if (entry.weight <= 0) errors.push(`drop table ${i + 1} needs weight > 0`);
  }
  for (const source of ["farm", "c2", "boss"] as const) {
    const chance = content.items.drops[source];
    if (!(chance >= 0 && chance <= 1000)) errors.push(`drop chance ${source} must be a permille between 0 and 1000`);
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
