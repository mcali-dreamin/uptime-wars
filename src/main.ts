// Wiring: session + selection + UI + renderer + input, and the frame loop.
// Game meaning lives in game/, drawing in render/, panels in ui/.

import { bindInput, type GameInput } from "./input";
import { Renderer } from "./render/renderer";
import {
  NOTHING,
  removal,
  allSoldiers,
  armed,
  armyHero,
  armySelection,
  buildingGroup,
  buildingSelection,
  enemyAt,
  groundOrders,
  groupable,
  isRallied,
  isSoldier,
  livingArmyIds,
  soldierOrders,
  toggleBuilding,
  toggleUnit,
  leftClickOrders,
  ownEntityAt,
  placementAt,
  placeReasonText,
  selectedEntity,
  siteAt,
  selectedIds,
  type Placement,
  type Selection,
} from "./game/selection";
import { Alerts, type AlertKind } from "./game/alerts";
import { ControlGroups } from "./game/groups";
import { Session } from "./game/session";
import { setLocalColor, teamColor } from "./render/palette";
import { BuildBar, FOUND_BUTTON, SPOT_BUTTON, aimingButton, buildingForKey, shopStock, type BarMode } from "./ui/build-bar";
import { $ } from "./ui/dom";
import { Guide } from "./ui/guide";
import { Hud } from "./ui/hud";
import { PlayersPanel } from "./ui/players";
import { InfoPanel } from "./ui/info-panel";
import { RacePicker } from "./ui/race-picker";
import { allied, humanTeams, upgradeName, TICK_RATE, TILE, forkCost, isCore, nextRank, rankGroup, loadDefaultContent, type Point, MAX_ITEMS } from "./sim";
import type { NetMatch } from "./game/net/lobby";
import { Director, tension, type Listener } from "./audio/cues";
import { SoundEngine, type SoundMode } from "./audio/engine";
import { CoopLobby } from "./ui/coop";
import { Telemetry } from "./game/telemetry";
import { metronome } from "./game/metronome";
import { version } from "../package.json";
import { HeroBar, heroUnit } from "./ui/hero-bar";
import { castBlocker } from "./sim/heroes";
import { playerName } from "./ui/names";

const STEP_MS = 1000 / TICK_RATE;
/** Two clicks on the same unit this close together select all of its kind on screen. */
const DOUBLE_CLICK_MS = 350;
const MAX_STEPS_PER_FRAME = 5;

const content = loadDefaultContent();
const session = new Session(content);
const renderer = new Renderer();
const hud = new Hud(session);
const playersPanel = new PlayersPanel(session, teamColor);
const sound = new SoundEngine();
const director = new Director(content);
const alerts = new Alerts(content);
const groups = new ControlGroups();
/** Alert colours on the minimap. */
const ALERT_COLOR = { attack: 0xfacc15, core: 0xf87171, lost: 0xf87171, hero: 0xfacc15, spread: 0xf87171, agent: 0xf87171, fighting: 0xfacc15, wiped: 0xf87171, camp: 0xfacc15, site: 0xfacc15, farm: 0xfacc15 } as const satisfies Record<AlertKind, number>;
/** Is a world point on screen right now (and in sight)? */
const onScreen = (p: Point) => renderer.onScreen(p.x, p.y);
const soundButton = $("sound");
const SOUND_LABEL: Record<SoundMode, string> = { on: "Sound: on", sfx: "Sound: effects", off: "Sound: off" };
soundButton.textContent = SOUND_LABEL[sound.mode];
function cycleSound(): void {
  soundButton.textContent = SOUND_LABEL[sound.cycle()];
  renderer.showBanner(SOUND_LABEL[sound.mode]);
}
soundButton.addEventListener("click", () => cycleSound());
// Browsers allow audio only after a gesture: start it on the first one.
for (const type of ["pointerdown", "keydown"] as const) window.addEventListener(type, () => sound.unlock(), { capture: true });
/** Where the player is looking, for positional sound. */
const listener: Listener = {
  get center() {
    return { x: renderer.camera.x, y: renderer.camera.y };
  },
  get span() {
    const v = renderer.camera.view(0);
    return v.right - v.left;
  },
  visible: (p) => renderer.fog.isVisible(p.x, p.y),
};
/** A first Delete, waiting for the second that confirms it. */
let pendingRemoval: { key: string; at: number } | null = null;
const REMOVE_CONFIRM_MS = 2500;

