// The Guide: everything the screen no longer spells out, in tabs. Opens from
// the build bar or with G; pauses the match while open.

import type { Session } from "../game/session";
import { TERRAIN_GUIDE, inventorySummary, itemEffectLines, perkLines, rankLines, buildingDetail, unitDetail, upgradeDetail, type GuideEntry } from "./cards";
import { $ } from "./dom";
import { EXPANSION_CLEARANCE, FARM_COUNT, TICK_RATE, upgradesAt, type Content, type RaceDef, type Team, sellValue } from "../sim";
import { abilityEffect, permille, raceLines, secs } from "./text";

export type Tab = "controls" | "heroes" | "items" | "buildings" | "upgrades" | "creeps" | "terrain" | "races";

const TABS: [Tab, string][] = [
  ["controls", "Controls"],
  ["buildings", "Buildings"],
  ["upgrades", "Upgrades"],
  ["items", "Items"],
  ["creeps", "Creeps"],
  ["terrain", "Terrain"],
  ["races", "Races"],
  ["heroes", "Heroes"],
];

/** Content values the Controls tab quotes. Pulled from data so the words can't drift. */
function controls(content: Content): [string, string][] {
  const tiers = content.economy.tiers.map((t) => t.name);
  const limits = (id: string) => content.buildings[id]?.limitPerTier?.join(", ") ?? "";
  const raceWith = (key: keyof NonNullable<RaceDef["mechanics"]>) => Object.values(content.races).find((r) => r.mechanics?.[key]);
  const fork = raceWith("fork");
  const repair = raceWith("repair");
  const region = raceWith("region");
  const fn = Object.values(content.buildings).find((b) => b.invoke && b.buildable);
  const ranks = Object.values(content.races).find((r) => r.spawnerRanks?.length)?.spawnerRanks ?? [];
  const spread = content.waves.spread;
  const farms = content.waves.fortress.farms;
  const heal = content.heroes.coreHeal;
  const camps = content.neutrals.tiers as Record<"near" | "far", { fromStart: number; units: string[] }>;
  const site = content.buildings[content.neutrals.sites.building]!;
  const campBounty = Math.max(...Object.values(content.neutrals.tiers).flatMap((t) => t.units.map((u) => content.units[u]!.bounty)));
  return [
  ["Start", "Your deploy agent starts selected. Click the ground to walk it, then press C and click to deploy your core."],
  ["Build", "Number keys or click a button, then click inside your network (the green rings). Shift-click to place several."],
  ["Items", `${inventorySummary()} Build a Package Registry and select it: its card is the shop, listing the basics with price and effect — click or press the number key to buy, with the hero standing within ${content.items.shopRadius}px of it. Farms, C2 Servers and bosses leave rarer items glowing where they fall: right-click one with the hero selected and it walks there and takes it, if a slot is free. Everything is on the Items tab.`],
  ["Network", "Cores, Mesh Nodes (Open Source) and Edge PoPs (Hyperscaler) each extend where you can build. Build outward to hold ramps and push toward the nest."],
  ["Expansion", `Select a core and press B to train a deploy agent ($${content.buildings[content.races["open-source"]!.core]!.cost}). Walk it out, press C and click open ground anywhere on the map: it builds a new core there. One agent at a time, no site within ${EXPANSION_CLEARANCE} tiles of a hostile building, and if it dies on the way the $ is gone. Each finished core raises your Web App and generator caps; each core's rally sets its own bubble.`],
  ["Neutral camps", `Squads of legacy hardware guard the open ground: weak camps ${camps.near.fromStart} tiles or so from every start, strong ones toward the middle (${camps.far.fromStart} tiles out). They are hostile to everyone, including the botnet, but never attack first: hit one and the whole camp fights back, within reach of its post, then goes home. Walk away and they mend, so finish what you start. A cleared camp stays cleared. Each unit pays bounty (up to $${campBounty}) and hero XP. Near camps are a job for your hero alone; far ones need a real army. The minimap marks each camp by how hard it is: green, amber, red.`],
  ["Sites", `A ${site.name} stands at the center of every far camp, one per start. Clear the camp, then keep your units (the hero and deploy agents count) within ${content.neutrals.sites.captureRadius} px of it for ${secs(content.neutrals.sites.captureTicks)} with no rival around: it is yours, and pays +$${site.income?.amount} every ${secs(site.income?.intervalTicks ?? 0)} and +${site.compute} compute. Two sides at once pause the capture, nobody there drains it, and a rival has to drain your progress first. It can't be captured from its owner: knock it down and it goes neutral at ${permille(content.neutrals.sites.rearmPermille)} of its HP, open to anyone. It produces and researches nothing, and never counts for winning or losing. The minimap marks each explored site with a square in its owner's colour.`],
  ["Spot capacity", `Select a core and press N to rent +${content.economy.spot.compute.join(" / ")} compute (by core tier) for ${content.economy.spot.ticks / TICK_RATE}s, for $${content.economy.spot.cost.join(" / ")}. Each rental this match costs ${permille(content.economy.spot.growthPermille)} of the base price more. Use it for a push or a boss: when it ends, units over your cap aren't replaced and fade as they fall. Renting again while it runs stacks more compute and restarts the timer.`],
  ["Redundancy", "If your main core falls the next finished one takes over; you only go down when every core is down. Every finished core supplies its own compute, so extra cores add reach, users, caps and compute (the core tier's bonus counts once)."],
  ["Select", "Click one of your buildings or units. Drag a box to select units — the hero joins too (a box with only the hero selects the hero); Shift adds to the group, and Shift-click a unit or the hero toggles it in or out. Double-click a unit or a building (any of yours but the core): every one of its kind on screen, and Shift-click toggles buildings in or out of the group. A box with no units in it selects your spawners instead. Z: your whole army (no hero). Q: your hero."],
  ["Army", "With units selected, right-click the ground (or an enemy) to attack-move: they fight whatever they meet on the way, then hold the spot. F then click: a plain move that ignores enemies, for retreating. T then click works like right-click. The hero in the group comes along: right-click the ground and it moves there (a plain move — F makes no difference to it, and a Shift-queued order sends it at once), right-click an enemy and it attacks. Units you've sent stay put when you change a rally."],
  ["Hero", `Right-click to move or attack, 1-4 to cast, Shift+1-4 to learn. Hurt? Bring it home: near any of your cores it heals ${heal ? permille(heal.permillePerSecond) : ""} of its HP a second once nothing is hitting it. Full rundown in the Heroes tab.`],
  ["Research", "Two places research, each with its own queue of five: the one running plus four waiting. Your core upgrades the race and its base: core tier, building armor and HP, tower damage and range, users and revenue. Your upgrade center (CI Server, R&D Lab, Build Pipeline, Design Studio: one per player) upgrades the army: weapons, unit armor, unit HP, spawn speed, how fast your units move, and your race's unit traits, one per unit, unlocked by core tier. Select either and click an upgrade (or press its number) to queue it: you pay when you queue, each upgrade can be in the queue once (its next level waits until that one finishes), and requirements are judged with everything queued at both buildings counted. An upgrade whose core tier isn't there yet waits at the head until the tier finishes. Click an entry on the building's card to cancel it for a full refund."],
  ["Core tiers", `The first research, Upgrade core, grows your core: ${tiers.join(", then ")}. Each tier hosts more Web Apps (${limits("web-app")}), unlocks stronger buildings, supplies more compute, reaches further, and makes your cores tougher. But a bigger base draws crawlers from further away, and everything else you queue at the core waits its turn while it upgrades.`],
  ["Solid", "Buildings are solid: nobody walks through one, your own units included. Pack your base so creeps have to chew through the outside, but leave your army a way out. A building that would wall ground in two can't go down."],
  ["Walls", "Walled Garden: Walls block every path, for creeps and your own units alike, like every building, but they're cheap and allowed to close a gap. Put a Gate in the line: your units (and allies') walk straight through it, creeps and enemies have to break it. Towers and ranged units shoot over them. Creeps that can't get round a wall tear into it."],
  ["Fork", `${fork?.name}: select one of your finished buildings (not the core) and press X (or Fork on its card), then click to place a copy for ${permille(fork?.mechanics?.fork?.costPermille ?? 0)} of its price, built in ${permille(fork?.mechanics?.fork?.buildPermille ?? 0)} of the time. ${repair?.name} buildings also repair themselves once nothing has hit them for ${secs(repair?.mechanics?.repair?.quietTicks ?? 0)}.`],
  ["Region", `${region?.name}: each finished building of yours within ${region?.mechanics?.region?.radiusTiles} tiles makes a building take ${permille(region?.mechanics?.region?.perNeighborPermille ?? 0)} less damage, up to ${permille(region?.mechanics?.region?.maxPermille ?? 0)}. Pack your base into regions; a lone building gets no shield. The building's card shows its shield.`],
  ["Functions", `Serverless autoscales. A Function (Inference Endpoint, State Machine) keeps a small squad warm like any rack. When the creeps near it outnumber its units, it bursts: extra units for ${secs(fn?.invoke?.ttlTicks ?? 0)}, then it cools off. Every burst costs $: no $, no burst. Bursts count against the army cap like any unit: a burst only spins up what your free compute has room for (and costs that share), so more Functions need more Compute Pools. Select one and press V (or Burst now) to burst it yourself. Its card shows the numbers. Their rally point works like a rack's.`],
  ["Rally", "With a spawner selected, right-click the ground to send its units there. With several spawners selected (a box, Shift-click, or double-click one), right-click gives them all the same rally; a group may hold other buildings too, and only its spawners take the rally. With the core selected, right-click sets the rally for every spawner that doesn't have its own. No right button? Press T (or the button on the info card), then click the ground. Ctrl-click, Cmd-click and two-finger taps count as right-clicks too."],
  ["Groups", "Ctrl+1..9 (or Alt+1..9, since some browsers keep Ctrl+number for tabs) saves what you have selected as a group; 1..9 brings it back, and pressing it twice centres the camera. Once a group exists, its number selects it instead of the building with that hotkey."],
  ["Decommission", `Overbuilt? Select your own buildings (one, or a group of them) and press Delete or Backspace (or the button on the info card), then again to confirm. They come down and you get back ${permille(content.economy.decommissionRefundPermille)} of what you paid, or all of it while one is still deploying. Cores can't be decommissioned. With units selected, Delete dismisses them instead: no refund, but their compute is free at once. A spawner refills its squad, so to shrink your army for good, decommission the spawner.`],
  ["Queue", "Hold Shift while right-clicking to queue orders: your units finish what they're doing, then go to each point in turn. Markers show the queued points."],
  ["Alerts", "When something of yours is hit off-screen, a banner says so, the minimap flashes where, and you hear it. Space jumps the camera to the latest alert (press again for the one before); H always goes home. Your army fighting off-screen alerts too, and so does your army being wiped out (that one always, even in view). Losing a building, your core being hit, and your hero falling always alert."],
  ["Camera", "WASD / arrows, the window edge, or drag with the middle button or Alt held to pan. Wheel or +/- to zoom. Click the minimap to jump. Right-click the minimap to send the selection there (Z then right-click the minimap sends your whole army). Space: back home."],
  ["Other", "M: sound on / effects only / off · Esc: deselect · P: pause · E: edge scroll on/off · G: this guide · R: new match after an outage"],
  ["Army cap", `Compute caps your army. Every unit uses some; a spawner (or a Function's burst) only adds one if there's room. More spawners reinforce faster, they don't make your army bigger. Generators are limited per core tier (Solar Arrays: ${limits("solar-array")}), so to field a bigger army, tech up the core. At the top tier the limit turns soft: you can keep building generators, each one past it at a steeper price, so late $ still buys a bigger army. The Compute stat says 'army cap' when you're at it.`],
  ["Ranks", `The other way past the army cap: better units. Select a spawner (or function) and press U (or Upgrade on its card) to rank it up in place: ${ranks.map((r, i) => `rank ${i + 1} at ${tiers[r.tier]}`).join(", ")}. It stops spawning while it refits, then makes tougher, harder-hitting units that use more compute each but are worth more per compute. Each race ranks its own way: a spawner's card shows what each rank does to its units.`],
  ["$", "Money. Users pay it every second, and everything is bought with it: buildings, research, kills pay bounties in it. Hover the +/s next to $ to see where it comes from."],
  ["Users", "Users are your income. They arrive while your core is up and grow toward your capacity (core + Web Apps), as long as you have compute free to serve them, after what your spawners need to refill their squads: your army gets its compute first. When users stall for that reason, Users says 'need compute'. Every hit your core or a Web App takes drives some away (the red −N by Users); towers and racks are what you put in between. And a bigger base makes more traffic: crawlers sense you from further away the more you build, the more users you have, and the longer you're online."],
  ["Compute", "Capacity, not money. Your core, Solar Arrays and Power Plants supply it; every user and unit uses some (shown as in use / supplied). It can go over. The further over you are, the worse it gets: no new users arrive and some leave each second, and your towers, spawners and research all run slower by the same share (shown as % slow). Build generators to grow."],
  ["Co-op", "On the home screen press C (Custom match). Send each friend an invite link, paste back the reply code they give you, then Start. Everyone runs the same match; you see what your allies see, and the match goes on until every player is offline. Co-op can't pause."],
  ["Spread", `The botnet grows. Every ${spread.everyWaves} incidents it sends an Infector, with an escort, to a spot out on the map, where it builds an Infected Node (${secs(content.buildings[spread.building]?.buildTicks ?? 0)}). Finished nodes are new places incidents come out of, so the more nodes stand, the more directions you get hit from. Kill the Infector on the way, or the node before it's finished. Packs coming for your base don't all take the same road, either: most swing out to one side or the other.`],
  ["Goal", `The botnet never stops. Small packs of background traffic leave the nest every few seconds, more as the match goes on; every few minutes an incident (DDoS, Worm outbreak, Ransomware...) sends a big surge, and bosses only come with incidents. Late incidents get tougher, not bigger: they come as fewer ranked creeps (${(content.waves.ranks?.levels ?? []).map((l) => l.name).join(", ")}), bigger to look at, each fighting like several and paying a bounty to match. The top bar counts down to the next one and shows what it brings. In co-op the pressure grows with every player still online. Your score is uptime: how long your core stays online. Peak users is your bragging right. Or end it: the Malware Nest sits on a fortified plateau in the middle of the web, its gateways guarded by C2 Servers. Every few waves the botnet rebuilds fallen C2 Servers, tougher. Inside, ${FARM_COUNT} Botnet Farms garrison the fortress, and while any of them stands the nest is shielded and takes no damage (the top bar shows how many are down). Destroy a farm and it sends a retaliation wave (a hornet's nest) at the army that broke it; once it has fought there it goes back to the nest. Every farm down makes every later incident ${permille(farms.weakenPermille)} smaller. Break all ${FARM_COUNT}, then take the nest offline before the botnet rebuilds them, and the whole botnet collapses: you win.`],
  ];
}

