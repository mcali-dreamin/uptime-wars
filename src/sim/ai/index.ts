// Computer players. A computer player is a player like any other (controller
// "human", the same economy, the same blockers); this only decides which
// commands it sends. It runs inside step(), on world state alone, so every
// peer and every replay of a seed computes the same decisions.
//
// It plays every race with the same sensible basics plus one habit each race
// needs, and plays its hero. Its difficulty (content/difficulty.json) sets how
// often it acts, how far it techs, and how freely it spends.
//
// It builds, grows, and defends; with enemy players in the match it also
// attacks them (army.ts).

import type { Content, DifficultyDef } from "../content";
import { queueCommand } from "../commands";
import { expand, rentSpot } from "./aggressive";
import { moveHero, playArmy } from "./army";
import {
  computeBalance,
  squadReserve,
  unitUpkeep,
  userCapacity,
} from "../economy";
import { castBlocker, learnBlocker } from "../heroes";
import { buildCost, canFound, canPlace, finishedCores } from "../placement";
import { rankBlocker } from "../ranks";
import { hostile } from "../teams";
import { tierBlocker, tierOf, tierUpgrade } from "../tiers";
import type { Building, Command, Entity, Team, Unit, World } from "../types";
import { canResearch, nextLevel, slotOf } from "../upgrades";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type Order = DistributiveOmit<Command, "tick" | "team">;

/** Buildings it never builds on its own: walls and network need a plan it doesn't have; the registry only serves a hero, and the AI buys no items. */
const SKIP = new Set(["core", "mesh-node", "edge-pop", "wall", "gate", "package-registry"]);

/** The difficulty a team plays at, or undefined for a person. */
export function difficultyOf(
  content: Content,
  team: Team,
): DifficultyDef | undefined {
  return team.ai ? content.difficulties[team.ai.difficulty] : undefined;
}

/** What a user earns this team, relative to a person (1 = the same). */
export function revenueFactor(content: Content, team: Team): number {
  return (difficultyOf(content, team)?.revenuePermille ?? 1000) / 1000;
}

/**
 * Every computer player decides, then queues its commands for this tick.
 * Runs first in step(), so it sees the world as the last tick left it.
 */
export function tickAi(world: World, content: Content): void {
  if (world.tick === 0) return;
  for (const team of world.teams) {
    const level = difficultyOf(content, team);
    if (!level || team.downTick !== null) continue;
    const issue = (command: Order) =>
      queueCommand(world, {
        ...command,
        tick: world.tick,
        team: team.id,
      } as Command);
    if (team.coreId === -1) {
      if (world.tick % level.buildEveryTicks === 0)
        foundCore(world, content, team, issue);
      continue;
    }
    if (level.playsHero && world.tick % level.heroEveryTicks === 0)
      team.ai!.casts += playHero(world, content, team, issue);
    if (world.tick % level.buildEveryTicks === 0) {
      playBase(world, content, team, level, issue);
      if (level.aggressive) {
        rentSpot(world, content, team, level, issue);
        expand(world, content, team, level, issue);
      }
      if (level.attack) {
        playArmy(world, content, team, level.attack, issue);
        if (level.playsHero && team.ai!.phase !== "gather")
          moveHero(world, team, level.attack, issue);
      }
    }
  }
}

/** No core yet: send the deploy agent to found one at its start, or the nearest open spot to it. */
function foundCore(
  world: World,
  content: Content,
  team: Team,
  issue: (c: Order) => unknown,
): void {
  const builder = world.entities.find((e) => e.id === team.builderId);
  if (!builder || builder.kind !== "unit" || builder.foundAt) return;
  const start = world.terrain.starts[team.id]!;
  for (let d = 0; d <= 6; d += 1) {
    for (let dc = -d; dc <= d; dc += 1) {
      for (let dr = -d; dr <= d; dr += 1) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue;
        if (
          canFound(world, content, team.id, start.col + dc, start.row + dr) ===
          null
        ) {
          issue({ type: "found", col: start.col + dc, row: start.row + dr });
          return;
        }
      }
    }
  }
}

