// The Guide: everything the screen no longer spells out, in tabs. Opens from
// the build bar or with G; pauses the match while open.

import type { Session } from "../game/session";
import { TERRAIN_GUIDE, buildingDetail, unitDetail, upgradeDetail, type GuideEntry } from "./cards";
import { $ } from "./dom";

type Tab = "controls" | "buildings" | "upgrades" | "creeps" | "terrain" | "races";

const TABS: [Tab, string][] = [
  ["controls", "Controls"],
  ["buildings", "Buildings"],
  ["upgrades", "Upgrades"],
  ["creeps", "Creeps"],
  ["terrain", "Terrain"],
  ["races", "Races"],
];

const CONTROLS: [string, string][] = [
  ["Start", "Your deploy agent starts selected. Click the ground to walk it, then press C and click to deploy your core."],
  ["Build", "Number keys or click a button, then click inside your network (the green rings). Shift-click to place several."],
  ["Network", "Cores, Mesh Nodes (Open Source) and Edge PoPs (Hyperscaler) each extend where you can build. Build outward to reach ramps and wells."],
  ["Redundancy", "Build more cores inside your network. If your main core falls the next takes over; you only go down when every core is down."],
  ["Select", "Click one of your buildings or units."],
  ["Research", "Select your core: the bar shows upgrades. Click one (or press its number) to research it. One at a time."],
  ["Rally", "With a spawner selected, right-click the ground to send its units there. With the core selected, right-click sets the rally for every spawner that doesn't have its own. No right button? Press T (or the button on the info card), then click the ground. Ctrl-click, Cmd-click and two-finger taps count as right-clicks too."],
  ["Camera", "WASD / arrows, drag, or the window edge to pan. Wheel or +/- to zoom. Click the minimap to jump. Space: back home."],
  ["Other", "Esc: deselect · P: pause · E: edge scroll on/off · G: this guide · R: new match after an outage"],
  ["Users", "Users arrive while your core is up and grow toward your capacity (core + Web Apps). Every user pays compute each second. Damage to any of your buildings drives users away."],
  ["Co-op", "On the race picker press H. Send each friend an invite link, paste back the reply code they give you, then Start. Everyone runs the same match; you see what your allies see, and the match goes on until every player is offline. Co-op can't pause."],
  ["Goal", "Waves never stop. Your score is uptime: how long your core stays online. Peak users is your bragging right."],
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
          return entry({ ...detail, stats: [...detail.stats, `Bounty: ${bounty} compute per kill`, `First seen: wave ${from}`] });
        });
      }
      case "terrain":
        return TERRAIN_GUIDE.map(entry);
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