export class Guide {
  private readonly root = $("guide");
  private readonly tabs = $("guide-tabs");
  private readonly body = $("guide-body");
  private tab: Tab = "controls";
  open = false;

  constructor(private readonly session: Session) {
    $("guide-close").addEventListener("click", () => this.close());
    this.root.addEventListener("click", (event) => {
      if (event.target === this.root) this.close();
    });
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.open = false;
    this.root.hidden = true;
  }

  /** Keys while open. Returns true when handled. */
  key(key: string): boolean {
    if (!this.open) return false;
    if (key === "escape" || key === "g") this.close();
    const index = Number(key) - 1;
    if (TABS[index]) {
      this.tab = TABS[index]![0];
      this.render();
    }
    return true;
  }

  private render(): void {
    this.tabs.replaceChildren(
      ...TABS.map(([id, label]) => {
        const button = document.createElement("button");
        button.textContent = label;
        button.className = id === this.tab ? "active" : "";
        button.addEventListener("click", () => {
          this.tab = id;
          this.render();
        });
        return button;
      }),
    );
    this.body.replaceChildren(...this.content());
  }

  private content(): HTMLElement[] {
    const { content, playable } = this.session;
    return guideEntries(content, this.tab, { raceId: this.session.team.raceId, playable, team: this.session.team }).map(entry);
  }
}

