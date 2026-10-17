// The match lobby, for friends and computers alike. The host sends a friend
// an invite link; the browsers connect directly. On Spacefast the link
// carries a six-letter code and the game's invite relay passes the reply
// back on its own. Anywhere else the friend sends back a reply code to
// paste. Up to four players; each invite seats one friend, and the host can
// give any seat to a computer instead. With no friend joined, the match is
// played locally (it can pause); with one, it's a network match and every
// browser works out the computers' moves the same way.

import { MAX_PLAYERS } from "../sim";
import type { MatchSetup } from "../sim";
import { HostLobby, composeRules, joinHost, lobbySetup, type ComputerSeat, type LobbyRules, type NetMatch } from "../game/net/lobby";
import { answerOffer, createOffer } from "../game/net/rtc";
import { fetchOffer, isCode, postAnswer, publishOffer, type HostedInvite } from "../game/net/signal";
import type { Session } from "../game/session";
import { $ } from "./dom";

const JOIN_PARAM = "join";
const SIDE_NAMES = ["A", "B", "C", "D"];

/** Starting points for the rules: each just sets the toggles below it. */
const PRESETS = {
  coop: { label: "Co-op", sides: (_: number) => 0, horde: true, nest: true, open: false },
  ffa: { label: "Free-for-all", sides: (i: number) => i, horde: true, nest: false, open: false },
  teams: { label: "Teams", sides: (i: number) => i % 2, horde: false, nest: false, open: false },
} as const;

export class CoopLobby {
  private readonly root = $("coop");
  private readonly body = $("coop-body");
  private host: HostLobby | null = null;
  private hosted: HostedInvite | null = null;
  /** Each person's starting side (seat 0 is the host, then guests). */
  private sides: number[] = [0, 0, 0, 0];
  /** Seats given to computers, each with its own starting side. They sit after the people. */
  private computers: (ComputerSeat & { side: number })[] = [];
  open = false;

  constructor(
    private readonly session: Session,
    private readonly onStart: (match: NetMatch) => void,
    private readonly onCancel: () => void,
    /** No friend joined: play it here, against the computers. */
    private readonly onLocal: (setup: MatchSetup) => void = () => {},
  ) {
    $("coop-close").addEventListener("click", () => this.cancel());
  }

  /** An invite in the URL (`#join=...`): the page was opened to join someone. */
  static inviteInUrl(): string | null {
    return new URLSearchParams(location.hash.slice(1)).get(JOIN_PARAM);
  }

  // --- host -------------------------------------------------------------

  /** Open the lobby. `computer`: start with one computer opponent, free-for-all. */
  async hostGame(computer = false): Promise<void> {
    this.show();
    this.computers = [];
    this.sides = [0, 0, 0, 0];
    const lobby = (this.host = new HostLobby(this.session.content));
    lobby.onChange = () => this.renderHost();
    this.renderHost();
    if (computer) {
      this.addComputer();
      this.preset("ffa");
    }
    await this.nextInvite();
  }

  /** Give the next open seat to a computer (Normal, a race nobody else has yet if there is one). */
  private addComputer(): void {
    const lobby = this.host;
    if (!lobby || lobby.full) return;
    const { playable, raceId } = this.session;
    const taken = new Set([raceId, ...lobby.guests.map((g) => g.race), ...this.computers.map((c) => c.race)]);
    const race = playable.find((id) => !taken.has(id)) ?? playable[(this.computers.length + 1) % playable.length]!;
    // A new seat starts on its own side, like everyone in a free-for-all.
    const used = new Set([...this.sides.slice(0, 1 + lobby.guests.length), ...this.computers.map((c) => c.side)]);
    const side = [0, 1, 2, 3].find((s) => !used.has(s)) ?? 0;
    this.computers.push({ race, difficulty: "normal", side });
    lobby.computers = this.computers.length;
    this.renderHost();
  }

