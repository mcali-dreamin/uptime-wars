// Text is generated from content: descriptions are flavor, every number a
// player reads comes from the data the simulation runs on.

import { describe, expect, it } from "vitest";
import { createWorld, loadDefaultContent, type Content, type Team } from "../src/sim";
import { guideEntries, type Tab } from "../src/ui/guide";
import { buildingCard, upgradeCard } from "../src/ui/cards";
import { abilityEffect, perkChanges, raceLines, rankChange, traitLine, unitRuleLines } from "../src/ui/text";

const TABS: Tab[] = ["controls", "heroes", "buildings", "upgrades", "creeps", "terrain", "races"];
const PLAYABLE = ["open-source", "hyperscaler", "serverless", "walled-garden"];

/** A quantity in prose: a digit, or a number spelled out. Flavor that happens to have a digit is listed. */
const QUANTITY = /\d|\b(two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|half|twice|double|triple|thrice|third|fourth)\b/i;
const FLAVOR = ["3am", "429"];
const UI_SOURCES = import.meta.glob<string>("../src/ui/*.ts", { query: "?raw", import: "default", eager: true });

function team(content: Content, raceId: string): Team {
  const world = createWorld(content, { seed: 1, races: [raceId, "botnet"] });
  return world.teams[0]!;
}

/** Every Guide line for a race, as one string. */
function guideText(content: Content, raceId: string): string {
  const view = { raceId, playable: PLAYABLE, team: team(content, raceId) };
  return TABS.flatMap((tab) => guideEntries(content, tab, view)).map((e) => [e.title, e.description, ...e.stats].join("\n")).join("\n");
}

function prose(content: Content): [string, string][] {
  const out: [string, string][] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if ((k === "description" || k === "specialty") && typeof v === "string") out.push([`${path}.${k}`, v]);
        else walk(v, `${path}.${k}`);
      }
    }
  };
  walk(content, "content");
  return out;
}

describe("content text is flavor", () => {
  it("no description says a number: the numbers are generated from data", () => {
    const content = loadDefaultContent();
    const quoted = prose(content).filter(([, text]) => QUANTITY.test(FLAVOR.reduce((t: string, f: string) => t.replaceAll(f, ""), text)));
    expect(quoted.map(([path, text]) => `${path}: ${text}`)).toEqual([]);
  });

  it("the UI never hardcodes a quantity in its text", () => {
    const hits: string[] = [];
    expect(Object.keys(UI_SOURCES).length).toBeGreaterThan(5);
    for (const [file, raw] of Object.entries(UI_SOURCES)) {
      let source = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Drop interpolations, innermost first: what's left of a template is its hand-written text.
      for (let before = ""; before !== source; ) {
        before = source;
        source = source.replace(/\$\{[^{}]*\}/g, "");
      }
      for (const literal of source.match(/"[^"\n]*"|`[^`]*`/g) ?? []) {
        if (/\d+(\.\d+)?\s?(%|px|tiles?|seconds?|s\b|×)/.test(literal)) hits.push(`${file}: ${literal}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("generated text follows the data", () => {
  it("guide numbers move when the content does", () => {
    const content = loadDefaultContent();
    const fork = content.races["open-source"]!.mechanics!.fork!;
    fork.costPermille = 470;
    const region = content.races.hyperscaler!.mechanics!.region!;
    region.perNeighborPermille = 70;
    content.races["walled-garden"]!.mechanics!.loyalty!.churnPermille = 330;
    content.buildings.function!.invoke!.ttlTicks = 460;
    content.buildings["solar-array"]!.limitPerTier = [2, 4, 9];
    content.heroes.coreHeal!.permillePerSecond = 35;
    content.waves.fortress.farms.weakenPermille = 130;
    for (const race of PLAYABLE) {
      const text = guideText(content, race);
      for (const quoted of ["47% of its price", "7% less damage", "23s", "2, 4, 9", "3.5% of its HP", "13% smaller"]) expect(text, race).toContain(quoted);
    }
    expect(guideText(content, "walled-garden")).toContain("33% of the usual rate");
  });

  it("a perk says what it changes, from the value the tier below has", () => {
    const content = loadDefaultContent();
    for (const race of PLAYABLE) {
      const perks = content.races[race]!.tierPerks ?? [];
      perks.forEach((perk, tier) => {
        if (!perk) return;
        const changes = perkChanges(content, race, tier);
        const fields = Object.values(perk.mechanics ?? {}).flatMap((m) => Object.keys(m as object)).length + Object.keys(perk.modifiers ?? {}).length;
        expect(changes.length, `${race} tier ${tier}`).toBeGreaterThanOrEqual(Math.min(1, fields));
      });
    }
    // Hyperscaler's base shield is in races.json; the old hand-written perk text had it wrong.
    const base = content.races.hyperscaler!.mechanics!.region!.maxPermille / 10;
    expect(perkChanges(content, "hyperscaler", 1).join()).toContain(`up to ${base}% → up to`);
  });

  it("every trait, creep role and ability has words", () => {
    const content = loadDefaultContent();
    for (const def of Object.values(content.upgrades)) {
      if (def.stat !== "trait") continue;
      const line = traitLine(content, def.unit!, def.trait!);
      expect(line.split("; ").length, def.name).toBe(Object.keys(def.trait!).length);
      expect(line).not.toContain("undefined");
    }
    for (const [id, unit] of Object.entries(content.units)) {
      const special = Number(Boolean(unit.role)) + Number(Boolean(unit.heal)) + Number(Boolean(unit.siege)) + Number(Boolean(unit.slowTicks));
      expect(unitRuleLines(unit).length, id).toBe(special);
    }
    for (const [id, ability] of Object.entries(content.heroes.abilities)) {
      expect(abilityEffect(content, ability, 1), id).not.toMatch(/undefined|NaN/);
    }
    for (const race of PLAYABLE) expect(raceLines(content, race).join(), race).not.toMatch(/undefined|NaN/);
  });

  it("a rank shows its units' numbers before and after", () => {
    const content = loadDefaultContent();
    const ranks = content.races.serverless!.spawnerRanks!;
    const fn = content.buildings.function!;
    const lambda = content.units.lambda!;
    const line = rankChange(content, "serverless", "function", null, ranks[0]!);
    expect(line).toContain(`${lambda.hp} → ${Math.round((lambda.hp * ranks[0]!.hpPermille) / 1000)} HP`);
    expect(line).toContain(`burst ${fn.invoke!.count} → ${fn.invoke!.count + ranks[0]!.burst!}`);
  });

  it("cards spell out bursts and upgrades as before → after", () => {
    const content = loadDefaultContent();
    const fn = content.buildings.function!.invoke!;
    const card = buildingCard(content, "serverless", "function").lines.join(" ");
    expect(card).toContain(`Lambda · bursts +${fn.count} for`);
    expect(card).toContain(`$${fn.cost} a burst`);
    const def = content.upgrades["tower-damage"]!;
    const lines = upgradeCard(content, team(content, "hyperscaler"), "tower-damage").lines.join(" ");
    expect(lines).toContain(`+0% → +${Math.round(def.perLevel * 100)}%`);
  });
});
