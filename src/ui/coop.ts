// The co-op lobby. No server: the host sends a friend an invite link, the
// friend sends back a reply code, and the two browsers connect directly.
// Up to four players; each invite link seats one friend.

import { MAX_PLAYERS } from "../sim";
import { HostLobby, joinHost, type NetMatch } from "../game/net/lobby";
import { answerOffer, createOffer } from "../game/net/rtc";
import type { Session } from "../game/session";
import { $ } from "./dom";

const JOIN_PARAM = "join";

export class CoopLobby {
  private readonly root = $("coop");
  private readonly body = $("coop-body");
  private host: HostLobby | null = null;
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
    const url = new URL(location.href);
    url.hash = `${JOIN_PARAM}=${offer}`;
    invite.value = url.toString();
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
        <h2>Host co-op</h2>
        <p>Send a friend this link. Each link seats one friend (up to ${MAX_PLAYERS - 1}).</p>
        <div class="coop-row"><input id="coop-invite" readonly><button id="coop-copy">Copy</button></div>
        <p>They'll get a reply code. Paste it here:</p>
        <div class="coop-row"><input id="coop-reply" placeholder="Reply code"><button id="coop-connect">Connect</button></div>
        <ol id="coop-players"></ol>
        <p id="coop-status"></p>
        <button id="coop-start" class="coop-primary">Start match</button>`;
      $("coop-copy").addEventListener("click", () => copy($("coop-invite") as HTMLInputElement));
      $("coop-start").addEventListener("click", () => this.startHost());
    }
    const players = [`You (${raceName(this.session.raceId)})`, ...lobby.guests.map((g, i) => `Player ${i + 2} (${raceName(g.race)})`)];
    $("coop-players").replaceChildren(...players.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
    ($("coop-start") as HTMLButtonElement).disabled = lobby.ready.length === 0;
    if (lobby.full) ($("coop-invite") as HTMLInputElement).value = "The match is full.";
  }

  private startHost(): void {
    const lobby = this.host;
    if (!lobby || lobby.ready.length === 0) return;
    const match = lobby.start(this.session.raceId, (Math.random() * 2 ** 31) | 0);
    lobby.onLeave = (team) => this.onLeave(team);
    this.hide();
    this.onStart(match);
  }

  // --- guest ------------------------------------------------------------

  async join(offer: string): Promise<void> {
    this.show();
    history.replaceState(null, "", location.pathname + location.search);
    const races = this.session.playable
      .map((id) => `<option value="${id}"${id === this.session.raceId ? " selected" : ""}>${this.session.content.races[id]!.name}</option>`)
      .join("");
    this.body.innerHTML = `
      <h2>Join co-op</h2>
      <p>Your race: <select id="coop-race">${races}</select></p>
      <p id="coop-status">Preparing your reply code…</p>
      <div class="coop-row"><input id="coop-answer" readonly><button id="coop-copy">Copy</button></div>`;
    $("coop-copy").addEventListener("click", () => copy($("coop-answer") as HTMLInputElement));
    let answer: Awaited<ReturnType<typeof answerOffer>>;
    try {
      answer = await answerOffer(offer);
    } catch {
      return this.status("This invite link is broken. Ask your host for a new one.");
    }
    ($("coop-answer") as HTMLInputElement).value = answer.answer;
    this.status("Send this reply code to your host, then wait here.");
    const link = await answer.link;
    this.status("Connected. Waiting for the host to start…");
    const race = ($("coop-race") as HTMLSelectElement).value;
    this.session.pick(race);
    ($("coop-race") as HTMLSelectElement).disabled = true;
    link.onClose = () => this.status("The host left.");
    joinHost(this.session.content, link, race, (match) => {
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