/** Grow the core, research, rank up, and build through the race's roster. */
function playBase(
  world: World,
  content: Content,
  team: Team,
  level: DifficultyDef,
  issue: (c: Order) => unknown,
): void {
  const ai = team.ai!;
  const tier = tierUpgrade(content)!;
  const grown = tierOf(content, team) >= level.maxTier;
  const tierPrice = nextLevel(content, team, tier).cost;

  // Grow the core whenever it's affordable with a little to spare; research the rest once rich.
  // Both only into an empty slot: the queue is a player's tool, and the AI's
  // habits (and so its balance) are tuned around one research at a time.
  if (
    !grown &&
    !team.research &&
    canResearch(content, team, tier) === null &&
    team.money >= tierPrice + level.tierReserve
  ) {
    issue({ type: "research", upgrade: tier });
    return;
  }
  if (
    level.researchAbove !== null &&
    !team.research &&
    team.money > level.researchAbove
  ) {
    const upgrade = Object.keys(content.upgrades).find(
      (u) => u !== tier && !team[slotOf(content, u)] && canResearch(content, team, u) === null,
    );
    if (upgrade) issue({ type: "research", upgrade });
  }
  // Saving for the next tier: don't spend below what it costs.
  // (Between the price and price plus reserve it can afford the tier but
  // won't start it yet: that's still saving, or it spends down every time.)
  // A busy core blocks the tier like before (canResearch would let it queue).
  const tierBlocked = team.research ? "already researching" : canResearch(content, team, tier);
  const saving =
    !grown && (tierBlocked === "not enough $" || tierBlocked === null)
      ? tierPrice + level.tierReserve
      : 0;
  // Once comfortable, rank a spawner up: at the compute cap better units beat more of them.
  if (!saving && level.rankAbove !== null && team.money > level.rankAbove) {
    const rankable = world.entities.find(
      (e): e is Building =>
        e.kind === "building" &&
        rankBlocker(content, world, team.id, e as Building) === null,
    );
    if (rankable) {
      issue({ type: "rank", buildingId: rankable.id });
      return;
    }
  }

  const core = world.entities.find((e) => e.id === team.coreId);
  if (!core || core.kind !== "building") return;
  const rotation = content.races[team.raceId]!.buildings.filter(
    (b) => !SKIP.has(b),
  );
  // Compute its squads still need beyond what's spare (asked once, only if a spawner comes up).
  let short: number | undefined;
  const unmanned = () => {
    if (short === undefined) {
      const { supply, demand } = computeBalance(world, content, team);
      short = squadReserve(world, content, team) - (supply - demand);
    }
    return short;
  };
  for (let tries = 0; tries < rotation.length; tries += 1) {
    const b = rotation[(ai.next + tries) % rotation.length]!;
    if (!habitAllows(world, content, team, b, unmanned)) continue;
    // Saving: what grows the economy may dip into the savings (down to a
    // share of the price); anything else waits until the tier is paid for.
    const def = content.buildings[b]!;
    const grows = (def.compute ?? 0) > 0 || (def.userCapacity ?? 0) > 0;
    const keep = grows ? (saving * level.savingKeepPermille) / 1000 : saving;
    if (saving && team.money - def.cost < keep) continue;
    const spot = findSpot(world, content, team, b, core);
    if (spot) {
      issue({ type: "build", building: b, col: spot.col, row: spot.row });
      ai.next = (ai.next + tries + 1) % rotation.length;
      return;
    }
    if (team.money < buildCost(world, content, team.id, b)) break;
  }
}

function countOf(world: World, team: Team, building: string): number {
  return world.entities.filter(
    (e) =>
      e.kind === "building" &&
      e.team === team.id &&
      e.defId === building &&
      e.hp > 0,
  ).length;
}

/** A tower, wall or gate: no compute, users or units, just in the way or shooting. */
const isDefence = (def: Content["buildings"][string]) =>
  (def.attack !== undefined || def.blocks === true) &&
  !def.spawn &&
  !def.invoke &&
  !def.compute &&
  !def.userCapacity &&
  !def.buildRadius;

/**
 * The one race habit the basics lack. Serverless: functions bill per run, so
 * don't sprawl them before the core can afford a tier (2 per tier, plus 2).
 */
function habitAllows(
  world: World,
  content: Content,
  team: Team,
  building: string,
  unmanned: () => number,
): boolean {
  const def = content.buildings[building]!;
  if (def.invoke) {
    const have = world.entities.filter(
      (e) =>
        e.kind === "building" &&
        e.team === team.id &&
        content.buildings[e.defId]!.invoke &&
        e.hp > 0,
    ).length;
    return have < 2 + 2 * tierOf(content, team);
  }
  // Defences (towers, walls and gates) up to a few per tier: past that the
  // money does more as economy and army, and a base of nothing but towers
  // is one nobody can ever break, it included.
  if (isDefence(def)) {
    const have = world.entities.filter(
      (e) =>
        e.kind === "building" &&
        e.team === team.id &&
        e.hp > 0 &&
        isDefence(content.buildings[e.defId]!),
    ).length;
    return have < 4 + 4 * tierOf(content, team);
  }
  // No spawner it can't man: if spare compute won't cover the squads it
  // already has to fill plus this one's, it would only sink money into an
  // empty building, and its army would be no bigger for it.
  if (
    def.spawn &&
    unmanned() + def.spawn.maxAlive * unitUpkeep(content, def.spawn.unit) > 0
  )
    return false;
  return true;
}

