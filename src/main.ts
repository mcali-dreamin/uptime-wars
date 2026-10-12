// Wiring: session + selection + UI + renderer + input, and the frame loop.
// Game meaning lives in game/, drawing in render/, panels in ui/.

import { bindInput, type GameInput } from "./input";
import { Renderer } from "./render/renderer";
import {
  NOTHING,
  allSoldiers,
  armed,
  armyUnits,
  groundOrder,
  isSoldier,
  leftClickOrders,
  ownEntityAt,
  placementAt,
  selectedEntity,
  selectedIds,
  type Placement,
  type Selection,
} from "./game/selection";
import { Session } from "./game/session";
import { setLocalColor } from "./render/palette";
import { BuildBar, FOUND_BUTTON, type BarMode } from "./ui/build-bar";
import { $ } from "./ui/dom";
import { Guide } from "./ui/guide";
import { Hud } from "./ui/hud";
import { InfoPanel } from "./ui/info-panel";
import { RacePicker } from "./ui/race-picker";
import { TICK_RATE, TILE, isCore, loadDefaultContent, type Point } from "./sim";
import type { NetMatch } from "./game/net/lobby";
import { CoopLobby } from "./ui/coop";

const STEP_MS = 1000 / TICK_RATE;
/** Two clicks on the same unit this close together select all of its kind on screen. */
const DOUBLE_CLICK_MS = 350;
const MAX_STEPS_PER_FRAME = 5;

const content = loadDefaultContent();
const session = new Session(content);
const renderer = new Renderer();
const hud = new Hud(session);
const info = new InfoPanel(session, () => arm());
const bar = new BuildBar(session, {
  choose: (button) => {
    const current = buttonFor(selection);
    if (current === button) return select(fallback());
    select(button === FOUND_BUTTON ? { kind: "found" } : { kind: "place", building: button });
  },
  hover: (button) => {
    info.hoverButton = button;
    info.refresh(selection);
  },
  research: (upgrade) => research(upgrade),
  guide: () => guide.toggle(),
});
const guide = new Guide(session);
const picker = new RacePicker(session, startMatch, () => void coop.hostGame(), applyColor);
const coop = new CoopLobby(session, startNetMatch, () => picker.show());
coop.onLeave = (team) => {
  if (team === 0 && session.local !== 0) renderer.showBanner("The host left · match over");
  else renderer.showBanner(`Player ${team + 1} disconnected · their base fights on`);
};

let selection: Selection = NOTHING;
let placement: Placement | null = null;
let pointer: Point | null = null;
let lastUnitClick = { id: -1, at: 0 };
let paused = false;
let accumulator = 0;
let announced = false;

// `?debug` exposes live state for automated browser checks and the console.
if (new URLSearchParams(location.search).has("debug")) {
  Object.assign(window, {
    uptime: {
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
    },
  });
}

// --- selection -------------------------------------------------------------

/** What to fall back to: your deploy agent while deploying, else nothing. */
function fallback(): Selection {
  const builder = session.builder();
  return builder ? { kind: "entity", id: builder.id } : NOTHING;
}

/** The core is selected: the command card shows research. */
function coreSelected(): boolean {
  return selection.kind === "entity" && isCore(content, session.team, session.entity(selection.id));
}

function barMode(): BarMode {
  return session.deploying ? "deploy" : coreSelected() ? "research" : "build";
}

function research(upgrade: string): void {
  session.issue({ type: "research", upgrade });
}

function buttonFor(s: Selection): string | null {
  return s.kind === "found" ? FOUND_BUTTON : s.kind === "place" ? s.building : null;
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
      : ownEntityAt(session, pointer)
        ? "pointer"
        : groundOrder(session, selection, pointer)
          ? "crosshair"
          : "";
}

function order(point: Point): void {
  const next = groundOrder(session, selection, point);
  if (!next) return;
  session.issue(next);
  renderer.ping(point.x, point.y);
  // An armed order is one-shot: back to the plain selection.
  select(disarmed(selection));
}

/**
 * Arm the selection's ground order, so the next left-click gives it: T (or the
 * panel button) for rally / attack-move, F for a plain move.
 */
function arm(how: "attack" | "move" = "attack"): boolean {
  const next = armed(session, selection, how);
  if (next) select(next);
  return next !== null;
}

function isArmed(): boolean {
  return (selection.kind === "entity" || selection.kind === "army") && Boolean(selection.armed);
}

