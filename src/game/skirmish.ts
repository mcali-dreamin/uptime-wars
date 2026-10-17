// A solo match against computer players, until the lobby exists (issue #123):
//
//   ?ai=hard                    one Hard opponent, free-for-all, horde on
//   ?ai=easy,insane:serverless  two opponents; a race after the colon
//   &mode=coop                  computers on your side against the horde
//   &horde=0                    free-for-all without the horde
//   &sides=0,0,1,1              starting sides per player (same = allied): 2v2
//   &diplomacy=open             ally and unally during the match
//   &nest=1                     the nest must fall to win (0: it needn't)
//
// Opponents without a race take the other races in order. Pure: reads the
// query string it's given.

import type { Content, MatchSetup } from "../sim";
import { MAX_PLAYERS } from "../sim";
import { HORDE_RACE, lobbySetup } from "./net/lobby";

export { HORDE_RACE };

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
  const mode = params.get("mode") === "coop" ? "coop" : "ffa";
  const sides = params.get("sides")?.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < MAX_PLAYERS);
  const nest = params.get("nest");
  return lobbySetup(seed, [{ race, hero }], slots, {
    mode,
    horde: params.get("horde") !== "0",
    ...(sides?.length ? { sides } : {}),
    ...(params.get("diplomacy") === "open" ? { diplomacy: "open" as const } : {}),
    ...(nest === "0" || nest === "1" ? { nestMustFall: nest === "1" } : {}),
  });
}