/** Square rings of tile offsets, nearest first: every tile 2 to 10 out. */
const RINGS: [number, number][][] = [];
for (let d = 2; d <= 10; d += 1) {
  const ring: [number, number][] = [];
  for (let dr = -d; dr <= d; dr += 1) {
    for (let dc = -d; dc <= d; dc += 1) {
      if (Math.max(Math.abs(dc), Math.abs(dr)) === d) ring.push([dc, dr]);
    }
  }
  RINGS.push(ring);
}

/** The nearest spot to its core where this building may go, ring by ring (every tile, not a few lines out). */
function findSpot(
  world: World,
  content: Content,
  team: Team,
  building: string,
  core: Building,
) {
  // What doesn't depend on the spot, once: an unaffordable or capped building
  // would fail at every spot, after canPlace's costlier checks.
  const cost = buildCost(world, content, team.id, building);
  if (team.money < cost) return null;
  if (tierBlocker(content, team, building, countOf(world, team, building), finishedCores(world, content, team)))
    return null;
  for (const ring of RINGS) {
    for (const [dc, dr] of ring) {
      const col = core.col + dc;
      const row = core.row + dr;
      if (canPlace(world, content, team.id, building, col, row, cost) === null)
        return { col, row };
    }
  }
  return null;
}

const distSq = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

/** Learn what's learnable (ultimates first), cast what would help. Returns casts made. */
function playHero(
  world: World,
  content: Content,
  team: Team,
  issue: (c: Order) => unknown,
): number {
  const state = team.hero;
  const heroDef = team.heroId ? content.heroes.heroes[team.heroId] : undefined;
  if (!state || !heroDef) return 0;
  const owned = [...heroDef.abilities].sort(
    (a, b) =>
      content.heroes.abilities[b]!.unlockLevel -
      content.heroes.abilities[a]!.unlockLevel,
  );
  for (const id of owned)
    if (learnBlocker(content, team, id) === null)
      return (issue({ type: "learn", ability: id }), 0);
  if (state.cast) return 0;
  const hero = world.entities.find((e) => e.id === state.unitId) as
    Unit | undefined;
  if (!hero || hero.hp <= 0) return 0;

  const enemies = world.entities.filter(
    (e) =>
      e.hp > 0 &&
      e.kind === "unit" &&
      hostile(world, e.team, team.id) &&
      e.mode !== "decoy",
  );
  const near = (p: { x: number; y: number }, r: number) =>
    enemies.filter((e) => distSq(e, p) <= r * r);
  const nearest = (r: number): Entity | undefined =>
    near(hero, r).sort((a, b) => distSq(a, hero) - distSq(b, hero))[0];
  const own = world.entities.filter((e) => e.team === team.id && e.hp > 0);

  for (const id of owned) {
    if (castBlocker(world, content, team, id) !== null) continue;
    const a = content.heroes.abilities[id]!;
    const r = a.radius ?? 200;
    let cast: { x: number; y: number; targetId: number | null } | null = null;
    switch (a.effect) {
      case "strike": {
        const t = nearest(a.range + 60);
        if (t) cast = { x: t.x, y: t.y, targetId: t.id };
        break;
      }
      case "blast":
      case "stun": {
        if (a.target === "self") {
          if (near(hero, r).length >= 2)
            cast = { x: hero.x, y: hero.y, targetId: null };
        } else {
          const t = nearest(a.range);
          if (t && near(t, r).length >= 2)
            cast = { x: t.x, y: t.y, targetId: null };
        }
        break;
      }
      case "heal":
        if (
          hero.hp < hero.maxHp * 0.7 ||
          own.some((e) => e.hp < e.maxHp * 0.7 && distSq(e, hero) <= r * r)
        )
          cast = { x: hero.x, y: hero.y, targetId: null };
        break;
      case "decoy": {
        const t = nearest(300);
        if (t) cast = { x: t.x, y: t.y, targetId: null };
        break;
      }
      case "summon":
      case "buff":
      case "shield":
      case "trigger":
      case "discount":
        if (near(hero, 500).length >= 3)
          cast = { x: hero.x, y: hero.y, targetId: null };
        break;
      case "build":
        if (
          own.some(
            (e) =>
              e.kind === "building" &&
              (e.buildRemaining > 0 || e.hp < e.maxHp * 0.6) &&
              distSq(e, hero) <= r * r,
          )
        )
          cast = { x: hero.x, y: hero.y, targetId: null };
        break;
      case "funds":
        cast = { x: hero.x, y: hero.y, targetId: null };
        break;
      case "users":
        if (team.users < userCapacity(world, content, team))
          cast = { x: hero.x, y: hero.y, targetId: null };
        break;
    }
    if (cast) {
      issue({ type: "cast", ability: id, ...cast });
      return 1;
    }
  }
  return 0;
}
