// Who's in the match and whose side they're on, top right. With open
// diplomacy each other player gets a button: offer an alliance, accept
// theirs, withdraw an offer, or break one. Those are ordinary commands, so
// they go through lockstep and replays like any order.

import { allied, allyBlocker, hasOffered, humanTeams, unallyBlocker, type TeamId, type World } from "../sim";
import type { Session } from "../game/session";
import { $ } from "./dom";

export class PlayersPanel {
  private readonly root = $("players");
  /** What's drawn, so the panel only rebuilds when something changed. */
  private drawn = "";

  constructor(
    private readonly session: Session,
    /** A team's colour (the renderer owns colours). */
    private readonly colorOf: (world: World, team: TeamId) => number,
  ) {}

  update(): void {
    const { world, local } = this.session;
    const players = humanTeams(world);
    if (players.length < 2) {
      this.root.hidden = true;
      this.drawn = "";
      return;
    }
    const key = `${world.allies.join()}|${world.offers.join()}|${players.map((t) => t.downTick === null).join()}|${local}`;
    if (key === this.drawn) return;
    this.drawn = key;
    this.root.hidden = false;
    this.root.replaceChildren(
      ...players.map((team) => {
        const row = document.createElement("div");
        row.className = "player";
        const swatch = document.createElement("i");
        swatch.style.background = `#${this.colorOf(world, team.id).toString(16).padStart(6, "0")}`;
        const name = document.createElement("span");
        name.textContent = `${team.id === local ? "You" : `Player ${team.id + 1}`} · ${this.session.content.races[team.raceId]!.name}`;
        const state = document.createElement("small");
        state.textContent = standing(world, local, team.id);
        state.className = state.textContent.split(" ")[0]!.toLowerCase();
        row.append(swatch, name, state);
        const action = this.action(world, local, team.id);
        if (action) row.append(action);
        return row;
      }),
    );
  }

  private action(world: World, local: number, other: number): HTMLButtonElement | null {
    if (other === local || world.rules.diplomacy !== "open") return null;
    const button = document.createElement("button");
    button.type = "button";
    if (allyBlocker(world, local, other) === null) {
      const theyAsked = hasOffered(world, other, local);
      button.textContent = theyAsked ? "Accept" : "Ally";
      button.title = theyAsked ? "They offered an alliance: accept it" : "Offer an alliance. It forms once they accept.";
      if (theyAsked) button.className = "accept";
      button.addEventListener("click", () => this.session.issue({ type: "ally", with: other }));
    } else if (unallyBlocker(world, local, other) === null) {
      const pending = !allied(world, local, other);
      button.textContent = pending ? "Withdraw" : "Break";
      button.title = pending ? "Take back your offer" : "Break the alliance: you're enemies again, right away";
      button.addEventListener("click", () => this.session.issue({ type: "unally", with: other }));
    } else {
      return null;
    }
    return button;
  }
}

/** How `other` stands with you, in a word or two. */
function standing(world: World, local: number, other: number): string {
  const team = world.teams[other]!;
  if (team.downTick !== null) return "Offline";
  if (other === local) return "";
  if (allied(world, local, other)) return "Ally";
  if (hasOffered(world, other, local)) return "Enemy · offers alliance";
  if (hasOffered(world, local, other)) return "Enemy · offer sent";
  return "Enemy";
}
