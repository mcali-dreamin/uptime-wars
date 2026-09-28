// Wiring: session + selection + UI + renderer + input, and the frame loop.
// Game meaning lives in game/, drawing in render/, panels in ui/.

import { bindInput, type GameInput } from "./input";
import { Renderer } from "./render/renderer";
import {
  NOTHING,
  groundOrder,
  leftClickOrders,
  ownEntityAt,
  placementAt,
  selectedEntity,
  type Placement,
  type Selection,
} from "./game/selection";
import { Session } from "./game/session";
import { BuildBar, FOUND_BUTTON } from "./ui/build-bar";
import { $ } from "./ui/dom";
import { Guide } from "./ui/guide";
import { Hud } from "./ui/hud";
import { InfoPanel } from "./ui/info-panel";
import { RacePicker } from "./ui/race-picker";
import { TICK_RATE, TILE, loadDefaultContent, step, type Point } from "./sim";

const STEP_MS = 1000 / TICK_RATE;
const MAX_STEPS_PER_FRAME = 5;

const content = loadDefaultContent();
const session = new Session(content);
const renderer = new Renderer();
const hud = new Hud(session);
const info = new InfoPanel(session);
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
  guide: () => guide.toggle(),
});
const guide = new Guide(session);
const picker = new RacePicker(session, startMatch);

let selection: Selection = NOTHING;
let placement: Placement | null = null;
let pointer: Point | null = null;
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
}

// --- game input ------------------------------------------------------------

const gameInput: GameInput = {
  blocked: () => picker.open || guide.open,

  click(point, shift) {
    if (placement) {
      if (!placement.valid) return;
      session.issue(placement.order);
      renderer.ping(point.x, point.y);
      if (selection.kind === "found") return select(fallback());
      if (!shift) select(NOTHING);
      return;
    }
    const own = ownEntityAt(session, point);
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

  hover(point) {
    pointer = point;
    refreshPointer();
  },

  key(key) {
    if (picker.key(key)) return true;
    if (guide.key(key)) return true;
    if (key === "g") return guide.show(), true;
    if (key === "escape") return select(NOTHING), true;
    if (key === "p") return (paused = !paused), true;
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
    const building = session.race.buildings[Number(key) - 1];
    if (building) return select({ kind: "place", building }), true;
    return false;
  },
};

// --- match -----------------------------------------------------------------

function startMatch(raceId: string): void {
  session.start(raceId);
  bar.reset();
  renderer.setWorld(session.world);
  accumulator = 0;
  announced = false;
  paused = false;
  renderer.showBanner("");
  select(fallback());
}

// HUD first: the stage's size depends on the build bar's height.
bar.update(null);
await renderer.init($("stage"));
bindInput(renderer, gameInput);
renderer.setWorld(session.world);
picker.show();

renderer.app.ticker.add((ticker) => {
  const { world } = session;
  if (!paused && !picker.open && !guide.open && !world.outcome) {
    accumulator += ticker.deltaMS;
    let steps = 0;
    while (accumulator >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
      renderer.capturePrevious(world);
      step(world, content);
      renderer.collectEvents(world);
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

  bar.update(buttonFor(selection));
  const selectedId = selection.kind === "entity" ? selection.id : null;
  renderer.draw(world, content, paused ? 1 : accumulator / STEP_MS, ticker.deltaMS, placement, selectedId);
  hud.update(selection, paused);
});