const info = new InfoPanel(session, () => arm(), () => invokeSelected(), () => forkSelected(), () => rankSelected(), () => removeSelected());
info.removeArmed = () => pendingRemoval !== null && removal(session, selection)?.key === pendingRemoval.key && performance.now() - pendingRemoval.at < REMOVE_CONFIRM_MS;
/** The core card's "Deploy agent" button (see BuildBar). */
const AGENT_BUTTON = "agent";
const bar = new BuildBar(session, {
  choose: (button) => {
    sound.ui("click");
    if (button === AGENT_BUTTON) {
      deployAgent();
      return;
    }
    if (button === SPOT_BUTTON) {
      rentCompute();
      return;
    }
    const current = buttonFor(selection);
    if (current === button) return select(fallback());
    select(button === FOUND_BUTTON ? { kind: "found" } : { kind: "place", building: button });
  },
  hover: (button) => {
    info.hoverButton = button;
    info.refresh(selection);
  },
  research: (upgrade) => research(upgrade),
  buy: (item) => session.issue({ type: "buyItem", item }),
  guide: () => guide.toggle(),
});
const heroBar = new HeroBar(session, {
  select: () => selectHero(),
  cast: (ability) => cast(ability),
  learn: (ability) => session.issue({ type: "learn", ability }),
  hover: (ability) => {
    info.hoverAbility = ability;
    info.refresh(selection);
  },
  use: (slot) => session.issue({ type: "useItem", slot }),
  sell: (slot) => session.issue({ type: "sellItem", slot }),
  hoverItem: (item) => {
    info.hoverItem = item;
    info.refresh(selection);
  },
});
bar.hero = heroBar;
info.describeAbility = (id) => heroBar.describe(id);
const guide = new Guide(session);
const telemetry = new Telemetry(content, version);
telemetry.visit();
const picker = new RacePicker(session, startMatch, (how) => void (how === "quick" ? coop.quickMatch() : coop.hostGame()), applyColor, telemetry, () => guide.show());
const coop = new CoopLobby(session, startNetMatch, () => picker.show(), version, (setup) => {
  leaveMatch();
  session.startLocal(setup);
  telemetry.matchStarted();
  resetMatch();
});
coop.onLeave = (team) => {
  if (team === 0 && session.local !== 0) renderer.showBanner("The host left · match over");
  else renderer.showBanner(`${playerName(session.world, team)} disconnected · their base fights on`);
};

let selection: Selection = NOTHING;
let placement: Placement | null = null;
/** When the last placement-failure banner showed (ms), to rate-limit it. */
let lastPlaceBanner = -Infinity;
let pointer: Point | null = null;
let lastUnitClick = { id: -1, at: 0 };
let paused = false;
let accumulator = 0;
let announced = false;

// `?debug` exposes live state for automated browser checks and the console.
if (new URLSearchParams(location.search).has("debug")) {
  Object.assign(window, {
    uptime: {
      sound,
      alerts,
      groups,
      get world() {
        return session.world;
      },
      get selection() {
        return selection;
      },
      session,
      coop,
      renderer,
      content,
      TILE,
      TICK_RATE,
      /** The pause flag the harness drives; P toggles it too. */
      pause() {
        if (!session.net) paused = true;
      },
      resume() {
        paused = false;
      },
      get paused() {
        return paused;
      },
      /**
       * Step a paused solo match forward by whole ticks (`seconds` of game
       * time, exactly), through the same per-step path the frame loop uses.
       * Resolves after the next drawn frame, so a screenshot right after
       * shows the new state.
       */
      advance(seconds: number): Promise<{ tick: number; outcome: typeof session.world.outcome }> {
        if (session.net) throw new Error("uptime.advance() is solo only: co-op can't be stepped from the sidelines");
        if (!paused) throw new Error("uptime.advance() steps a paused match: call uptime.pause() first");
        const world = session.world;
        for (let left = Math.round(seconds * TICK_RATE); left > 0 && !world.outcome; left--) {
          if (!stepOnce()) break;
        }
        return new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({ tick: world.tick, outcome: world.outcome ?? null })));
        });
      },
      /** The simulation itself, for replays and checks: `await uptime.sim()`. */
      sim: () => import("./sim"),
      /** Watch a world built elsewhere (a replay at some tick) as player 1. */
      load(world: typeof session.world) {
        session.world = world;
        session.net = null;
        session.local = 0;
        session.raceId = world.teams[0]!.raceId;
        resetMatch();
      },
    },
  });
}

// --- selection -------------------------------------------------------------

/** What to fall back to: your deploy agent while deploying, else nothing. */
function fallback(): Selection {
  const builder = session.builder();
  return builder ? { kind: "entity", id: builder.id } : NOTHING;
}

/** The hero is selected: the command card shows its abilities. */
function heroSelected(): boolean {
  const hero = heroUnit(session);
  return hero !== undefined && ((selection.kind === "entity" && selection.id === hero.id) || selection.kind === "cast");
}

/** Q: select the hero; Q again (or clicking its card again) centres on it. */
function selectHero(): boolean {
  const hero = heroUnit(session);
  if (!hero) {
    const state = session.team.hero;
    if (state?.respawnAt != null) renderer.showBanner("Your hero is respawning");
    return state !== null;
  }
  if (selection.kind === "entity" && selection.id === hero.id) renderer.camera.centerOn(hero.x, hero.y);
  select({ kind: "entity", id: hero.id });
  return true;
}

/**
 * Use an ability: self abilities go at once; point and enemy abilities
 * enter aiming, and the next click picks where or who.
 */
