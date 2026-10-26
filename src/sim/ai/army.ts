// A computer player's army: gather, attack, retreat (issue #123).
//
// It only goes on the offence when the match has other players it's hostile
// to; alone against the horde (or in co-op) it defends, so balance runs are
// untouched. Fighting itself is the game's attack-move: units fight whatever
// they meet on the way. This decides when to go, where, and when to come home.
//
// Like a person who knows the map but not who's where, it knows the start
// spots, not which are taken: it walks its army to the nearest unchecked spot
// and learns who's there (or that nobody is). Players found their core where
// they like, so once every spot is checked it goes for the nearest enemy
// building it can find.

import type { AiAttackDef, AiCreepDef, Content } from "../content";
import { computeBalance, squadReserve, unitUpkeep } from "../economy";
import { TICK_RATE, TILE } from "../map";
import { campSpots, type CampSpot } from "../neutrals";
import { isSite } from "../ownership";
import { hasSite } from "../sites";
import { rankedUpkeep, unitRank } from "../ranks";
import { hostile, neutralTeam } from "../teams";
import type { Building, Command, Team, Unit, World } from "../types";
import { BUILDING_SIGHT } from "../tuning";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type Order = DistributiveOmit<Command, "tick" | "team">;
type Point = { x: number; y: number };

/** Close enough to a start spot to say who's there. */
const SPOT_REACHED = BUILDING_SIGHT / 2;
/** How near one of its units must come to an enemy building to notice it. */
const SEES = BUILDING_SIGHT / 2;
/** The army counts as home within this of the core. */
const HOME_REACHED = 400;
/** How far the hero may be from its army before it's sent after it. */
const HERO_SLACK = 350;
/** Most units in one order (the command's own limit is higher; this keeps orders small). */
const ORDER_CHUNK = 60;

