// The Guide: everything the screen no longer spells out, in tabs. Opens from
// the build bar or with G; pauses the match while open.

import type { Session } from "../game/session";
import { TERRAIN_GUIDE, buildingDetail, unitDetail, upgradeDetail, type GuideEntry } from "./cards";
import { $ } from "./dom";

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
  ["Redundancy", "Build more cores inside your network. If your main core falls the next takes over; you only go down when every core is down."],
  ["Select", "Click one of your buildings or units. Drag a box to select units; Shift adds to the group. Double-click a unit: every one of its kind on screen. Z: your whole army. Q: your hero."],
  ["Army", "With units selected, right-click the ground (or an enemy) to attack-move: they fight whatever they meet on the way, then hold the spot. F then click: a plain move that ignores enemies, for retreating. T then click works like right-click. Units you've sent stay put when you change a rally."],
  ["Hero", "Right-click to move or attack, 1-4 to cast, Shift+1-4 to learn. Full rundown in the Heroes tab."],
  ["Research", "Select your core: the bar shows upgrades. Click one (or press its number) to research it. One at a time."],
  ["Walls", "Walled Garden: Walls block every path, for creeps and your own units alike, so leave yourself a way out. Towers and ranged units shoot over them. Creeps that can't get round a wall tear into it. Users of a Walled Garden are loyal: they leave 60% slower when you're hit."],
  ["Fork", "Open Source: select one of your finished buildings (not the core) and press X (or Fork on its card), then click to place a copy for half its price, built in less than half the time. Open Source buildings also repair themselves once nothing has hit them for 5 seconds."],
  ["Region", "Hyperscaler: each finished building of yours within 3 tiles makes a building take 8% less damage, up to 40%. Pack your base into regions; a lone building gets no shield. The building's card shows its shield."],
  ["Functions", "Serverless has no racks. A Function (or Inference Endpoint) spins up a squad when a creep comes near, for 20 seconds, then cools down. Each run costs $: no $, no run. Their units only use compute while running. Select one and press V (or its Invoke button) to run it now. Their rally point works like a rack's."],
  ["Rally", "With a spawner selected, right-click the ground to send its units there. With the core selected, right-click sets the rally for every spawner that doesn't have its own. No right button? Press T (or the button on the info card), then click the ground. Ctrl-click, Cmd-click and two-finger taps count as right-clicks too."],
  ["Camera", "WASD / arrows, the window edge, or drag with the middle button or Alt held to pan. Wheel or +/- to zoom. Click the minimap to jump. Space: back home."],
  ["Other", "M: sound on / effects only / off · Esc: deselect · P: pause · E: edge scroll on/off · G: this guide · R: new match after an outage"],
  ["$", "Money. Users pay it every second, and everything is bought with it: buildings, research, kills pay bounties in it. Hover the +/s next to $ to see where it comes from."],
  ["Users", "Users are your income. They arrive while your core is up and grow toward your capacity (core + Web Apps), as long as you have the compute to serve them. Every hit your core or a Web App takes drives some away (the red −N by Users); towers and racks are what you put in between. And a bigger base makes more traffic: crawlers sense you from further away the more you build, the more users you have, and the longer you're online."],
  ["Compute", "Capacity, not money. Your core, Solar Arrays and Power Plants supply it; every user and unit uses some (shown as in use / supplied). It can go over. The further over you are, the worse it gets: no new users arrive and some leave each second, and your towers, spawners and research all run slower by the same share (shown as % slow). Build generators to grow."],
  ["Co-op", "On the race picker press H. Send each friend an invite link, paste back the reply code they give you, then Start. Everyone runs the same match; you see what your allies see, and the match goes on until every player is offline. Co-op can't pause."],
  ["Goal", "Waves never stop. Your score is uptime: how long your core stays online. Peak users is your bragging right. Or end it: the Malware Nest sits on a fortified plateau in the middle of the web, its gateways guarded by C2 Servers. Push up a ramp, take the nest offline, and you win. Every few waves the botnet rebuilds fallen C2 Servers, tougher."],
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
        return Object.keys(content.upgrades).map((id) => entry(upgradeDetail(content, id)));
      case "creeps": {
        const ids = [...content.waves.roster.map((r) => r.unit), content.waves.bosses.unit];
        return [...new Set(ids)].map((id) => {
          const detail = unitDetail(content, id);
          const from = content.waves.roster.find((r) => r.unit === id)?.fromWave ?? content.waves.bosses.fromWave;
          const bounty = content.units[id]!.bounty;
          return entry({ ...detail, stats: [...detail.stats, `Bounty: $${bounty} per kill`, `First seen: wave ${from}`] });
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
          return entry({ title: race.name, description: race.specialty, stats: [roster] });
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
