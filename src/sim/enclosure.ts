// Pure derived geometry, deliberately outside serialized/hashed World state.
import type { Content } from "./content";
import { enclosedGround } from "./placement";
import { raceMechanics } from "./tiers";
import type { Building, TeamId, World } from "./types";

const cache = new WeakMap<World, Map<TeamId, { tick: number; key: string; ground: Uint8Array }>>();

export function enclosureGround(world: World, content: Content, team: TeamId): Uint8Array | undefined {
  if (!raceMechanics(content, world.teams[team]!).enclosure) return undefined;
  let teams = cache.get(world);
  if (!teams) cache.set(world, teams = new Map());
  const old = teams.get(team);
  // Combat and income ask per hit and per Web App: check for changes once a tick.
  if (old?.tick === world.tick) return old.ground;
  // Like nav.builtKey, but read live entities: a breach takes effect the next
  // tick, before the navigation overlay next synchronizes.
  let key = world.teams.map((t) => `${t.id}:${t.raceId}`).join(",") + world.allies.join(",");
  for (const e of world.entities) if (e.kind === "building" && e.hp > 0) key += `${e.id}:${e.team},`;
  if (old?.key === key) {
    old.tick = world.tick;
    return old.ground;
  }
  const ground = enclosedGround(world, content, team);
  teams.set(team, { tick: world.tick, key, ground });
  return ground;
}

export function enclosureBonus(world: World, content: Content, building: Building) {
  if (building.hp <= 0) return undefined;
  const ground = enclosureGround(world, content, building.team);
  if (!ground) return undefined;
  for (let r = building.row; r < building.row + building.footprint; r += 1) {
    for (let c = building.col; c < building.col + building.footprint; c += 1) {
      if (!ground[r * world.terrain.cols + c]) return undefined;
    }
  }
  return raceMechanics(content, world.teams[building.team]!).enclosure;
}

/** Users are team-wide: distribute them proportionally across serving capacity.
 * Only the share served by enclosed Web Apps earns the premium. */
export function enclosureRevenueFactor(world: World, content: Content, team: TeamId): number {
  if (!raceMechanics(content, world.teams[team]!).enclosure) return 1;
  let capacity = 0;
  let extra = 0;
  for (const e of world.entities) {
    if (e.kind !== "building" || e.team !== team || e.hp <= 0 || e.buildRemaining > 0) continue;
    const serves = content.buildings[e.defId]!.userCapacity ?? 0;
    capacity += serves;
    if (serves && e.defId === "web-app") extra += serves * ((enclosureBonus(world, content, e)?.revenuePermille ?? 1000) - 1000);
  }
  return capacity ? 1 + extra / (capacity * 1000) : 1;
}
