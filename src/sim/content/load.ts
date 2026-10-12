// The game's content ships as JSON in src/content. Loading validates it, so
// bad content fails at startup instead of mid-match.

import unitsJson from "../../content/units.json";
import buildingsJson from "../../content/buildings.json";
import racesJson from "../../content/races.json";
import wavesJson from "../../content/waves.json";
import economyJson from "../../content/economy.json";
import upgradesJson from "../../content/upgrades.json";
import heroesJson from "../../content/heroes.json";

import type { BuildingDef, Content, EconomyDef, HeroesDef, RaceDef, UnitDef, UpgradeDef, WavesDef } from "./schema";
import { validateContent } from "./validate";

export function loadDefaultContent(): Content {
  const content: Content = {
    units: unitsJson as Record<string, UnitDef>,
    buildings: buildingsJson as Record<string, BuildingDef>,
    races: racesJson as Record<string, RaceDef>,
    waves: wavesJson as WavesDef,
    economy: economyJson as EconomyDef,
    upgrades: upgradesJson as Record<string, UpgradeDef>,
    heroes: heroesJson as HeroesDef,
  };
  validateContent(content);
  return content;
}
