// The Guide: everything the screen no longer spells out, in tabs. Opens from
// the build bar or with G; pauses the match while open.

import type { Session } from "../game/session";
import { TERRAIN_GUIDE, perkLines, rankLines, buildingDetail, unitDetail, upgradeDetail, type GuideEntry } from "./cards";
import { $ } from "./dom";
import { upgradesAt } from "../sim";

type Tab = "controls" | "heroes" | "buildings" | "upgrades" | "creeps" | "terrain" | "races";

const TABS: [Tab, string][] = [
  ["controls", "Controls"],
  ["buildings", "Buildings"],
  ["upgrades", "Upgrades"],
  ["creeps", "Creeps"],
  ["terrain", "Terrain"],
  ["races", "Races"],
  ["heroes", "Heroes"],
];

const CONTROLS: [string, string][] = [
  ["Start", "Your deploy agent starts selected. Click the ground to walk it, then press C and click to deploy your core."],
  ["Build", "Number keys or click a button, then click inside your network (the green rings). Shift-click to place several."],
  ["Network", "Cores, Mesh Nodes (Open Source) and Edge PoPs (Hyperscaler) each extend where you can build. Build outward to hold ramps and push toward the nest."],
  ["Redundancy", "Build more cores inside your network. If your main core falls the next takes over; you only go down when every core is down. Extra cores add reach, not compute: only one core's compute counts."],
  ["Select", "Click one of your buildings or units. Drag a box to select units; Shift adds to the group. Double-click a unit: every one of its kind on screen. Z: your whole army. Q: your hero."],
  ["Army", "With units selected, right-click the ground (or an enemy) to attack-move: they fight whatever they meet on the way, then hold the spot. F then click: a plain move that ignores enemies, for retreating. T then click works like right-click. Units you've sent stay put when you change a rally."],
  ["Hero", "Right-click to move or attack, 1-4 to cast, Shift+1-4 to learn. Hurt? Bring it home: near any of your cores it heals 4% a second once nothing is hitting it. Full rundown in the Heroes tab."],
  ["Research", "Two places research, one thing at a time each. Your core upgrades the race and its base: core tier, building armor and HP, tower damage and range, users and revenue. Your upgrade center (CI Server, R&D Lab, Build Pipeline, Design Studio: one per player) upgrades the army: weapons, unit armor, unit HP, spawn speed, and your race's unit traits, one per unit, unlocked by core tier. Select either and click an upgrade (or press its number)."],
  ["Core tiers", "The first research, Upgrade core, grows your core: Core, then Data Center, then Region. Each tier hosts more Web Apps (2, 4, 6), unlocks stronger buildings, supplies more compute, reaches further, and makes your cores tougher. But a bigger base draws crawlers from further away, and while the core upgrades it can't research anything else."],
  ["Walls", "Walled Garden: Walls block every path, for creeps and your own units alike. Put a Gate in the line: your units (and allies') walk straight through it, creeps and enemies have to break it. Towers and ranged units shoot over them. Creeps that can't get round a wall tear into it. Users of a Walled Garden are loyal: they leave 60% slower when you're hit."],
  ["Fork", "Open Source: select one of your finished buildings (not the core) and press X (or Fork on its card), then click to place a copy for half its price, built in less than half the time. Open Source buildings also repair themselves once nothing has hit them for 5 seconds."],
  ["Region", "Hyperscaler: each finished building of yours within 3 tiles makes a building take 8% less damage, up to 40%. Pack your base into regions; a lone building gets no shield. The building's card shows its shield."],
  ["Functions", "Serverless autoscales. A Function (Inference Endpoint, State Machine) keeps a small squad warm like any rack, and when the creeps near it outnumber that squad it bursts extra units for 20 seconds, then scales back down and cools off. Each scale-up costs $: no $, no burst. Select one and press V (or Scale up now) to burst it yourself. Their rally point works like a rack's. Compute Pools supply the compute their squads need."],
  ["Rally", "With a spawner selected, right-click the ground to send its units there. With the core selected, right-click sets the rally for every spawner that doesn't have its own. No right button? Press T (or the button on the info card), then click the ground. Ctrl-click, Cmd-click and two-finger taps count as right-clicks too."],
  ["Groups", "Ctrl+1..9 (or Alt+1..9, since some browsers keep Ctrl+number for tabs) saves what you have selected as a group; 1..9 brings it back, and pressing it twice centres the camera. Once a group exists, its number selects it instead of the building with that hotkey."],
  ["Queue", "Hold Shift while right-clicking to queue orders: your units finish what they're doing, then go to each point in turn. Markers show the queued points."],
  ["Alerts", "When something of yours is hit off-screen, a banner says so, the minimap flashes where, and you hear it. Space jumps the camera to the latest alert (press again for the one before); H always goes home. Losing a building, your core being hit, and your hero falling always alert."],
  ["Camera", "WASD / arrows, the window edge, or drag with the middle button or Alt held to pan. Wheel or +/- to zoom. Click the minimap to jump. Space: back home."],
  ["Other", "M: sound on / effects only / off · Esc: deselect · P: pause · E: edge scroll on/off · G: this guide · R: new match after an outage"],
  ["Army cap", "Compute caps your army. Every unit uses some; a spawner only adds one if there's room. More spawners reinforce faster, they don't make your army bigger. Generators are limited per core tier (Solar Arrays: 2, then 4, then 7), so to field a bigger army, tech up the core. The Compute stat says 'army cap' when you're at it."],
  ["Ranks", "The other way past the army cap: better units. Select a spawner (or function) and press U (or Upgrade on its card) to rank it up in place: rank 1 at Data Center, rank 2 at Region. It stops spawning while it refits, then makes tougher, harder-hitting units that use more compute each but are worth more per compute. Each race ranks its own way: see the Races tab."],
  ["$", "Money. Users pay it every second, and everything is bought with it: buildings, research, kills pay bounties in it. Hover the +/s next to $ to see where it comes from."],
  ["Users", "Users are your income. They arrive while your core is up and grow toward your capacity (core + Web Apps), as long as you have the compute to serve them. Every hit your core or a Web App takes drives some away (the red −N by Users); towers and racks are what you put in between. And a bigger base makes more traffic: crawlers sense you from further away the more you build, the more users you have, and the longer you're online."],
  ["Compute", "Capacity, not money. Your core, Solar Arrays and Power Plants supply it; every user and unit uses some (shown as in use / supplied). It can go over. The further over you are, the worse it gets: no new users arrive and some leave each second, and your towers, spawners and research all run slower by the same share (shown as % slow). Build generators to grow."],
  ["Co-op", "On the race picker press H. Send each friend an invite link, paste back the reply code they give you, then Start. Everyone runs the same match; you see what your allies see, and the match goes on until every player is offline. Co-op can't pause."],
  ["Spread", "The botnet grows. Every couple of incidents it sends an Infector, with an escort, to a spot out on the map, where it builds an Infected Node (20 seconds). Finished nodes are new places incidents come out of, so the more nodes stand, the more directions you get hit from. Kill the Infector on the way, or the node before it's finished. Packs coming for your base don't all take the same road, either: most swing out to one side or the other."],
  ["Goal", "The botnet never stops. Small packs of background traffic leave the nest every few seconds, more as the match goes on; every few minutes an incident (DDoS, Worm outbreak, Ransomware...) sends a big surge, and bosses only come with incidents. The top bar counts down to the next one and shows what it brings. In co-op the pressure grows with every player still online. Your score is uptime: how long your core stays online. Peak users is your bragging right. Or end it: the Malware Nest sits on a fortified plateau in the middle of the web, its gateways guarded by C2 Servers. Every few waves the botnet rebuilds fallen C2 Servers, tougher. Inside, four Botnet Farms garrison the fortress, and while any of them stands the nest is shielded and takes no damage (the top bar shows how many are down). Destroy a farm and it sends a retaliation wave straight at you (a hornet's nest), but every farm down makes every later incident 15% smaller. Break all four, then take the nest offline before the botnet rebuilds them, and the whole botnet collapses: you win."],
];

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
    const { content } = this.session;
    const raceId = this.session.team.raceId;
    switch (this.tab) {
      case "controls":
        return CONTROLS.map(([title, text]) => entry({ title, description: text, stats: [] }));
      case "buildings": {
        const race = content.races[raceId]!;
        return [race.core, ...race.buildings].map((id) => entry(buildingDetail(content, raceId, id)));
      }
      case "upgrades":
        return [...upgradesAt(content, this.session.team, "core"), ...upgradesAt(content, this.session.team, "center")].map((id) =>
          entry(upgradeDetail(content, id, raceId)),
        );
      case "creeps": {
        const ids = [...content.waves.roster.map((r) => r.unit), content.waves.spread.unit, content.waves.bosses.unit];
        return [...new Set(ids)].map((id) => {
          const detail = unitDetail(content, id);
          const from = content.waves.roster.find((r) => r.unit === id)?.fromWave ?? content.waves.bosses.fromWave;
          const bounty = content.units[id]!.bounty;
          return entry({ ...detail, stats: [...detail.stats, `Bounty: $${bounty} per kill`, `First seen: incident ${from}`] });
        });
      }
      case "terrain":
        return TERRAIN_GUIDE.map(entry);
      case "heroes": {
        const h = content.heroes;
        const rules = entry({
          title: "How heroes work",
          description: "You lead one hero, picked with your race. Select it with Q or its card (Q again centres on it).",
          stats: [
            "Right-click the ground to move, or an enemy to attack it (T then click also moves)",
            "1-4 cast abilities; area and targeted ones then want a click (right-click or Esc cancels)",
            `Kills within ${h.xpRange}px of your hero give it XP; every level is a skill point (Shift+1-4, or the +)`,
            `Basic abilities have 3 ranks, a rank every ${h.levelsPerRank} levels; the ultimate opens at level 6. Max level ${h.maxLevel}`,
            "A fallen hero comes back at your core, later the higher its level",
          ],
        });
        const heroes = this.session.playable.flatMap((raceId) =>
          (content.races[raceId]!.heroes ?? []).map((heroId) => {
            const unit = content.units[heroId]!;
            return entry({
              title: `${unit.name} · ${content.races[raceId]!.name}`,
              description: unit.description,
              stats: h.heroes[heroId]!.abilities.map((id, i) => {
                const a = h.abilities[id]!;
                return `${i + 1}. ${a.name}${a.maxRank === 1 ? " (ultimate)" : ""}: ${a.description}`;
              }),
            });
          }),
        );
        return [rules, ...heroes];
      }
      case "races":
        return this.session.playable.map((id) => {
          const race = content.races[id]!;
          const roster = race.buildings.map((b) => content.buildings[b]!.name).join(", ");
          return entry({ title: race.name, description: race.specialty, stats: [roster, ...perkLines(content, id), ...rankLines(content, id)] });
        });
    }
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