const distSq = (a: Point, b: Point) =>
  (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

/** Enemy players still in the match (not the horde). */
function rivals(world: World, team: Team): Team[] {
  return world.teams.filter(
    (t) =>
      t.id !== team.id &&
      t.controller === "human" &&
      t.downTick === null &&
      hostile(world, t.id, team.id),
  );
}

/** Its standing army: alive, takes orders, and won't go cold (bursts stay home and defend). */
function armyOf(world: World, team: Team): Unit[] {
  return world.entities.filter(
    (e): e is Unit =>
      e.kind === "unit" &&
      e.team === team.id &&
      e.mode === "guard" &&
      e.hp > 0 &&
      e.expiresAt === undefined,
  );
}

/** An army's weight: the compute it costs, the same measure as the army cap. */
function strength(content: Content, world: World, units: Unit[]): number {
  let total = 0;
  for (const u of units)
    total += rankedUpkeep(
      unitUpkeep(content, u.defId),
      unitRank(content, world, u),
    );
  return total;
}

/**
 * What a group can do to another in a fight: the damage per second each
 * unit deals times the hp it has left, summed (integers, rounded per unit).
 * One measure for both sides of a camp fight; ranks and armor are left out.
 */
export function power(
  content: Content,
  units: { defId: string; hp: number }[],
): number {
  let total = 0;
  for (const u of units) {
    const def = content.units[u.defId];
    if (!def) continue;
    total += Math.round(
      (Math.max(0, u.hp) * def.damage * TICK_RATE) /
        Math.max(1, def.cooldownTicks),
    );
  }
  return total;
}

function centroid(units: Unit[]): Point {
  let x = 0;
  let y = 0;
  for (const u of units) {
    x += u.x;
    y += u.y;
  }
  return { x: x / units.length, y: y / units.length };
}

const spotPoint = (world: World, i: number): Point => {
  const s = world.terrain.starts[i]!;
  return { x: (s.col + 1) * TILE, y: (s.row + 1) * TILE };
};

/** Standing buildings of these teams. */
function buildingsOf(world: World, teams: Set<number>): Building[] {
  return world.entities.filter(
    (e): e is Building =>
      e.kind === "building" && e.hp > 0 && teams.has(e.team),
  );
}

/** Send units somewhere, in orders small enough for the command. */
function order(
  units: Unit[],
  to: Point,
  attack: boolean,
  issue: (c: Order) => unknown,
): void {
  for (let i = 0; i < units.length; i += ORDER_CHUNK) {
    issue({
      type: "order",
      unitIds: units.slice(i, i + ORDER_CHUNK).map((u) => u.id),
      x: to.x,
      y: to.y,
      attack,
    });
  }
}

/** Camp spots are a pure function of the terrain; work them out once per world's map. */
const spotCache = new WeakMap<object, { neutrals: object; spots: CampSpot[] }>();
function spotsOf(world: World, content: Content): CampSpot[] {
  const hit = spotCache.get(world.terrain);
  if (hit && hit.neutrals === content.neutrals) return hit.spots;
  const spots = campSpots(world.terrain, content.neutrals);
  spotCache.set(world.terrain, { neutrals: content.neutrals, spots });
  return spots;
}
const centerOfCamp = (spot: CampSpot): Point => ({
  x: (spot.col + 0.5) * TILE,
  y: (spot.row + 0.5) * TILE,
});

/** Does any of this team's units or buildings see this point? */
function seesPoint(world: World, team: Team, p: Point): boolean {
  return world.entities.some(
    (e) =>
      e.team === team.id &&
      e.hp > 0 &&
      distSq(e, p) <= BUILDING_SIGHT * BUILDING_SIGHT,
  );
}

const guardsOf = (world: World, camp: number): Unit[] =>
  world.entities.filter(
    (e): e is Unit => e.kind === "unit" && e.campId === camp && e.hp > 0,
  );

const siteOf = (world: World, content: Content, camp: number): Building | null =>
  world.entities.find(
    (e): e is Building =>
      e.kind === "building" &&
      e.campId === camp &&
      e.hp > 0 &&
      isSite(content, e),
  ) ?? null;

/** A camp's power as this team can know it: live guards once seen, else what the camp is made of. */
function campPower(
  world: World,
  content: Content,
  team: Team,
  campId: number,
  spot: CampSpot,
): number {
  if (seesPoint(world, team, centerOfCamp(spot)))
    return power(content, guardsOf(world, campId));
  return power(
    content,
    content.neutrals.tiers[spot.tier]!.units.map((defId) => ({
      defId,
      hp: content.units[defId]?.hp ?? 0,
    })),
  );
}

/** Where to stand to capture a site: on the home side of it, inside the capture radius. */
function approach(content: Content, site: Building, home: Point): Point {
  const reach = Math.min(site.radius + 40, content.neutrals.sites.captureRadius * 0.6);
  const dx = home.x - site.x;
  const dy = home.y - site.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return { x: site.x + (dx / len) * reach, y: site.y + (dy / len) * reach };
}

/** Is the attack's launch condition met (not counting what it'd do)? */
function attackReady(
  world: World,
  content: Content,
  team: Team,
  plan: AiAttackDef,
  army: Unit[],
): boolean {
  if (world.tick < Math.max(plan.firstTicks, team.ai!.until)) return false;
  // As big as it can get for now: full squads, or as far as spare compute
  // stretches, whichever comes first.
  const weight = strength(content, world, army);
  const { supply, demand } = computeBalance(world, content, team);
  const full =
    weight +
    Math.min(squadReserve(world, content, team), Math.max(0, supply - demand));
  return !(
    army.length < plan.minUnits || weight * 1000 < full * plan.armyPermille
  );
}

function launchAttack(
  world: World,
  content: Content,
  team: Team,
  army: Unit[],
  core: Building,
  enemies: Team[],
  reach: number,
  issue: (c: Order) => unknown,
): void {
  const ai = team.ai!;
  ai.phase = "attack";
  ai.group = army.map((u) => u.id);
  ai.launched = strength(content, world, army);
  ai.coreHp = core.hp;
  ai.goal = null;
  ai.goalId = -1;
  steer(world, content, team, army, enemies, reach, issue);
}

/** Pick something to creep (a contested site, a free site, a camp) and set out; false if there's nothing worth it. */
function startCreep(
  world: World,
  content: Content,
  team: Team,
  creep: AiCreepDef,
  army: Unit[],
  home: Point,
  issue: (c: Order) => unknown,
): boolean {
  const ai = team.ai!;
  const spots = spotsOf(world, content);
  const neutral = neutralTeam(world);
  if (!neutral || army.length === 0) return false;
  const range = creep.siteRangeTiles * TILE;
  const go = (
    kind: "camp" | "site" | "contest",
    camp: number,
    units: Unit[],
    to: Point,
    attack: boolean,
  ) => {
    ai.phase = "creep";
    ai.creepKind = kind;
    ai.camp = camp;
    ai.creepSince = world.tick;
    ai.group = units.map((u) => u.id);
    ai.launched = power(content, units);
    ai.goal = null;
    ai.goalId = -2 - camp;
    order(units, to, attack, issue);
    return true;
  };
  const sites: { camp: number; site: Building }[] = [];
  spots.forEach((spot, camp) => {
    if (!hasSite(content.neutrals.sites, spot)) return;
    const site = siteOf(world, content, camp);
    if (
      site &&
      site.team === neutral.id &&
      distSq(site, home) <= range * range
    )
      sites.push({ camp, site });
  });
  const byDistance = (a: { site: Building }, b: { site: Building }) =>
    distSq(a.site, home) - distSq(b.site, home) || a.site.id - b.site.id;

  // A rival is capturing a site near home and it can see it: break it.
  if (army.length >= creep.minUnits) {
    const contested = sites
      .filter(
        ({ site }) =>
          (site.captureProgress ?? 0) > 0 &&
          site.captureTeam !== undefined &&
          hostile(world, site.captureTeam, team.id) &&
          seesPoint(world, team, site),
      )
      .sort(byDistance)[0];
    if (contested)
      return go(
        "contest",
        contested.camp,
        army,
        approach(content, contested.site, home),
        true,
      );
  }

  // A cleared site nobody holds: a few units walk onto it.
  const free = sites
    .filter(({ camp }) => guardsOf(world, camp).length === 0)
    .sort(byDistance)[0];
  if (free) {
    const to = approach(content, free.site, home);
    const sent = [...army]
      .sort((a, b) => distSq(a, to) - distSq(b, to) || a.id - b.id)
      .slice(0, creep.siteUnits);
    return go("site", free.camp, sent, to, false);
  }

  // The nearest standing camp it's allowed and able to beat.
  if (army.length < creep.minUnits) return false;
  const mine = power(content, army);
  let best = -1;
  let bestD = Infinity;
  spots.forEach((spot, camp) => {
    if (!creep.tiers.includes(spot.tier)) return;
    if (guardsOf(world, camp).length === 0) return;
    if (mine * 1000 < campPower(world, content, team, camp, spot) * creep.oddsPermille)
      return;
    const d = distSq(centerOfCamp(spot), home);
    if (d < bestD) {
      best = camp;
      bestD = d;
    }
  });
  if (best < 0) return false;
  return go("camp", best, army, centerOfCamp(spots[best]!), true);
}

/** One step of a creep under way: keep the group on its job, or send it home when done. */
function playCreep(
  world: World,
  content: Content,
  team: Team,
  creep: AiCreepDef,
  plan: AiAttackDef,
  group: Unit[],
  home: Point,
  issue: (c: Order) => unknown,
): void {
  const ai = team.ai!;
  const done = () =>
    retreat(world, team, home, plan, issue, creep.cooldownTicks);
  const neutral = neutralTeam(world);
  const spot = spotsOf(world, content)[ai.camp];
  if (!spot || !neutral) return done();
  // Send the group once per goal; a new goal id re-sends.
  const send = (id: number, to: Point, attack: boolean) => {
    if (ai.goalId === id) return;
    ai.goalId = id;
    order(group, to, attack, issue);
  };
  if (ai.creepKind === "camp") {
    if (guardsOf(world, ai.camp).length > 0)
      return send(-2 - ai.camp, centerOfCamp(spot), true);
    if (!hasSite(content.neutrals.sites, spot)) return done();
    ai.creepKind = "site";
  }
  const site = siteOf(world, content, ai.camp);
  // Taken (by anyone, us included), or gone: the job is over.
  if (!site || site.team !== neutral.id) return done();
  const to = approach(content, site, home);
  if (ai.creepKind === "contest") {
    const arrived = group.some(
      (u) =>
        distSq(u, site) <=
        content.neutrals.sites.captureRadius * content.neutrals.sites.captureRadius,
    );
    const rivalBuilding =
      (site.captureProgress ?? 0) > 0 &&
      site.captureTeam !== undefined &&
      hostile(world, site.captureTeam, team.id);
    if (!arrived || rivalBuilding) return send(-2 - ai.camp, to, true);
    // Broken: take it instead.
    ai.creepKind = "site";
  }
  send(-1000 - ai.camp, to, false);
}

export function playArmy(
  world: World,
  content: Content,
  team: Team,
  plan: AiAttackDef,
  issue: (c: Order) => unknown,
): void {
  const ai = team.ai!;
  const enemies = rivals(world, team);
  const core = world.entities.find((e) => e.id === team.coreId);
  if (!core || core.kind !== "building") return;
  const home: Point = { x: core.x, y: core.y };
  // Creeping, like attacking, is only for matches with rivals.
  const creep = content.difficulties[ai.difficulty]?.creep ?? null;
  if (enemies.length === 0) {
    if (ai.phase === "attack" || ai.phase === "creep")
      retreat(world, team, home, plan, issue);
    return;
  }
  const reach = creep ? creep.siteRangeTiles * TILE : 0;
  const army = armyOf(world, team);
  const inGroup = new Set(ai.group);
  const group = army.filter((u) => inGroup.has(u.id));
  ai.group = group.map((u) => u.id);
  const homeHit =
    core.hp < ai.coreHp &&
    core.hp * 1000 < core.maxHp * plan.recallBelowPermille;
  ai.coreHp = core.hp;

  if (ai.phase === "retreat") {
    if (
      group.length === 0 ||
      distSq(centroid(group), home) <= HOME_REACHED * HOME_REACHED ||
      world.tick >= ai.until
    ) {
      ai.phase = "gather";
      ai.group = [];
    }
    return;
  }

  if (ai.phase === "gather") {
    // Attacking a rival always wins over creeping.
    if (attackReady(world, content, team, plan, army)) {
      launchAttack(world, content, team, army, core, enemies, reach, issue);
      return;
    }
    if (
      creep &&
      !homeHit &&
      world.tick >= Math.max(creep.firstTicks, ai.until)
    )
      startCreep(world, content, team, creep, army, home, issue);
    return;
  }

  if (ai.phase === "creep") {
    if (!creep) return retreat(world, team, home, plan, issue);
    if (
      group.length === 0 ||
      homeHit ||
      world.tick - ai.creepSince >= creep.giveUpTicks ||
      power(content, group) * 1000 < ai.launched * creep.retreatPermille
    ) {
      retreat(world, team, home, plan, issue);
      return;
    }
    // The attack's conditions are met: that goes first.
    if (attackReady(world, content, team, plan, army)) {
      launchAttack(world, content, team, army, core, enemies, reach, issue);
      return;
    }
    playCreep(world, content, team, creep, plan, group, home, issue);
    return;
  }

  // Attacking.
  // Home under attack (the core low and losing hp), or the army spent: come back.
  const weight = strength(content, world, group);
  if (
    group.length === 0 ||
    weight * 1000 < ai.launched * plan.retreatPermille ||
    homeHit
  ) {
    retreat(world, team, home, plan, issue);
    return;
  }
  steer(world, content, team, group, enemies, reach, issue);
}

/**
 * Point the group at what to hit next: the core of the nearest enemy it
 * has found, else the nearest start spot it hasn't checked, else (every spot
 * checked) the nearest enemy building anywhere.
 */
function steer(
  world: World,
  content: Content,
  team: Team,
  group: Unit[],
  enemies: Team[],
  siteReach: number,
  issue: (c: Order) => unknown,
): void {
  const ai = team.ai!;
  const at = centroid(group);
  const alive = new Set(enemies.map((t) => t.id));
  ai.known = ai.known.filter((id) => alive.has(id));
  const sees = (p: Point, range: number) =>
    group.some((u) => distSq(u, p) <= range * range);

  // Any of its units reached the spot it was checking: it's been looked at.
  if (
    ai.goal !== null &&
    ai.goal >= 0 &&
    sees(spotPoint(world, ai.goal), SPOT_REACHED)
  ) {
    if (!ai.checked.includes(ai.goal)) ai.checked.push(ai.goal);
    ai.goal = null;
  }
  // Any enemy building one of its units comes near: that player's found.
  for (const b of buildingsOf(world, alive)) {
    if (!ai.known.includes(b.team) && sees(b, SEES)) ai.known.push(b.team);
  }

  let target: Point | null = null;
  let targetId = -1;
  const known = buildingsOf(world, new Set(ai.known));
  const spots = world.terrain.starts
    .map((_, i) => i)
    .filter((i) => i !== team.id && !ai.checked.includes(i));
  // Rival-held sites near home that one of its units has seen.
  const seenSites = buildingsOf(world, alive).filter(
    (b) =>
      isSite(content, b) &&
      distSq(b, core0(world, team)) <= siteReach * siteReach &&
      sees(b, BUILDING_SIGHT),
  );
  if (known.length > 0) {
    // Go for the nearest found enemy's core (attack-moving, so it fights
    // whatever's in the way); its other buildings only once the core is down.
    const b = nearest(known, at);
    const core = world.entities.find(
      (e) => e.id === world.teams[b.team]!.coreId && e.hp > 0,
    );
    const aim = core ?? b;
    target = { x: aim.x, y: aim.y };
    targetId = aim.id;
    ai.goal = null;
  } else if (seenSites.length > 0) {
    const b = nearest(seenSites, at);
    target = { x: b.x, y: b.y };
    targetId = b.id;
    ai.goal = null;
  } else if (spots.length > 0) {
    const i =
      ai.goal !== null && ai.goal >= 0 && spots.includes(ai.goal)
        ? ai.goal
        : nearest(
            spots.map((s) => ({ s, ...spotPoint(world, s) })),
            at,
          ).s;
    ai.goal = i;
    target = spotPoint(world, i);
    targetId = -2 - i;
  } else {
    const anywhere = buildingsOf(world, alive);
    if (anywhere.length === 0) return;
    const b = nearest(anywhere, at);
    if (!ai.known.includes(b.team)) ai.known.push(b.team);
    target = { x: b.x, y: b.y };
    targetId = b.id;
  }
  // Same target as last time: they're on their way, leave them be.
  if (targetId === ai.goalId) return;
  ai.goalId = targetId;
  order(group, target, true, issue);
}

const core0 = (world: World, team: Team): Point => {
  const c = world.entities.find((e) => e.id === team.coreId);
  return c ? { x: c.x, y: c.y } : { x: 0, y: 0 };
};

function nearest<T extends Point>(items: T[], from: Point): T {
  let best = items[0]!;
  let bestD = distSq(best, from);
  for (const item of items) {
    const d = distSq(item, from);
    if (d < bestD) {
      best = item;
      bestD = d;
    }
  }
  return best;
}

function retreat(
  world: World,
  team: Team,
  home: Point,
  plan: AiAttackDef,
  issue: (c: Order) => unknown,
  cooldown: number = plan.cooldownTicks,
): void {
  const ai = team.ai!;
  const inGroup = new Set(ai.group);
  const group = armyOf(world, team).filter((u) => inGroup.has(u.id));
  // Walk, don't fight: the point is to get home alive. Then fight there.
  order(group, home, false, issue);
  ai.phase = "retreat";
  ai.goal = null;
  ai.goalId = -1;
  ai.until = world.tick + cooldown;
}

/**
 * The hero goes with an attack and comes home when hurt (cores heal heroes)
 * or when there's no attack on. Move orders: a hero on the move doesn't stop
 * to fight, so it's only moved when it's well away from where it should be.
 */
export function moveHero(
  world: World,
  team: Team,
  plan: AiAttackDef,
  issue: (c: Order) => unknown,
): void {
  const ai = team.ai!;
  const hero = team.hero
    ? world.entities.find(
        (e): e is Unit => e.id === team.hero!.unitId && e.kind === "unit",
      )
    : undefined;
  const core = world.entities.find((e) => e.id === team.coreId);
  if (!hero || hero.hp <= 0 || !core || team.hero!.cast) return;
  const hurt = hero.hp * 1000 < hero.maxHp * plan.heroRetreatPermille;
  const inGroup = new Set(ai.group);
  const group =
    (ai.phase === "attack" || ai.phase === "creep") && !hurt
      ? armyOf(world, team).filter((u) => inGroup.has(u.id))
      : [];
  const where = group.length > 0 ? centroid(group) : { x: core.x, y: core.y };
  const slack = group.length > 0 ? HERO_SLACK : HOME_REACHED;
  if (
    distSq(hero, where) > slack * slack &&
    !(hero.moveTo && distSq(hero.moveTo, where) <= HERO_SLACK * HERO_SLACK)
  ) {
    issue({ type: "move", x: where.x, y: where.y });
  }
}