function disarmed(s: Selection): Selection {
  if (s.kind === "entity") return { kind: "entity", id: s.id };
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

/** Select these units (or add them, with shift). */
function selectUnits(ids: number[], add: boolean): void {
  const base = add && selection.kind === "army" ? selection.ids : [];
  const merged = [...new Set([...base, ...ids])];
  select(merged.length > 0 ? { kind: "army", ids: merged } : add ? selection : NOTHING);
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
      if (!placement.valid) return;
      session.issue(placement.order);
      renderer.ping(point.x, point.y);
      if (selection.kind === "found") return select(fallback());
      if (!shift) select(NOTHING);
      return;
    }
    // Armed: the click is the order, even on top of one of your buildings.
    if (isArmed()) return order(point);
    const drawn = entityId === null ? undefined : session.entity(entityId);
    const own = (drawn && drawn.team === session.team.id ? drawn : undefined) ?? ownEntityAt(session, point);
    if (isSoldier(session, own)) {
      const now = performance.now();
      const double = lastUnitClick.id === own.id && now - lastUnitClick.at < DOUBLE_CLICK_MS;
      lastUnitClick = { id: own.id, at: now };
      // Double-click: every one of its kind on screen.
      if (double) return selectUnits(soldiersIn(screenRect()).filter((u) => u.defId === own.defId).map((u) => u.id), shift);
      // Shift-click toggles it in or out of the group.
      if (shift && selection.kind === "army") {
        const ids = selection.ids.includes(own.id) ? selection.ids.filter((id) => id !== own.id) : [...selection.ids, own.id];
        return select(ids.length > 0 ? { kind: "army", ids } : NOTHING);
      }
      return select({ kind: "army", ids: [own.id] });
    }
    if (own) return select({ kind: "entity", id: own.id });
    if (leftClickOrders(session, selection)) return order(point);
    select(NOTHING);
  },

  rightClick(point) {
    if (selection.kind === "place" || selection.kind === "found") return select(fallback());
    // Nothing selected while deploying: right-click still walks the agent.
    if (selection.kind === "none" && session.builder()) select(fallback());
    order(point);
  },

  boxSelect(rect, shift) {
    if (selection.kind === "place" || selection.kind === "found") return;
    const ids = soldiersIn(rect).map((u) => u.id);
    if (ids.length === 0 && session.deploying) return;
    selectUnits(ids, shift);
  },

  hover(point) {
    pointer = point;
    refreshPointer();
  },

  key(key) {
    if (picker.key(key)) return true;
    if (guide.key(key)) return true;
    if (key === "g") return guide.show(), true;
    if (key === "escape") {
      // Esc backs out one step: an armed order first, then the selection.
      select(isArmed() ? disarmed(selection) : session.deploying ? fallback() : NOTHING);
      return true;
    }
    if (key === "t") return arm();
    if (key === "f") return arm("move");
    if (key === "q") {
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
    if (coreSelected()) {
      const upgrade = Object.keys(content.upgrades)[Number(key) - 1];
      if (upgrade) return research(upgrade), true;
      return false;
    }
    const building = session.race.buildings[Number(key) - 1];
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

function startMatch(raceId: string): void {
  applyColor();
  session.start(raceId);
  resetMatch();
}

function startNetMatch(match: NetMatch): void {
  session.startNet(match);
  resetMatch();
}

function resetMatch(): void {
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

renderer.app.ticker.add((ticker) => {
  const { world } = session;
  // Co-op never pauses: the others are waiting on our turns.
  const running = session.net ? !coop.open : !paused && !guide.open;
  if (running && !picker.open && !world.outcome) {
    accumulator += ticker.deltaMS;
    let steps = 0;
    while (accumulator >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
      renderer.capturePrevious(world);
      if (!session.tryStep()) {
        // Waiting on another player's turn: hold, don't bank time to burst through later.
        accumulator = Math.min(accumulator, STEP_MS);
        break;
      }
      renderer.collectEvents(world);
      for (const event of world.events) {
        if (event.type === "failover" && event.team === session.team.id) renderer.showBanner("Core lost · failover");
        if (event.type === "offline") {
          renderer.showBanner(event.team === session.local ? "You're offline · your allies play on" : `Player ${event.team + 1} is offline`);
        }
        if (event.type === "researched" && event.team === session.team.id) {
          renderer.showBanner(`${content.upgrades[event.upgrade]!.name} ${event.level}`);
        }
      }
      accumulator -= STEP_MS;
      steps += 1;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
  }
  if (world.outcome && !announced) {
    announced = true;
    renderer.showBanner(hud.announce());
  }

  // Selections that stopped making sense: the agent deployed or died, the deploy phase ended.
  if (selection.kind === "entity" && !selectedEntity(session, selection)) select(fallback());
  if (selection.kind === "found" && !session.deploying) select(NOTHING);
  if (selection.kind === "army") {
    const alive = armyUnits(session, selection);
    if (alive.length === 0) select(fallback());
    else if (alive.length !== selection.ids.length) select({ ...selection, ids: alive.map((u) => u.id) });
  }

  bar.update(barMode(), buttonFor(selection));
  const selectedId = selection.kind === "entity" ? selection.id : null;
  renderer.draw(world, content, paused ? 1 : accumulator / STEP_MS, ticker.deltaMS, placement, selectedId, selectedIds(selection));
  hud.update(selection, paused);
});