/** One Guide tab's entries, from content alone (and the player's race and research). */
export function guideEntries(content: Content, tab: Tab, view: { raceId: string; playable: string[]; team: Team }): GuideEntry[] {
  const { raceId, playable, team } = view;
    switch (tab) {
      case "controls":
        return controls(content).map(([title, text]) => ({ title, description: text, stats: [] }));
      case "buildings": {
        const race = content.races[raceId]!;
        return [race.core, ...race.buildings].map((id) => buildingDetail(content, raceId, id));
      }
      case "upgrades":
        return [...upgradesAt(content, team, "core"), ...upgradesAt(content, team, "center")].map((id) => upgradeDetail(content, id, raceId));
      case "items": {
        const rules: GuideEntry = {
          title: "How items work",
          description: inventorySummary(),
          stats: [
            "Shop: select a finished Package Registry and click (or press its number) to buy; the hero must stand nearby",
            `Selling, with the hero in range of a registry, gives back ${permille(content.items.sellPermille)} of the price`,
            "Botnet Farms, C2 Servers and incident bosses drop one item where they die, from a table of rarer things",
            "Right-click a glowing drop with the hero selected: it walks there and takes it, if a slot is free",
            "Passive stats stack over every copy carried and stay on through death and respawn",
          ],
        };
        const entries = Object.entries(content.items.items).map(([id, def]) => ({
          title: def.shop ? `${def.name} · $${def.cost}` : `${def.name} · drop`,
          description: def.description,
          stats: [...itemEffectLines(content, id), ...(def.shop ? [] : [`Sells for $${sellValue(content, id)} at a Package Registry`])],
        }));
        return [rules, ...entries];
      }
      case "creeps": {
        const ids = [...content.waves.roster.map((r) => r.unit), content.waves.spread.unit, content.waves.bosses.unit];
        return [...new Set(ids)].map((id) => {
          const detail = unitDetail(content, id);
          const from = content.waves.roster.find((r) => r.unit === id)?.fromWave ?? content.waves.bosses.fromWave;
          const bounty = content.units[id]!.bounty;
          return { ...detail, stats: [...detail.stats, `Bounty: $${bounty} per kill`, `First seen: incident ${from}`] };
        });
      }
      case "terrain":
        return TERRAIN_GUIDE;
      case "heroes": {
        const h = content.heroes;
        const abilities = Object.values(h.abilities);
        const basicRanks = Math.max(...abilities.filter((a) => a.maxRank > 1).map((a) => a.maxRank));
        const ultimateAt = Math.min(...abilities.filter((a) => a.maxRank === 1).map((a) => a.unlockLevel ?? 1));
        const rules: GuideEntry = {
          title: "How heroes work",
          description: "You lead one hero, picked with your race. Select it with Q or its card (Q again centres on it).",
          stats: [
            "Right-click the ground to move, or an enemy to attack it (T then click also moves)",
            "1-4 cast abilities; area and targeted ones then want a click (right-click or Esc cancels)",
            `Kills within ${h.xpRange}px of your hero give it XP; every level is a skill point (Shift+1-4, or the +)`,
            `Basic abilities have ${basicRanks} ranks, a rank every ${h.levelsPerRank} levels; the ultimate opens at level ${ultimateAt}. Max level ${h.maxLevel}`,
            "A fallen hero comes back at your core, later the higher its level",
          ],
        };
        const heroes = playable.flatMap((raceId) =>
          (content.races[raceId]!.heroes ?? []).map((heroId) => {
            const unit = content.units[heroId]!;
            return {
              title: `${unit.name} · ${content.races[raceId]!.name}`,
              description: unit.description,
              stats: h.heroes[heroId]!.abilities.map((id, i) => {
                const a = h.abilities[id]!;
                return `${i + 1}. ${a.name}${a.maxRank === 1 ? " (ultimate)" : ""}: ${a.description} ${abilityEffect(content, a, 1)}${a.maxRank > 1 ? " at rank 1" : ""}.`;
              }),
            };
          }),
        );
        return [rules, ...heroes];
      }
      case "races":
        return playable.map((id) => {
          const race = content.races[id]!;
          const roster = race.buildings.map((b) => content.buildings[b]!.name).join(", ");
          return { title: race.name, description: race.specialty, stats: [...raceLines(content, id), `Builds: ${roster}`, ...perkLines(content, id), ...rankLines(content, id)] };
        });
    }
}

function entry(item: GuideEntry): HTMLElement {
  const el = document.createElement("article");
  const title = document.createElement("strong");
  title.textContent = item.title;
  const description = document.createElement("p");
  description.textContent = item.description;
  el.append(title, description);
  if (item.stats.length > 0) {
    const list = document.createElement("ul");
    list.append(
      ...item.stats.map((stat) => {
        const li = document.createElement("li");
        li.textContent = stat;
        return li;
      }),
    );
    el.append(list);
  }
  return el;
}