  private removeComputer(index: number): void {
    const lobby = this.host;
    if (!lobby) return;
    const wasFull = lobby.full;
    this.computers.splice(index, 1);
    lobby.computers = this.computers.length;
    this.renderHost();
    // A seat opened up for a friend.
    if (wasFull && !this.inviting) void this.nextInvite();
  }

  private inviting = false;

  /** Prepare an invite link for the next friend. */
  private async nextInvite(): Promise<void> {
    this.inviting = true;
    try {
      await this.invite();
    } finally {
      this.inviting = false;
    }
  }

  private async invite(): Promise<void> {
    const lobby = this.host;
    if (!lobby || lobby.full) return this.renderHost();
    const invite = $("coop-invite") as HTMLInputElement;
    invite.value = "Preparing an invite…";
    const { offer, accept } = await createOffer();
    if (this.host !== lobby) return;
    const hosted = (this.hosted = await publishOffer(offer));
    if (this.host !== lobby) return hosted?.cancel();
    const url = new URL(location.href);
    url.hash = `${JOIN_PARAM}=${hosted ? hosted.token : offer}`;
    invite.value = url.toString();
    $("coop-manual").hidden = hosted !== null;
    if (hosted) {
      this.status("Waiting for your friend to open the link…");
      try {
        const answer = await hosted.answer;
        if (this.host !== lobby) return;
        this.status("Connecting…");
        const link = await accept(answer);
        // Every seat went to a computer while the invite was out.
        if (lobby.full) {
          link.close();
          this.status("The match filled up before your friend got in.");
          return this.renderHost();
        }
        lobby.add(link);
        this.status("");
      } catch (error) {
        if (this.host !== lobby) return;
        this.status(`That didn't work (${(error as Error).message}). Here's a fresh invite.`);
      }
      return this.invite();
    }
    const reply = $("coop-reply") as HTMLInputElement;
    const connect = $("coop-connect") as HTMLButtonElement;
    reply.value = "";
    reply.disabled = connect.disabled = false;
    connect.onclick = async () => {
      const code = reply.value.trim();
      if (!code) return;
      reply.disabled = connect.disabled = true;
      this.status("Connecting…");
      try {
        const link = await accept(code);
        if (lobby.full) {
          link.close();
          this.status("The match filled up before your friend got in.");
          return this.renderHost();
        }
        lobby.add(link);
        this.status("");
        await this.invite();
      } catch (error) {
        this.status(`That didn't work (${(error as Error).message}). Send them a fresh invite.`);
        await this.invite();
      }
    };
  }