function cast(ability: string): void {
  const reason = castBlocker(session.world, content, session.team, ability);
  if (reason) {
    renderer.showBanner(reason === "not learned" ? `Learn ${content.heroes.abilities[ability]!.name} first (Shift+number or +)` : reason === "on cooldown" ? "Not ready yet" : reason);
    return;
  }
  const def = content.heroes.abilities[ability]!;
  const hero = heroUnit(session)!;
  if (def.target === "self") {
    session.issue({ type: "cast", ability, x: hero.x, y: hero.y, targetId: null });
    renderer.ping(hero.x, hero.y);
    return;
  }
  select({ kind: "cast", ability });
}

/** The click that finishes aiming. */
function aimAt(ability: string, point: Point): void {
  const def = content.heroes.abilities[ability]!;
  const hero = heroUnit(session);
  if (!hero) return select(NOTHING);
  if (def.target === "enemy") {
    const target = enemyAt(session, point, (p) => renderer.fog.isVisible(p.x, p.y));
    if (!target) return renderer.showBanner(`${def.name} needs an enemy`);
    session.issue({ type: "cast", ability, x: target.x, y: target.y, targetId: target.id });
  } else {
    session.issue({ type: "cast", ability, x: point.x, y: point.y, targetId: null });
  }
  renderer.ping(point.x, point.y);
  select({ kind: "entity", id: hero.id });
}

/** The core is selected: the command card shows research. */
function coreSelected(): boolean {
  return selection.kind === "entity" && isCore(content, session.team, session.entity(selection.id));
}

/** The mid-match deploy agent is selected: it walks, and C + click founds an expansion. */
function agentSelected(): boolean {
  const builder = session.builder();
  return builder !== undefined && selection.kind === "entity" && selection.id === builder.id;
}

/** Train a deploy agent at the selected core (B, or the card button). Not A: WASD pans. */
function deployAgent(): boolean {
  if (selection.kind !== "entity" || !isCore(content, session.team, session.entity(selection.id))) return false;
  session.issue({ type: "trainAgent", coreId: selection.id });
  agentOrdered = true;
  return true;
}

/** Rent Spot Capacity at the selected core (N, or the card button). */
function rentCompute(): boolean {
  if (!coreSelected()) return false;
  session.issue({ type: "rentCompute" });
  return true;
}

/** A deploy agent was ordered: select it once it's out (B, then C, then click). */
let agentOrdered = false;

/** Your upgrade center is selected: the command card shows army research. */
function centerSelected(): boolean {
  const entity = selection.kind === "entity" ? session.entity(selection.id) : undefined;
  return entity?.kind === "building" && entity.team === session.local && entity.defId === session.race.center;
}

/** One of your finished Package Registries is selected: the command card is the item shop. */
function shopSelected(): boolean {
  const entity = selection.kind === "entity" ? session.entity(selection.id) : undefined;
  return entity?.kind === "building" && entity.team === session.local && entity.buildRemaining === 0 && content.buildings[entity.defId]?.shop === true;
}

function barMode(): BarMode {
  return session.deploying ? "deploy" : heroSelected() ? "hero" : coreSelected() ? "research" : centerSelected() ? "armory" : shopSelected() ? "shop" : "build";
}

function research(upgrade: string): void {
  session.issue({ type: "research", upgrade });
}

function buttonFor(s: Selection): string | null {
  return s.kind === "found" ? FOUND_BUTTON : s.kind === "place" ? s.building : s.kind === "cast" ? aimingButton(s.ability) : null;
}

function select(next: Selection): void {
  selection = next;
  refreshPointer();
}

/** Recompute everything that depends on the pointer and the selection. */
function refreshPointer(): void {
  const fog = renderer.fog;
  placement = pointer ? placementAt(session, content, selection, pointer, (p) => fog.isExplored(p.x, p.y)) : null;
  info.refresh(selection);
  const canvas = renderer.app.canvas;
  canvas.style.cursor = !pointer
    ? ""
    : placement
      ? "copy"
      : selection.kind === "cast"
        ? "crosshair"
        : ownEntityAt(session, pointer)
        ? "pointer"
        : groundOrders(session, selection, pointer, false, (p) => fog.isVisible(p.x, p.y)).length > 0
          ? "crosshair"
          : "";
}

/** The last rejection shown, so a burst of the same one is one banner. */
let lastRejection = { reason: "", at: -Infinity };
const REJECTION_REPEAT_MS = 1500;

function showRejection(reason: string): void {
  const now = performance.now();
  if (reason === lastRejection.reason && now - lastRejection.at < REJECTION_REPEAT_MS) return;
  lastRejection = { reason, at: now };
  renderer.showBanner(reason.charAt(0).toUpperCase() + reason.slice(1));
}

function order(point: Point, queue = false): void {
  const next = groundOrders(session, selection, point, queue, (p) => renderer.fog.isVisible(p.x, p.y));
  if (next.length === 0) return;
  for (const one of next) session.issue(one);
  renderer.ping(point.x, point.y);
  sound.ui("order");
  // An armed order is one-shot: back to the plain selection.
  select(disarmed(selection));
}

