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

import type { AiAttackDef, Content } from "../content";
import { computeBalance, squadReserve, unitUpkeep } from "../economy";
import { TILE } from "../map";
import { rankedUpkeep, unitRank } from "../ranks";
import { hostile } from "../teams";
import type { Building, Command, Team, Unit, World } from "../types";
import { BUILDING_SIGHT } from "../tuning";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
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

const distSq = (a: Point, b: Point) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

/** Enemy players still in the match (not the horde). */
function rivals(world: World, team: Team): Team[] {
  return world.teams.filter((t) => t.id !== team.id && t.controller === "human" && t.downTick === null && hostile(world, t.id, team.id));
}

/** Its standing army: alive, takes orders, and won't go cold (bursts stay home and defend). */
function armyOf(world: World, team: Team): Unit[] {
  return world.entities.filter((e): e is Unit => e.kind === "unit" && e.team === team.id && e.mode === "guard" && e.hp > 0 && e.expiresAt === undefined);
}

/** An army's weight: the compute it costs, the same measure as the army cap. */
function strength(content: Content, world: World, units: Unit[]): number {
  let total = 0;
  for (const u of units) total += rankedUpkeep(unitUpkeep(content, u.defId), unitRank(content, world, u));
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
  return world.entities.filter((e): e is Building => e.kind === "building" && e.hp > 0 && teams.has(e.team));
}

/** Send units somewhere, in orders small enough for the command. */
function order(units: Unit[], to: Point, attack: boolean, issue: (c: Order) => unknown): void {
  for (let i = 0; i < units.length; i += ORDER_CHUNK) {
    issue({ type: "order", unitIds: units.slice(i, i + ORDER_CHUNK).map((u) => u.id), x: to.x, y: to.y, attack });
  }
}

export function playArmy(world: World, content: Content, team: Team, plan: AiAttackDef, issue: (c: Order) => unknown): void {
  const ai = team.ai!;
  const enemies = rivals(world, team);
  const core = world.entities.find((e) => e.id === team.coreId);
  if (!core || core.kind !== "building") return;
  const home: Point = { x: core.x, y: core.y };
  if (enemies.length === 0) {
    if (ai.phase === "attack") retreat(world, team, home, plan, issue);
    return;
  }
  const army = armyOf(world, team);
  const inGroup = new Set(ai.group);
  const group = army.filter((u) => inGroup.has(u.id));
  ai.group = group.map((u) => u.id);

  if (ai.phase === "retreat") {
    if (group.length === 0 || distSq(centroid(group), home) <= HOME_REACHED * HOME_REACHED || world.tick >= ai.until) {
      ai.phase = "gather";
      ai.group = [];
    }
    return;
  }

  if (ai.phase === "gather") {
    if (world.tick < Math.max(plan.firstTicks, ai.until)) return;
    // As big as it can get for now: full squads, or as far as spare compute
    // stretches, whichever comes first.
    const weight = strength(content, world, army);
    const { supply, demand } = computeBalance(world, content, team);
    const full = weight + Math.min(squadReserve(world, content, team), Math.max(0, supply - demand));
    if (army.length < plan.minUnits || weight * 1000 < full * plan.armyPermille) return;
    ai.phase = "attack";
    ai.group = army.map((u) => u.id);
    ai.launched = weight;
    ai.coreHp = core.hp;
    ai.goal = null;
    ai.goalId = -1;
    steer(world, team, army, enemies, issue);
    return;
  }

  // Attacking.
  // Home under attack (the core low and losing hp), or the army spent: come back.
  const weight = strength(content, world, group);
  const homeHit = core.hp < ai.coreHp && core.hp * 1000 < core.maxHp * plan.recallBelowPermille;
  ai.coreHp = core.hp;
  if (group.length === 0 || weight * 1000 < ai.launched * plan.retreatPermille || homeHit) {
    retreat(world, team, home, plan, issue);
    return;
  }
  // Reinforcements: once enough have gathered at home, they join.
  const fresh = army.filter((u) => !inGroup.has(u.id) && distSq(u, home) <= HOME_REACHED * HOME_REACHED);
  if (fresh.length >= plan.minUnits) {
    // The attack is now what's left plus them: losses count from here.
    ai.group.push(...fresh.map((u) => u.id));
    group.push(...fresh);
    ai.launched = strength(content, world, group);
    ai.goalId = -1; // re-issue so they get the order too
  }
  steer(world, team, group, enemies, issue);
}