  private renderHost(): void {
    const lobby = this.host!;
    const raceName = (id: string | null) => (id ? this.session.content.races[id]!.name : "joining…");
    if (!document.getElementById("coop-invite")) {
      this.body.innerHTML = `
        <h2>New match</h2>
        <div class="coop-mode">
          <div class="coop-presets">Start from ${Object.entries(PRESETS)
            .map(([id, p]) => `<button type="button" data-preset="${id}">${p.label}</button>`)
            .join("")}</div>
          <label><input type="checkbox" id="coop-horde" checked> <b>The botnet plays</b> · everyone's enemy</label>
          <label id="coop-nest-row"><input type="checkbox" id="coop-nest" checked> Its nest must fall to win</label>
          <label><input type="checkbox" id="coop-open"> <b>Open alliances</b> · ally and unally during the match</label>
          <small id="coop-rules-note"></small>
        </div>
        <p>Send a friend this link, or give a seat to a computer. Up to ${MAX_PLAYERS} players.</p>
        <div class="coop-row"><input id="coop-invite" readonly><button id="coop-copy">Copy</button></div>
        <div id="coop-manual" hidden>
          <p>They'll get a reply code. Paste it here:</p>
          <div class="coop-row"><input id="coop-reply" placeholder="Reply code"><button id="coop-connect">Connect</button></div>
        </div>
        <ol id="coop-players"></ol>
        <button type="button" id="coop-add-computer">Add a computer</button>
        <p id="coop-status"></p>
        <button id="coop-start" class="coop-primary">Start match</button>`;
      $("coop-copy").addEventListener("click", () => copy($("coop-invite") as HTMLInputElement));
      $("coop-start").addEventListener("click", () => this.startHost());
      $("coop-add-computer").addEventListener("click", () => this.addComputer());
      for (const button of this.body.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
        button.addEventListener("click", () => this.preset(button.dataset.preset as keyof typeof PRESETS));
      }
      for (const id of ["coop-horde", "coop-nest", "coop-open"]) $(id).addEventListener("change", () => this.syncRules());
    }
    const { content, playable } = this.session;
    const sideSelect = (value: number, set: (side: number) => void) => {
      const side = document.createElement("select");
      side.className = "coop-side";
      side.title = "Starting side: the same side starts allied";
      side.innerHTML = SIDE_NAMES.map((name, i) => `<option value="${i}">Side ${name}</option>`).join("");
      side.value = String(value);
      side.addEventListener("change", () => {
        set(Number(side.value));
        this.syncRules();
      });
      return side;
    };
    const people = [`You (${raceName(this.session.raceId)})`, ...lobby.guests.map((g, i) => `Player ${i + 2} (${raceName(g.race)})`)];
    const computers = this.computers.map((seat, i) => {
      const li = document.createElement("li");
      li.className = "coop-computer";
      const race = document.createElement("select");
      race.title = "The computer's race";
      race.innerHTML = playable.map((id) => `<option value="${id}">${content.races[id]!.name}</option>`).join("");
      race.value = seat.race;
      race.addEventListener("change", () => (seat.race = race.value));
      const level = document.createElement("select");
      level.title = "How well it plays";
      level.innerHTML = Object.entries(content.difficulties)
        .map(([id, d]) => `<option value="${id}" title="${d.description}">${d.name}</option>`)
        .join("");
      level.value = seat.difficulty;
      level.addEventListener("change", () => (seat.difficulty = level.value));
      const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "×", title: "Free the seat" });
      remove.addEventListener("click", () => this.removeComputer(i));
      const name = Object.assign(document.createElement("span"), { textContent: `Computer ${people.length + i + 1}` });
      li.append(name, level, race, sideSelect(seat.side, (side) => (seat.side = side)), remove);
      return li;
    });
    $("coop-players").replaceChildren(
      ...people.map((text, seat) => {
        const li = document.createElement("li");
        li.append(Object.assign(document.createElement("span"), { textContent: text }), sideSelect(this.sides[seat]!, (side) => (this.sides[seat] = side)));
        return li;
      }),
      ...computers,
    );
    this.syncRules();
    ($("coop-start") as HTMLButtonElement).disabled = lobby.ready.length + this.computers.length === 0;
    ($("coop-add-computer") as HTMLButtonElement).disabled = lobby.full;
    if (lobby.full) ($("coop-invite") as HTMLInputElement).value = "The match is full.";
  }

  private startHost(): void {
    const lobby = this.host;
    if (!lobby || lobby.ready.length + this.computers.length === 0) return;
    this.hosted?.cancel();
    this.hosted = null;
    const seed = (Math.random() * 2 ** 31) | 0;
    const race = this.session.raceId;
    const hero = this.session.heroFor(race);
    const computers = this.computers.map(({ race, difficulty }) => ({ race, difficulty }));
    if (lobby.ready.length === 0) {
      // Nobody joined: just you and the computers, played here.
      lobby.close();
      this.host = null;
      this.hide();
      return this.onLocal(lobbySetup(seed, [{ race, hero }], computers, this.rules()));
    }
    const match = lobby.start(race, seed, hero, this.rules(), computers);
    lobby.onLeave = (team) => this.onLeave(team);
    this.hide();
    this.onStart(match);
  }

  /** What the host composed: sides per seat (people, then computers), the botnet, diplomacy. */
  private rules(): LobbyRules {
    const checked = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false;
    return {
      horde: checked("coop-horde"),
      nestMustFall: checked("coop-nest"),
      diplomacy: checked("coop-open") ? "open" : "locked",
      sides: [...this.sides.slice(0, this.people()), ...this.computers.map((c) => c.side)],
    };
  }

  /** People in the lobby: you and the guests. */
  private people(): number {
    return 1 + (this.host?.guests.length ?? 0);
  }

  private preset(id: keyof typeof PRESETS): void {
    const p = PRESETS[id];
    this.sides = this.sides.map((_, i) => p.sides(i));
    this.computers.forEach((c, i) => (c.side = p.sides(this.people() + i)));
    ($("coop-horde") as HTMLInputElement).checked = p.horde;
    ($("coop-nest") as HTMLInputElement).checked = p.nest;
    ($("coop-open") as HTMLInputElement).checked = p.open;
    this.renderHost();
  }

  /** Keep the toggles honest: with nothing else to fight, the botnet has to play. */
  private syncRules(): void {
    const horde = $("coop-horde") as HTMLInputElement;
    const players = this.people() + this.computers.length;
    const composed = composeRules({ ...this.rules(), horde: false }, players);
    horde.disabled = composed.horde;
    if (composed.horde) horde.checked = true;
    $("coop-nest-row").hidden = !horde.checked;
    $("coop-rules-note").textContent = composed.horde ? "Everyone starts on one side, so the botnet plays." : "";
  }

  // --- guest ------------------------------------------------------------

  async join(token: string): Promise<void> {
    this.show();
    history.replaceState(null, "", location.pathname + location.search);
    const races = this.session.playable
      .map((id) => `<option value="${id}"${id === this.session.raceId ? " selected" : ""}>${this.session.content.races[id]!.name}</option>`)
      .join("");
    this.body.innerHTML = `
      <h2>Join a match</h2>
      <p>Your race: <select id="coop-race">${races}</select></p>
      <p id="coop-status">Connecting to your host…</p>
      <div class="coop-row" id="coop-answer-row" hidden><input id="coop-answer" readonly><button id="coop-copy">Copy</button></div>`;
    $("coop-copy").addEventListener("click", () => copy($("coop-answer") as HTMLInputElement));
    const relayed = isCode(token);
    let answer: Awaited<ReturnType<typeof answerOffer>>;
    try {
      answer = await answerOffer(relayed ? await fetchOffer(token) : token);
      if (relayed) await postAnswer(token, answer.answer);
    } catch (error) {
      return this.status(relayed ? (error as Error).message : "This invite link is broken. Ask your host for a new one.");
    }
    if (!relayed) {
      ($("coop-answer") as HTMLInputElement).value = answer.answer;
      $("coop-answer-row").hidden = false;
      this.status("Send this reply code to your host, then wait here.");
    }
    const link = await answer.link;
    this.status("Connected. Waiting for the host to start…");
    const race = ($("coop-race") as HTMLSelectElement).value;
    this.session.pick(race);
    ($("coop-race") as HTMLSelectElement).disabled = true;
    link.onClose = () => this.status("The host left.");
    joinHost(this.session.content, link, race, this.session.heroFor(race), (match) => {
      link.onClose = () => this.onLeave(0);
      this.hide();
      this.onStart(match);
    });
  }

  // --- shared -----------------------------------------------------------

  /** Called when a player drops mid-match; the host leaving ends it for guests. */
  onLeave: (team: number) => void = () => {};

  private status(text: string): void {
    const el = document.getElementById("coop-status");
    if (el) el.textContent = text;
  }

  private show(): void {
    this.root.hidden = false;
    this.open = true;
  }

  private hide(): void {
    this.root.hidden = true;
    this.open = false;
  }

  private cancel(): void {
    this.hosted?.cancel();
    this.hosted = null;
    this.host?.close();
    this.host = null;
    this.hide();
    this.onCancel();
  }
}

function copy(input: HTMLInputElement): void {
  input.select();
  void navigator.clipboard?.writeText(input.value).catch(() => document.execCommand("copy"));
}
