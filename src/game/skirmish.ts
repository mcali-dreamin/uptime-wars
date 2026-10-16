// A solo match against computer players, until the lobby exists (issue #123):
//
//   ?ai=hard                    one Hard opponent, free-for-all, horde on
//   ?ai=easy,insane:serverless  two opponents; a race after the colon
//   &mode=coop                  computers on your side against the horde
//   &horde=0                    free-for-all without the horde
//
// Opponents without a race take the other races in order. Pure: reads the
// query string it's given.

import type { Content, MatchSetup } from "../sim";
import { MAX_PLAYERS } from "../sim";

export const HORDE_RACE = "botnet";

export function skirmishSetup(
  content: Content,
  query: string,
  seed: number,
  race: string,
  hero: string | undefined,
): MatchSetup {
  const params = new URLSearchParams(query);
  const playable = Object.keys(content.races).filter(
    (id) => content.races[id]!.controller === "human",
  );
  const others = playable.filter((id) => id !== race);
  const slots = (params.get("ai") ?? "")
    .split(",")
    .filter(Boolean)
    .slice(0, MAX_PLAYERS - 1)
    .map((slot, i) => {
      const [difficulty, picked] = slot.split(":");
      return {
        difficulty: content.difficulties[difficulty!] ? difficulty! : "normal",
        race:
          picked && playable.includes(picked)
            ? picked
            : others[i % others.length]!,
      };
    });
  if (slots.length === 0)
    return { seed, races: [race, HORDE_RACE], heroes: [hero] };
  const coop = params.get("mode") === "coop";
  const horde = coop || params.get("horde") !== "0";
  return {
    seed,
    mode: coop ? "coop" : "ffa",
    races: [race, ...slots.map((s) => s.race), ...(horde ? [HORDE_RACE] : [])],
    heroes: [hero],
    ai: [undefined, ...slots.map((s) => s.difficulty)],
  };
}