/**
 * Point the group at what to hit next: the core of the nearest enemy it
 * has found, else the nearest start spot it hasn't checked, else (every spot
 * checked) the nearest enemy building anywhere.
 */
function steer(world: World, team: Team, group: Unit[], enemies: Team[], issue: (c: Order) => unknown): void {
  const ai = team.ai!;
  const at = centroid(group);
  const alive = new Set(enemies.map((t) => t.id));
  ai.known = ai.known.filter((id) => alive.has(id));
  const sees = (p: Point, range: number) => group.some((u) => distSq(u, p) <= range * range);

  // Any of its units reached the spot it was checking: it's been looked at.
  if (ai.goal !== null && ai.goal >= 0 && sees(spotPoint(world, ai.goal), SPOT_REACHED)) {
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
  const spots = world.terrain.starts.map((_, i) => i).filter((i) => i !== team.id && !ai.checked.includes(i));
  if (known.length > 0) {
    // Go for the nearest found enemy's core (attack-moving, so it fights
    // whatever's in the way); its other buildings only once the core is down.
    const b = nearest(known, at);
    const core = world.entities.find((e) => e.id === world.teams[b.team]!.coreId && e.hp > 0);
    const aim = core ?? b;
    target = { x: aim.x, y: aim.y };
    targetId = aim.id;
    ai.goal = null;
  } else if (spots.length > 0) {
    const i = ai.goal !== null && ai.goal >= 0 && spots.includes(ai.goal) ? ai.goal : nearest(spots.map((s) => ({ s, ...spotPoint(world, s) })), at).s;
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

function retreat(world: World, team: Team, home: Point, plan: AiAttackDef, issue: (c: Order) => unknown): void {
  const ai = team.ai!;
  const inGroup = new Set(ai.group);
  const group = armyOf(world, team).filter((u) => inGroup.has(u.id));
  // Walk, don't fight: the point is to get home alive. Then fight there.
  order(group, home, false, issue);
  ai.phase = "retreat";
  ai.goal = null;
  ai.goalId = -1;
  ai.until = world.tick + plan.cooldownTicks;
}

/**
 * The hero goes with an attack and comes home when hurt (cores heal heroes)
 * or when there's no attack on. Move orders: a hero on the move doesn't stop
 * to fight, so it's only moved when it's well away from where it should be.
 */
export function moveHero(world: World, team: Team, plan: AiAttackDef, issue: (c: Order) => unknown): void {
  const ai = team.ai!;
  const hero = team.hero ? world.entities.find((e): e is Unit => e.id === team.hero!.unitId && e.kind === "unit") : undefined;
  const core = world.entities.find((e) => e.id === team.coreId);
  if (!hero || hero.hp <= 0 || !core || team.hero!.cast) return;
  const hurt = hero.hp * 1000 < hero.maxHp * plan.heroRetreatPermille;
  const inGroup = new Set(ai.group);
  const group = ai.phase === "attack" && !hurt ? armyOf(world, team).filter((u) => inGroup.has(u.id)) : [];
  const where = group.length > 0 ? centroid(group) : { x: core.x, y: core.y };
  const slack = group.length > 0 ? HERO_SLACK : HOME_REACHED;
  if (distSq(hero, where) > slack * slack && !(hero.moveTo && distSq(hero.moveTo, where) <= HERO_SLACK * HERO_SLACK)) {
    issue({ type: "move", x: where.x, y: where.y });
  }
}