/**
 * Arm the selection's ground order, so the next left-click gives it: T (or the
 * panel button) for rally / attack-move, F for a plain move.
 */
/**
 * Decommission the selected buildings or dismiss the selected units (Delete,
 * Backspace, or the info card's button). Takes two presses: the first says
 * what would go, the second sends it.
 */
function removeSelected(): boolean {
  const plan = removal(session, selection);
  if (!plan) return false;
  const now = performance.now();
  if (pendingRemoval?.key === plan.key && now - pendingRemoval.at < REMOVE_CONFIRM_MS) {
    pendingRemoval = null;
    for (const order of plan.orders) session.issue(order);
    sound.ui("order");
    select(NOTHING);
    return true;
  }
  pendingRemoval = { key: plan.key, at: now };
  renderer.showBanner(`${plan.label}? Press Delete again to confirm`);
  info.refresh(selection);
  return true;
}

/** Start placing a fork of the selected building (X, or the info card's button). */
function forkSelected(): boolean {
  const entity = selectedEntity(session, selection);
  if (entity?.kind !== "building" || forkCost(session.world, content, session.local, entity) === null) return false;
  select({ kind: "place", building: entity.defId, fork: entity.id });
  return true;
}

/** Run the selected serverless function now (V, or the info card's button). */
function invokeSelected(): boolean {
  const entity = selectedEntity(session, selection);
  if (entity?.kind !== "building" || !content.buildings[entity.defId]!.invoke) return false;
  session.issue({ type: "invoke", buildingId: entity.id });
  return true;
}

/** Upgrade the selected spawner to its next rank (U, or the info card's button). */
function rankSelected(): boolean {
  if (selection.kind === "buildings") {
    // Every one in the group that can rank up, as far as the $ goes.
    const plan = rankGroup(content, session.world, session.local, buildingGroup(session, selection));
    if (plan.ids.length === 0) {
      if (plan.short === 0) return false;
      showRejection("not enough $");
      return true;
    }
    for (const id of plan.ids) session.issue({ type: "rank", buildingId: id });
    return true;
  }
  const entity = selectedEntity(session, selection);
  if (entity?.kind !== "building" || !nextRank(content, session.world, entity)) return false;
  session.issue({ type: "rank", buildingId: entity.id });
  return true;
}

function arm(how: "attack" | "move" = "attack"): boolean {
  const next = armed(session, selection, how);
  if (next) select(next);
  return next !== null;
}

function isArmed(): boolean {
  return (selection.kind === "entity" || selection.kind === "army" || selection.kind === "buildings") && Boolean(selection.armed);
}

function disarmed(s: Selection): Selection {
  if (s.kind === "entity") return { kind: "entity", id: s.id };
  if (s.kind === "buildings") return { kind: "buildings", ids: s.ids };
  if (s.kind === "army") return { kind: "army", ids: s.ids };
  return s;
}

/** Your soldiers drawn inside a screen rectangle (client pixels). */
function soldiersIn(rect: { left: number; top: number; right: number; bottom: number }) {
  return allSoldiers(session).filter((unit) => {
    const at = renderer.toScreen(unit.x, unit.y);
    return at.x >= rect.left && at.x <= rect.right && at.y >= rect.top && at.y <= rect.bottom;
  });
}

/** The hero's id if it's drawn inside a screen rectangle (client pixels), else undefined. */
function heroInBox(rect: { left: number; top: number; right: number; bottom: number }): number | undefined {
  const hero = heroUnit(session);
  if (!hero) return undefined;
  const at = renderer.toScreen(hero.x, hero.y);
  return at.x >= rect.left && at.x <= rect.right && at.y >= rect.top && at.y <= rect.bottom ? hero.id : undefined;
}

/** Your buildings (the core excepted) whose middle is drawn inside a screen rectangle (client pixels). */
function buildingsIn(rect: { left: number; top: number; right: number; bottom: number }) {
  return session.world.entities.filter((entity) => {
    if (!groupable(session, entity)) return false;
    const at = renderer.toScreen(entity.x, entity.y);
    return at.x >= rect.left && at.x <= rect.right && at.y >= rect.top && at.y <= rect.bottom;
  });
}

/** Select these buildings (or add them, with shift, to the buildings already selected). */
function selectBuildings(ids: number[], add: boolean): void {
  const base = !add ? [] : selection.kind === "buildings" ? selection.ids : selection.kind === "entity" && groupable(session, session.entity(selection.id)) ? [selection.id] : [];
  const merged = [...new Set([...base, ...ids])];
  select(merged.length > 0 ? buildingSelection(merged) : add ? selection : NOTHING);
}

/**
 * Select these units (or add them, with shift). `heroId` adds the hero to the
 * group (a box or shift-click that caught it); the hero alone selects as its
 * entity, not a one-member army.
 */
