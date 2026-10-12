// User hubs: where users live. Neutral spots on the map (terrain.hubs) that
// a player connects by bringing their network within reach. A connected hub
// is a building of that player's that serves users like a Web App does, only
// more of them, out where it's hard to hold. It's lost when it's knocked
// offline (then nobody can reconnect it for a while) or when its owner's
// network no longer reaches it.
//
// Co-op: a hub is the team's, not one player's. Its user room is split evenly
// between the allies who are online, and it stays connected as long as any
// ally's network reaches it (it passes to them if its holder is cut off or
// goes down). In free-for-all, whoever connects it holds all of it.

import type { TickContext } from "./context";
import { placeBuilding } from "./entities";
import { TICK_RATE, footprintCenter } from "./map";
import { inNetwork } from "./placement";
import { hostile } from "./teams";
import type { HubSpot } from "./terrain";
import type { Building, Team, TeamId, World } from "./types";

/** Hub building kinds (their defIds are the spot sizes). */
export const HUB_KINDS: readonly string[] = ["campus", "metro"];

/** Online players who can hold or share a hub: core up, not down. */
function online(team: Team): boolean {
  return team.controller === "human" && team.coreId !== -1 && team.downTick === null;
}

/** Who shares a hub held by `holder`: the holder alone in FFA, every online ally in co-op. In team order. */
export function hubSharers(world: World, holder: TeamId): Team[] {
  return world.teams.filter((t) => online(t) && (t.id === holder || !hostile(world, t.id, holder)));
}

/**
 * User room `team` gets from connected hubs. A hub's room is split evenly
 * between its sharers; the remainder goes to the lowest-numbered ones, so the
 * shares add up to exactly the hub's room.
 */
export function hubUserRoom(world: World, content: TickContext["content"], team: Team): number {
  let room = 0;
  for (const entity of world.entities) {
    if (entity.kind !== "building" || entity.hp <= 0 || !HUB_KINDS.includes(entity.defId)) continue;
    const sharers = hubSharers(world, entity.team);
    const at = sharers.findIndex((t) => t.id === team.id);
    if (at < 0) continue;
    const total = content.buildings[entity.defId]!.userCapacity ?? 0;
    room += Math.floor(total / sharers.length) + (at < total % sharers.length ? 1 : 0);
  }
  return room;
}

/** The hub building standing on a spot, if any. */
export function hubBuilding(world: World, spot: HubSpot): Building | undefined {
  return world.entities.find(
    (e): e is Building => e.kind === "building" && e.defId === spot.size && e.col === spot.col && e.row === spot.row && e.hp > 0,
  );
}

/** Does this footprint overlap a hub spot? Nothing else may be built there. */
export function onHub(world: World, col: number, row: number, footprint: number): boolean {
  return world.terrain.hubs.some((h) => col < h.col + 2 && col + footprint > h.col && row < h.row + 2 && row + footprint > h.row);
}

/** Once a second: connect hubs your network reaches; drop ones knocked offline or cut off. */
export function tickHubs(ctx: TickContext): void {
  const { world, content } = ctx;
  if (world.tick % TICK_RATE !== 0) return;
  world.terrain.hubs.forEach((spot, i) => {
    const state = world.hubs[i]!;
    const center = footprintCenter(spot.col, spot.row, 2);
    const standing = hubBuilding(world, spot);
    if (state.owner !== -1 && !standing) {
      // Knocked offline: it comes back only after a while.
      world.events.push({ type: "hub", hub: i, team: state.owner, state: "lost" });
      state.owner = -1;
      state.downUntil = world.tick + content.economy.hubs.reconnectTicks;
      return;
    }
    if (standing) {
      const owner = world.teams[standing.team]!;
      if (owner.downTick === null && inNetwork(world, content, owner.id, center.x, center.y)) return;
      // Co-op: an ally whose network still reaches it takes it over, no gap.
      const heir = hubSharers(world, owner.id).find((t) => t.id !== owner.id && inNetwork(world, content, t.id, center.x, center.y));
      if (heir) {
        standing.team = heir.id;
        state.owner = heir.id;
        world.events.push({ type: "hub", hub: i, team: heir.id, state: "connected" });
        return;
      }
      // Cut off: no penalty, anyone in reach may take it next second.
      standing.hp = 0;
      world.events.push({ type: "hub", hub: i, team: owner.id, state: "cut-off" });
      state.owner = -1;
      return;
    }
    if (world.tick < state.downUntil) return;
    // Nobody holds it: the lowest-numbered player whose network reaches it connects it.
    const claimant = world.teams.find((t) => online(t) && inNetwork(world, content, t.id, center.x, center.y));
    if (!claimant) return;
    const hub = placeBuilding(world, content, claimant.id, spot.size, spot.col, spot.row, true);
    ctx.byId.set(hub.id, hub);
    state.owner = claimant.id;
    world.events.push({ type: "hub", hub: i, team: claimant.id, state: "connected" });
  });
}
