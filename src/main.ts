// Wiring: session + selection + UI + renderer + input, and the frame loop.
// Game meaning lives in game/, drawing in render/, panels in ui/.

import { bindInput, type GameInput } from "./input";
import { Renderer } from "./render/renderer";
import {
  NOTHING,
  armed,
  enemyAt,
  groundOrder,
  leftClickOrders,
  ownEntityAt,
  placementAt,
  selectedEntity,
  type Placement,
  type Selection,
} from "./game/selection";
import { Session } from "./game/session";
import { setLocalColor } from "./render/palette";
import { BuildBar, FOUND_BUTTON, aimingButton, type BarMode } from "./ui/build-bar";
import { $ } from "./ui/dom";
import { Guide } from "./ui/guide";
import { Hud } from "./ui/hud";
import { InfoPanel } from "./ui/info-panel";
import { RacePicker } from "./ui/race-picker";
import { TICK_RATE, TILE, isCore, loadDefaultContent, type Point } from "./sim";
import type { NetMatch } from "./game/net/lobby";
import { CoopLobby } from "./ui/coop";
import { HeroBar, heroUnit } from "./ui/hero-bar";
import { castBlocker } from "./sim/heroes";

const STEP_MS = 1000 / TICK_RATE;
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
const heroBar = new HeroBar(session, {
  select: () => selectHero(),
  cast: (ability) => cast(ability),
  learn: (ability) => session.issue({ type: "learn", ability }),
  hover: (ability) => {
    info.hoverAbility = ability;
    info.refresh(selection);
  },
});
bar.hero = heroBar;
info.describeAbility = (id) => heroBar.describe(id);
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

function barMode(): BarMode {
  return session.deploying ? "deploy" : heroSelected() ? "hero" : coreSelected() ? "research" : "build";
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
  if (selection.kind === "entity" && selection.armed) select({ kind: "entity", id: selection.id });
}

/** Arm the selection's ground order, so the next left-click gives it (T, or the panel button). */
function arm(): boolean {
  const next = armed(session, selection);
  if (next) select(next);
  return next !== null;
}

function isArmed(): boolean {
  return selection.kind === "entity" && selection.armed === true;
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
    if (selection.kind === "cast") return aimAt(selection.ability, point);
    // Armed: the click is the order, even on top of one of your buildings.
    if (isArmed()) return order(point);
    const drawn = entityId === null ? undefined : session.entity(entityId);
    const own = (drawn && drawn.team === session.team.id ? drawn : undefined) ?? ownEntityAt(session, point);
    if (own) return select({ kind: "entity", id: own.id });
    if (leftClickOrders(session, selection)) return order(point);
    select(NOTHING);
  },

  rightClick(point) {
    if (selection.kind === "place" || selection.kind === "found") return select(fallback());
    if (selection.kind === "cast") {
      const hero = heroUnit(session);
      return select(hero ? { kind: "entity", id: hero.id } : NOTHING);
    }
    // Hero selected and an enemy under the pointer: attack it.
    const hero = heroUnit(session);
    if (hero && selection.kind === "entity" && selection.id === hero.id) {
      const enemy = enemyAt(session, point, (p) => renderer.fog.isVisible(p.x, p.y));
      if (enemy) {
        session.issue({ type: "attack", targetId: enemy.id });
        renderer.ping(enemy.x, enemy.y);
        return;
      }
    }
    // Nothing selected while deploying: right-click still walks the agent.
    if (selection.kind === "none" && session.builder()) select(fallback());
    order(point);
  },

  hover(point) {
    pointer = point;
    refreshPointer();
  },

  key(key, event) {
    if (picker.key(key)) return true;
    if (guide.key(key)) return true;
    if (key === "g") return guide.show(), true;
    if (key === "escape") {
      // Esc backs out one step: aiming or an armed order first, then the selection.
      const hero = heroUnit(session);
      if (selection.kind === "cast") select(hero ? { kind: "entity", id: hero.id } : NOTHING);
      else select(selection.kind === "entity" && selection.armed ? { kind: "entity", id: selection.id } : NOTHING);
      return true;
    }
    if (key === "q" && !session.deploying) return selectHero();
    if (key === "t") return arm();
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
    if (heroSelected()) {
      // Number keys cast; Shift+number learns (event.code, since Shift turns 1 into !).
      const digit = /^Digit([1-4])$/.exec(event.code)?.[1];
      const ability = digit ? heroBar.abilities()[Number(digit) - 1] : undefined;
      if (!ability) return false;
      if (event.shiftKey) session.issue({ type: "learn", ability });
      else cast(ability);
      return true;
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

function startMatch(raceId: string, heroId?: string): void {
  applyColor();
  session.start(raceId, heroId);
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
        if (event.type === "hero-level" && event.team === session.local) renderer.showBanner(`Level ${event.level} · skill point ready (Q)`);
        if (event.type === "hero-down" && event.team === session.local) renderer.showBanner("Your hero is down");
        if (event.type === "hero-up" && event.team === session.local) renderer.showBanner("Your hero is back");
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
  if (selection.kind === "cast" && !heroUnit(session)) select(NOTHING);

  bar.update(barMode(), buttonFor(selection));
  const selectedId = selection.kind === "entity" ? selection.id : null;
  renderer.draw(world, content, paused ? 1 : accumulator / STEP_MS, ticker.deltaMS, placement, selectedId);
  hud.update(selection, paused);
  heroBar.update();
});