function selectUnits(ids: number[], add: boolean, heroId?: number): void {
  const base = add && selection.kind === "army" ? selection.ids : [];
  const merged = [...new Set([...base, ...ids, ...(heroId !== undefined ? [heroId] : [])])];
  select(merged.length > 0 ? armySelection(merged, heroId) : add ? selection : NOTHING);
}

function screenRect() {
  const rect = renderer.app.canvas.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

// --- game input ------------------------------------------------------------

const gameInput: GameInput = {
  blocked: () => picker.open || guide.open || coop.open,

  click(point, shift, entityId) {
    if (placement) {
      if (!placement.valid) {
        // Say why, not more than once every couple of seconds.
        const now = performance.now();
        if (placement.reason && now - lastPlaceBanner > 2000) {
          lastPlaceBanner = now;
          renderer.showBanner(placeReasonText(placement.reason));
        }
        return;
      }
      session.issue(placement.order);
      sound.ui("place");
      renderer.ping(point.x, point.y);
      if (selection.kind === "found") return select(fallback());
      if (!shift) select(NOTHING);
      return;
    }
    if (selection.kind === "cast") return aimAt(selection.ability, point);
    // Armed: the click is the order, even on top of one of your buildings.
    if (isArmed()) return order(point);
    const drawn = entityId === null ? undefined : session.entity(entityId);
    // Clicking the ground inside one of your buildings selects it, even if a
    // tall unit (your hero) is drawn in front of it.
    const footprint = ownEntityAt(session, point);
    const own =
      footprint?.kind === "building" ? footprint : (drawn && drawn.team === session.team.id ? drawn : undefined) ?? footprint;
    if (isSoldier(session, own)) {
      const now = performance.now();
      const double = lastUnitClick.id === own.id && now - lastUnitClick.at < DOUBLE_CLICK_MS;
      lastUnitClick = { id: own.id, at: now };
      // Double-click: every one of its kind on screen.
      if (double) return selectUnits(soldiersIn(screenRect()).filter((u) => u.defId === own.defId).map((u) => u.id), shift);
      // Shift-click toggles it in or out of the group (the hero alone becomes its entity).
      if (shift) {
        const toggled = toggleUnit(session, selection, own);
        if (toggled) return select(toggled);
      }
      return select(armySelection([own.id]));
    }
    if (own && groupable(session, own)) {
      const now = performance.now();
      const double = lastUnitClick.id === own.id && now - lastUnitClick.at < DOUBLE_CLICK_MS;
      lastUnitClick = { id: own.id, at: now };
      // Double-click: every one of its kind on screen, to rally or manage them together.
      if (double) return selectBuildings(buildingsIn(screenRect()).filter((b) => b.defId === own.defId).map((b) => b.id), shift);
      // Shift-click adds it to the selected buildings (or takes it out).
      const toggled = shift ? toggleBuilding(session, selection, own) : null;
      return select(toggled ?? { kind: "entity", id: own.id });
    }
    // Your hero (or anything else of yours, the core included): shift-click
    // toggles the hero in or out of a selected army; a plain click selects it
    // alone, with its abilities.
    if (own) {
      if (shift) {
        const toggled = toggleUnit(session, selection, own);
        if (toggled) return select(toggled);
      }
      return select({ kind: "entity", id: own.id });
    }
    if (leftClickOrders(session, selection)) return order(point);
    // A site, held by anyone, can be looked at where the map is explored; it takes no orders.
    const site = siteAt(session, point);
    if (site && renderer.fog.isExplored(site.x, site.y)) return select({ kind: "entity", id: site.id });
    select(NOTHING);
  },

  rightClick(point, _onMinimap, queue) {
    if (selection.kind === "place" || selection.kind === "found") return select(fallback());
    if (selection.kind === "cast") {
      const hero = heroUnit(session);
      return select(hero ? { kind: "entity", id: hero.id } : NOTHING);
    }
    // Your hero — alone or marching with an army — and an enemy under the
    // pointer: it attacks the enemy itself. Alone, that's the whole order;
    // with an army, the soldiers still attack-move there as usual.
    const hero = heroUnit(session);
    const heroInArmy = selection.kind === "army" && armyHero(session, selection) !== undefined;
    if (hero && (heroInArmy || (selection.kind === "entity" && selection.id === hero.id))) {
      const enemy = enemyAt(session, point, (p) => renderer.fog.isVisible(p.x, p.y));
      if (enemy) {
        if (selection.kind === "army") for (const one of soldierOrders(session, selection, point, queue === true)) session.issue(one);
        session.issue({ type: "attack", targetId: enemy.id });
        renderer.ping(enemy.x, enemy.y);
        return;
      }
    }
    // Nothing selected while deploying: right-click still walks the agent.
    if (selection.kind === "none" && session.builder()) select(fallback());
    order(point, queue === true);
  },

  boxSelect(rect, shift) {
    if (selection.kind === "place" || selection.kind === "found") return;
    const ids = soldiersIn(rect).map((u) => u.id);
    // The hero joins the group like any unit (a box with only it selects the hero).
    const heroId = heroInBox(rect);
    if (ids.length === 0 && heroId === undefined && session.deploying) return;
    // Units win; a box with neither in it picks up your spawners instead, to rally them together.
    if (ids.length === 0 && heroId === undefined && !(shift && selection.kind === "army")) {
      const spawners = buildingsIn(rect).filter((b) => isRallied(session, b)).map((b) => b.id);
      if (spawners.length > 0) return selectBuildings(spawners, shift);
    }
    selectUnits(ids, shift, heroId);
  },

  hover(point) {
    pointer = point;
    refreshPointer();
  },

  key(key, event) {
    // M works anywhere, menus included.
    if (key === "m") return cycleSound(), true;
    // The guide opens over the home screen too, so it hears keys first.
    if (guide.key(key)) return true;
    if (picker.key(key, event)) return true;
    if (key === "g") return guide.show(), true;
    if (key === "escape") {
      // Esc backs out one step: aiming or an armed order first, then the selection.
      const hero = heroUnit(session);
      if (selection.kind === "cast") select(hero ? { kind: "entity", id: hero.id } : NOTHING);
      else select(isArmed() ? disarmed(selection) : session.deploying ? fallback() : NOTHING);
      return true;
    }
    // Control groups: Ctrl/Alt + 1..9 saves, 1..9 recalls (and wins over the
    // build hotkey with the same number once the group exists). With the hero
    // selected, Alt+1..6 uses its inventory instead: the slots' hotkeys.
    const groupKey = /^Digit([1-9])$/.exec(event.code)?.[1];
    if (groupKey && !session.deploying) {
      const n = Number(groupKey);
      if (event.altKey && !event.ctrlKey && heroSelected() && n <= MAX_ITEMS) {
        session.issue({ type: "useItem", slot: n - 1 });
        return true;
      }
      if (event.ctrlKey || event.altKey) {
        if (groups.assign(n, selection)) renderer.showBanner(`Group ${n} set`);
        return true;
      }
      if (!event.shiftKey && groups.has(n) && !heroSelected() && !coreSelected() && !centerSelected() && !shopSelected()) {
        const recalled = groups.recall(n, (id) => session.entity(id) !== undefined, performance.now());
        if (recalled) {
          select(recalled.selection);
          if (recalled.doubleTap) {
            const first =
              recalled.selection.kind === "army" || recalled.selection.kind === "buildings"
                ? session.entity(recalled.selection.ids[0]!)
                : session.entity((recalled.selection as { id: number }).id);
            if (first) renderer.camera.centerOn(first.x, first.y);
          }
          return true;
        }
      }
    }
    if (key === "q" && !session.deploying) return selectHero();
    if (key === "t") return arm();
    if (key === "f") return arm("move");
    if (key === "v") return invokeSelected();
    if (key === "x") return forkSelected();
    if (key === "u") return rankSelected();
    if (key === "delete" || key === "backspace") return removeSelected();
    if (key === "z") {
      // The whole army.
      const ids = allSoldiers(session).map((u) => u.id);
      if (ids.length === 0) return renderer.showBanner("No units yet"), true;
      return select({ kind: "army", ids }), true;
    }
    if (key === "p") {
      if (session.net) renderer.showBanner("Co-op can't pause");
      else paused = !paused;
      return true;
    }
    if (key === "r" && session.world.outcome) return picker.show(), true;
    // Space: to the latest alert if there's a fresh one, else home. H: always home.
    const alert = key === " " ? alerts.latest(performance.now() / 1000) : null;
    if (alert) {
      renderer.camera.centerOn(alert.x, alert.y);
      alerts.recent.shift();
      return true;
    }
    if (key === " " || key === "h") {
      const home = session.home();
      if (home) renderer.camera.centerOn(home.x, home.y);
      if (session.deploying) select(fallback());
      return true;
    }
    if (session.deploying) {
      if (key === "c" && session.builder()) return select({ kind: "found" }), true;
      return false;
    }
    // The mid-match deploy agent: C enters found mode like at match start.
    if (key === "c" && agentSelected()) return select({ kind: "found" }), true;
    if (heroSelected()) {
      // Number keys cast; Shift+number learns (event.code, since Shift turns 1 into !).
      const digit = /^Digit([1-4])$/.exec(event.code)?.[1];
      const ability = digit ? heroBar.abilities()[Number(digit) - 1] : undefined;
      if (!ability) return false;
      if (event.shiftKey) session.issue({ type: "learn", ability });
      else cast(ability);
      return true;
    }
    if (coreSelected() || centerSelected()) {
      if (key === "b" && coreSelected()) return deployAgent(), true;
      if (key === "n" && coreSelected()) return rentCompute(), true;
      const upgrade = bar.upgrades(barMode())[Number(key) - 1];
      if (upgrade) return research(upgrade), true;
      return false;
    }
    if (shopSelected()) {
      const item = shopStock(content)[Number(key) - 1];
      if (item) return session.issue({ type: "buyItem", item }), true;
      return false;
    }
    // 1..9 pick the first nine buildings, 0 the tenth; L and K are Wall and Gate.
    const building = buildingForKey(session.race.buildings, key);
    if (building) return select({ kind: "place", building }), true;
    return false;
  },
};

// --- match -----------------------------------------------------------------

/** Paint the world and the UI accent in the player's colour. */
function applyColor(): void {
  setLocalColor(session.local, session.color.hex);
  document.documentElement.style.setProperty("--accent", `#${session.color.hex.toString(16).padStart(6, "0")}`);
}

/** Report the match being left, if it never finished (a new one is starting). */
function leaveMatch(): void {
  if (!session.world.outcome) telemetry.report(session.world, session.local, false);
}

function startMatch(raceId: string, heroId?: string): void {
  leaveMatch();
  applyColor();
  session.start(raceId, heroId);
  telemetry.matchStarted();
  resetMatch();
}

function startNetMatch(match: NetMatch): void {
  leaveMatch();
  session.startNet(match);
  telemetry.matchStarted();
  resetMatch();
}

function resetMatch(): void {
  director.reset();
  alerts.reset();
  groups.reset();
  renderer.localTeam = session.local;
  // After the team is known: in co-op your colour paints your own slot.
  applyColor();
  bar.reset();
  renderer.setWorld(session.world);
  accumulator = 0;
  announced = false;
  paused = false;
  renderer.showBanner("");
  select(fallback());
}

// Presence for the match report: any mouse or key input, at most once a game second.
for (const type of ["pointerdown", "pointermove", "keydown", "wheel"] as const) {
  window.addEventListener(type, () => telemetry.noteInput(session.world), { capture: true, passive: true });
}

// Closing the tab mid-match still reports it.
addEventListener("pagehide", () => {
  if (!session.world.outcome) telemetry.report(session.world, session.local, false, true);
});

applyColor();
// HUD first: the stage's size depends on the build bar's height.
bar.update(barMode(), null);
// The Three.js world view is the default; `?2d` keeps the flat Pixi one.
const use3d = !new URLSearchParams(location.search).has("2d");
await renderer.init($("stage"), { transparent: use3d });
if (use3d) {
  const { World3D } = await import("./render/three/world3d");
  renderer.attach(new World3D($("stage")));
}
bindInput(renderer, gameInput);
renderer.setWorld(session.world);
const invite = CoopLobby.inviteInUrl();
if (invite) void coop.join(invite);
else picker.show();

/**
 * Run the match forward by the real time since the last call: whole ticks
 * only, the remainder carried in `accumulator` for the renderer to
 * interpolate. The frame loop calls this; so does the metronome while the tab
 * is hidden in co-op, since there's no frame loop then and the others are
 * waiting on our turns.
 */
let lastAdvance = performance.now();
function advance(now: number): void {
  // Capped so a long gap (a hidden solo tab coming back) doesn't burst.
  const delta = Math.min(Math.max(0, now - lastAdvance), MAX_STEPS_PER_FRAME * STEP_MS);
  lastAdvance = now;
  const { world } = session;
  // Co-op never pauses: the others are waiting on our turns.
  // A solo match waits behind the lobby (it's the home screen's backdrop, not a game yet).
  const running = session.net ? !coop.open : !paused && !guide.open && !coop.open;
  if (running && !picker.open && !world.outcome) {
    accumulator += delta;
    let steps = 0;
    while (accumulator >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
      if (!stepOnce()) {
        // Waiting on another player's turn: hold, don't bank time to burst through later.
        accumulator = Math.min(accumulator, STEP_MS);
        break;
      }
      accumulator -= STEP_MS;
      steps += 1;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
  }
}

/**
 * One simulation step and everything the player sees or hears because of it:
 * interpolation capture, sounds, alerts and banners. The frame loop and the
 * `?debug` harness's advance() both go through here, so they can't drift.
 * Returns false when waiting on another player's turn (co-op).
 */
function stepOnce(): boolean {
  const world = session.world;
  renderer.capturePrevious(world);
  if (!session.tryStep()) return false;
  renderer.collectEvents(world);
  for (const cue of director.cues(world, world.events, session.local, listener, performance.now() / 1000)) sound.play(cue);
  for (const alert of alerts.update(world, world.events, session.local, performance.now() / 1000, onScreen, (p) => renderer.fog.isVisible(p.x, p.y))) {
    renderer.showBanner(`${alert.text} · Space to look`);
    sound.play({ name: alert.kind === "lost" || alert.kind === "wiped" ? "building-down" : alert.kind === "hero" ? "hero-down" : alert.kind === "camp" || (alert.kind === "site" && alert.text === "Site captured") ? "level-up" : "alarm", volume: 0.6, pan: 0 });
  }
  for (const event of world.events) {
    if (event.type === "failover" && event.team === session.team.id) renderer.showBanner("Core lost · failover");
    if (event.type === "offline") {
      const w = session.world;
      const alliesUp = humanTeams(w).some((t) => t.id !== session.local && t.downTick === null && allied(w, t.id, session.local));
      renderer.showBanner(
        event.team === session.local
          ? alliesUp ? "You're offline · your allies play on" : "You're offline · spectating"
          : allied(w, event.team, session.local) ? `${playerName(w, event.team)} is offline` : `${playerName(w, event.team)} is out`,
      );
    }
    // Diplomacy that involves you.
    if (event.type === "ally-offer" && event.with === session.local) renderer.showBanner(`${playerName(session.world, event.team)} offers an alliance · accept it top right`);
    if (event.type === "allied" && (event.team === session.local || event.with === session.local)) {
      renderer.showBanner(`Allied with ${playerName(session.world, event.team === session.local ? event.with : event.team)}`);
    }
    if (event.type === "unallied" && event.with === session.local) renderer.showBanner(`${playerName(session.world, event.team)} broke the alliance`);
    if (event.type === "hero-level" && event.team === session.local) renderer.showBanner(`Level ${event.level} · skill point ready (Q)`);

    if (event.type === "hero-up" && event.team === session.local) renderer.showBanner("Your hero is back");
    // Something you asked for didn't happen: say why, not just the error sound.
    if (event.type === "rejected" && event.command.team === session.local) showRejection(event.reason);
    if (event.type === "decommissioned" && event.team === session.local) {
      renderer.showBanner(
        event.buildings > 0
          ? `Decommissioned ${event.buildings} building${event.buildings === 1 ? "" : "s"}${event.refund > 0 ? ` · +$${event.refund}` : ""}`
          : `Dismissed ${event.units} unit${event.units === 1 ? "" : "s"}`,
      );
    }
    if (event.type === "researched" && event.team === session.team.id) {
      const def = content.upgrades[event.upgrade]!;
      const perk = def.stat === "tier" ? content.races[session.team.raceId]?.tierPerks?.[event.level] : undefined;
      renderer.showBanner(
        def.stat === "tier"
          ? `${content.economy.tiers[event.level]!.name} online${perk ? ` · ${perk.name}` : ""}`
          : def.stat === "trait"
            ? `${upgradeName(content, session.team.raceId, event.upgrade)} unlocked`
            : `${upgradeName(content, session.team.raceId, event.upgrade)} ${event.level}`,
      );
    }
  }
  return true;
}

// Co-op in a hidden tab: no frames, but the match goes on.
metronome(STEP_MS, () => {
  if (document.hidden && session.net) advance(performance.now());
});

/** The info card follows the match (countdowns, prices), not only the pointer. */
let infoClock = 0;
renderer.app.ticker.add((ticker) => {
  infoClock += ticker.deltaMS;
  if (infoClock >= 250) {
    infoClock = 0;
    info.refresh(selection);
  }
  advance(performance.now());
  const { world } = session;
  {
    const now = performance.now() / 1000;
    renderer.setMinimapFlashes(alerts.recent.map((a) => ({ x: a.x, y: a.y, age: now - a.at, color: ALERT_COLOR[a.kind] })));
  }
  // On the home screen and in the lobby, the match's own HUD steps aside.
  document.body.classList.toggle("home", picker.open || coop.open);
  telemetry.checkpoint(world, session.local);
  if (world.outcome && !announced) {
    announced = true;
    renderer.showBanner(hud.announce());
    telemetry.report(world, session.local, true);
  }

  // Selections that stopped making sense: the agent deployed or died, the deploy phase ended.
  if (selection.kind === "entity" && !selectedEntity(session, selection)) select(fallback());
  // Found mode lives as long as there's an agent to found with (match start
  // or a mid-match expansion alike).
  if (selection.kind === "found" && !session.builder()) select(NOTHING);
  if (agentOrdered && !session.deploying) {
    const agent = session.builder();
    if (agent) {
      agentOrdered = false;
      select({ kind: "entity", id: agent.id });
    } else if (session.team.money < content.buildings[session.race.core]!.cost) agentOrdered = false;
  }
  if (selection.kind === "army") {
    // Dead soldiers drop out; the hero stays while it lives. An army down to
    // just the hero collapses to its entity, with its abilities.
    const hero = armyHero(session, selection);
    const kept = livingArmyIds(session, selection);
    if (kept.length === 0) select(fallback());
    else if (kept.length !== selection.ids.length) select(hero && kept.length === 1 ? { kind: "entity", id: hero.id } : { ...selection, ids: kept });
  }
  if (selection.kind === "buildings") {
    const standing = buildingGroup(session, selection);
    if (standing.length !== selection.ids.length) select(buildingSelection(standing.map((b) => b.id)));
  }
  if (selection.kind === "cast" && !heroUnit(session)) select(NOTHING);

  bar.update(barMode(), buttonFor(selection));
  const selectedId = selection.kind === "entity" ? selection.id : null;
  renderer.draw(world, content, paused ? 1 : accumulator / STEP_MS, ticker.deltaMS, placement, selectedId, selectedIds(selection));
  hud.update(selection, paused);
  playersPanel.update();
  sound.setTension(tension(world, session.local, content));
  heroBar.update();
});
