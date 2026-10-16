// The co-op lobby. The host sends a friend an invite link; the browsers
// connect directly. On Spacefast the link carries a six-letter code and the
// game's invite relay passes the reply back on its own. Anywhere else the
// friend sends back a reply code to paste. Up to four players; each invite
// seats one friend.

import { MAX_PLAYERS } from "../sim";
import { HostLobby, composeRules, joinHost, type LobbyRules, type NetMatch } from "../game/net/lobby";
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
  /** Each seat's starting side (seat 0 is the host). */
  private sides: number[] = [0, 0, 0, 0];
  open = false;

  constructor(
    private readonly session: Session,
    private readonly onStart: (match: NetMatch) => void,
    private readonly onCancel: () => void,
  ) {
    $("coop-close").addEventListener("click", () => this.cancel());
  }

  /** An invite in the URL (`#join=...`): the page was opened to join someone. */
  static inviteInUrl(): string | null {
    return new URLSearchParams(location.hash.slice(1)).get(JOIN_PARAM);
  }

  // --- host -------------------------------------------------------------

  async hostGame(): Promise<void> {
    this.show();
    const lobby = (this.host = new HostLobby(this.session.content));
    lobby.onChange = () => this.renderHost();
    this.renderHost();
    await this.nextInvite();
  }

  /** Prepare an invite link for the next friend. */
  private async nextInvite(): Promise<void> {
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
        lobby.add(await accept(answer));
        this.status("");
      } catch (error) {
        if (this.host !== lobby) return;
        this.status(`That didn't work (${(error as Error).message}). Here's a fresh invite.`);
      }
      return this.nextInvite();
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
        lobby.add(await accept(code));
        this.status("");
        await this.nextInvite();
      } catch (error) {
        this.status(`That didn't work (${(error as Error).message}). Send them a fresh invite.`);
        await this.nextInvite();
      }
    };
  }

  private renderHost(): void {
    const lobby = this.host!;
    const raceName = (id: string | null) => (id ? this.session.content.races[id]!.name : "joining…");
    if (!document.getElementById("coop-invite")) {
      this.body.innerHTML = `
        <h2>Play with friends</h2>
        <div class="coop-mode">
          <div class="coop-presets">Start from ${Object.entries(PRESETS)
            .map(([id, p]) => `<button type="button" data-preset="${id}">${p.label}</button>`)
            .join("")}</div>
          <label><input type="checkbox" id="coop-horde" checked> <b>The botnet plays</b> · everyone's enemy</label>
          <label id="coop-nest-row"><input type="checkbox" id="coop-nest" checked> Its nest must fall to win</label>
          <label><input type="checkbox" id="coop-open"> <b>Open alliances</b> · ally and unally during the match</label>
          <small id="coop-rules-note"></small>
        </div>
        <p>Send a friend this link. Each link seats one friend (up to ${MAX_PLAYERS - 1}).</p>
        <div class="coop-row"><input id="coop-invite" readonly><button id="coop-copy">Copy</button></div>
        <div id="coop-manual" hidden>
          <p>They'll get a reply code. Paste it here:</p>
          <div class="coop-row"><input id="coop-reply" placeholder="Reply code"><button id="coop-connect">Connect</button></div>
        </div>
        <ol id="coop-players"></ol>
        <p id="coop-status"></p>
        <button id="coop-start" class="coop-primary">Start match</button>`;
      $("coop-copy").addEventListener("click", () => copy($("coop-invite") as HTMLInputElement));
      $("coop-start").addEventListener("click", () => this.startHost());
      for (const button of this.body.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
        button.addEventListener("click", () => this.preset(button.dataset.preset as keyof typeof PRESETS));
      }
      for (const id of ["coop-horde", "coop-nest", "coop-open"]) $(id).addEventListener("change", () => this.syncRules());
    }
    const players = [`You (${raceName(this.session.raceId)})`, ...lobby.guests.map((g, i) => `Player ${i + 2} (${raceName(g.race)})`)];
    $("coop-players").replaceChildren(
      ...players.map((text, seat) => {
        const li = document.createElement("li");
        const side = document.createElement("select");
        side.className = "coop-side";
        side.title = "Starting side: the same side starts allied";
        side.innerHTML = SIDE_NAMES.map((name, i) => `<option value="${i}">Side ${name}</option>`).join("");
        side.value = String(this.sides[seat]);
        side.addEventListener("change", () => {
          this.sides[seat] = Number(side.value);
          this.syncRules();
        });
        li.append(Object.assign(document.createElement("span"), { textContent: text }), side);
        return li;
      }),
    );
    this.syncRules();
    ($("coop-start") as HTMLButtonElement).disabled = lobby.ready.length === 0;
    if (lobby.full) ($("coop-invite") as HTMLInputElement).value = "The match is full.";
  }

  private startHost(): void {
    const lobby = this.host;
    if (!lobby || lobby.ready.length === 0) return;
    this.hosted?.cancel();
    this.hosted = null;
    const match = lobby.start(this.session.raceId, (Math.random() * 2 ** 31) | 0, this.session.heroFor(this.session.raceId), this.rules());
    lobby.onLeave = (team) => this.onLeave(team);
    this.hide();
    this.onStart(match);
  }

  /** What the host composed: sides per seat, the botnet, diplomacy. */
  private rules(): LobbyRules {
    const checked = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false;
    return {
      horde: checked("coop-horde"),
      nestMustFall: checked("coop-nest"),
      diplomacy: checked("coop-open") ? "open" : "locked",
      sides: this.sides.slice(0, 1 + (this.host?.guests.length ?? 0)),
    };
  }

  private preset(id: keyof typeof PRESETS): void {
    const p = PRESETS[id];
    this.sides = this.sides.map((_, i) => p.sides(i));
    ($("coop-horde") as HTMLInputElement).checked = p.horde;
    ($("coop-nest") as HTMLInputElement).checked = p.nest;
    ($("coop-open") as HTMLInputElement).checked = p.open;
    this.renderHost();
  }

  /** Keep the toggles honest: with nothing else to fight, the botnet has to play. */
  private syncRules(): void {
    const horde = $("coop-horde") as HTMLInputElement;
    const players = 1 + (this.host?.guests.length ?? 0);
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
