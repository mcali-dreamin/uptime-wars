import { Renderer, type Ghost } from "./render/renderer";
import {
  TICK_RATE,
  TILE,
  buildCost,
  canPlace,
  createWorld,
  hashWorld,
  loadDefaultContent,
  queueCommand,
  step,
  type TeamId,
  type World,
} from "./sim";

const STEP_MS = 1000 / TICK_RATE;
/** Commands land this many ticks in the future, as they will in lockstep. */
const INPUT_DELAY_TICKS = 2;
const MAX_STEPS_PER_FRAME = 5;
const DRAG_THRESHOLD_PX = 5;
const HUMAN: TeamId = 0;
const SETUP = { races: ["open-source", "botnet"] as [string, string] };

const content = loadDefaultContent();
const renderer = new Renderer();
let world: World = newMatch();
let selected: string | null = null;
let ghost: Ghost | null = null;
let paused = false;
let accumulator = 0;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const hud = {
  compute: $("compute"),
  core: $("core"),
  wave: $("wave"),
  nextWave: $("next-wave"),
  status: $("status"),
  buildBar: $("build-bar"),
};

function newMatch(): World {
  const seed = (Math.random() * 2 ** 31) | 0;
  return createWorld(content, { seed, races: SETUP.races });
}

// `?debug` exposes live state for automated browser checks and the console.
if (new URLSearchParams(location.search).has("debug")) {
  Object.assign(window, {
    uptime: { get world() { return world; }, renderer, content, TILE },
  });
}

// HUD first: the stage's size depends on the build bar's height.
buildBar();
await renderer.init($("stage"));
renderer.setWorld(world);

renderer.app.ticker.add((ticker) => {
  if (!paused && !world.outcome) {
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
    if (world.outcome) announceOutcome();
  }
  renderer.draw(world, content, paused ? 1 : accumulator / STEP_MS, ticker.deltaMS, ghost);
  updateHud();
});

// --- pointer ---------------------------------------------------------------

const canvas = renderer.app.canvas;
let drag: { x: number; y: number; moved: boolean; minimap: boolean } | null = null;

canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 2) return select(null);
  if (event.button !== 0 && event.button !== 1) return;
  const onMinimap = renderer.minimapHit(event.clientX, event.clientY);
  if (onMinimap) {
    renderer.camera.centerOn(onMinimap.x, onMinimap.y);
    drag = { x: event.clientX, y: event.clientY, moved: true, minimap: true };
  } else {
    drag = { x: event.clientX, y: event.clientY, moved: event.button === 1, minimap: false };
  }
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  const rect = canvas.getBoundingClientRect();
  renderer.camera.setEdgeFromPointer(drag ? null : event.clientX - rect.left, drag ? null : event.clientY - rect.top);

  if (drag) {
    if (drag.minimap) {
      const point = renderer.minimapHit(event.clientX, event.clientY);
      if (point) renderer.camera.centerOn(point.x, point.y);
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) drag.moved = true;
    if (drag.moved) {
      renderer.camera.panByScreen(dx, dy);
      drag.x = event.clientX;
      drag.y = event.clientY;
      return;
    }
  }
  ghost = selected && !renderer.minimapHit(event.clientX, event.clientY) ? ghostAt(event.clientX, event.clientY) : null;
});

canvas.addEventListener("pointerup", (event) => {
  const wasClick = drag && !drag.moved && event.button === 0;
  drag = null;
  if (!wasClick || !selected) return;
  const target = ghostAt(event.clientX, event.clientY);
  if (!target?.valid) return;
  queueCommand(world, {
    type: "build",
    tick: world.tick + INPUT_DELAY_TICKS,
    team: HUMAN,
    building: selected,
    col: target.col,
    row: target.row,
  });
  if (!event.shiftKey) select(null);
});

canvas.addEventListener("pointerleave", () => renderer.camera.setEdgeFromPointer(null, null));
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    renderer.camera.zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - rect.left, event.clientY - rect.top);
  },
  { passive: false },
);

// --- keyboard --------------------------------------------------------------

const PAN_KEYS: Record<string, [number, number]> = {
  w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0],
  arrowup: [0, -1], arrowleft: [-1, 0], arrowdown: [0, 1], arrowright: [1, 0],
};
const held = new Set<string>();

function updatePanKeys(): void {
  let x = 0;
  let y = 0;
  for (const key of held) {
    const pan = PAN_KEYS[key];
    if (pan) {
      x += pan[0];
      y += pan[1];
    }
  }
  renderer.camera.keys.x = Math.sign(x);
  renderer.camera.keys.y = Math.sign(y);
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (PAN_KEYS[key]) {
    held.add(key);
    updatePanKeys();
    event.preventDefault();
    return;
  }
  if (key === "escape") return select(null);
  if (key === "p") {
    paused = !paused;
    return;
  }
  if (key === " " || key === "h") {
    event.preventDefault();
    const core = world.entities.find((entity) => entity.id === world.teams[HUMAN].coreId);
    if (core) renderer.camera.centerOn(core.x, core.y);
    return;
  }
  if (key === "r" && world.outcome) return restart();
  const roster = content.races[world.teams[HUMAN].raceId]!.buildings;
  const index = Number(key) - 1;
  if (index >= 0 && index < roster.length) select(roster[index]!);
});

window.addEventListener("keyup", (event) => {
  held.delete(event.key.toLowerCase());
  updatePanKeys();
});
window.addEventListener("blur", () => {
  held.clear();
  updatePanKeys();
});

// --- building --------------------------------------------------------------

function ghostAt(clientX: number, clientY: number): Ghost | null {
  if (!selected) return null;
  const def = content.buildings[selected]!;
  const point = renderer.toWorld(clientX, clientY);
  const col = Math.floor(point.x / TILE);
  const row = Math.floor(point.y / TILE);
  const valid = canPlace(world, content, HUMAN, selected, col, row) === null;
  return { col, row, footprint: def.footprint, valid };
}

function select(buildingId: string | null): void {
  selected = buildingId;
  ghost = null;
  for (const button of hud.buildBar.querySelectorAll<HTMLButtonElement>(".build-btn")) {
    button.classList.toggle("selected", button.dataset.building === buildingId);
  }
}

function restart(): void {
  world = newMatch();
  renderer.setWorld(world);
  accumulator = 0;
  hud.status.textContent = "";
  hud.status.className = "";
  renderer.showBanner("");
}

// --- HUD -------------------------------------------------------------------

function buildBar(): void {
  const race = content.races[world.teams[HUMAN].raceId]!;
  hud.buildBar.innerHTML = "";
  const label = document.createElement("div");
  label.className = "stat";
  label.innerHTML = `<span class="label">${race.name}</span><span>${race.specialty}</span>`;
  hud.buildBar.append(label);

  race.buildings.forEach((id, index) => {
    const def = content.buildings[id]!;
    const button = document.createElement("button");
    button.className = "build-btn";
    button.dataset.building = id;
    button.title = def.description;
    button.innerHTML = `${index + 1}. ${def.name}<small>${buildCost(content, world.teams[HUMAN].raceId, id)} compute</small>`;
    button.addEventListener("click", () => select(selected === id ? null : id));
    hud.buildBar.append(button);
  });

  const help = document.createElement("div");
  help.className = "stat help";
  help.innerHTML =
    '<span class="label">Controls</span><span>WASD / edge / drag: pan · wheel: zoom · Space: home · P: pause</span>';
  hud.buildBar.append(help);
}

function updateHud(): void {
  const team = world.teams[HUMAN];
  const core = world.entities.find((entity) => entity.id === team.coreId);
  hud.compute.textContent = String(team.compute);
  hud.core.textContent = core ? `${Math.max(0, Math.ceil(core.hp))} / ${core.maxHp}` : "offline";
  hud.wave.textContent = `${world.waves.nextIndex} / ${content.waves.waves.length}`;
  const remaining = world.waves.nextWaveTick - world.tick;
  hud.nextWave.textContent =
    world.waves.nextIndex >= content.waves.waves.length ? "final" : `${Math.max(0, Math.ceil(remaining / TICK_RATE))}s`;
  if (paused && !world.outcome) hud.status.textContent = "PAUSED (P)";
  else if (!world.outcome) hud.status.textContent = "";

  for (const button of hud.buildBar.querySelectorAll<HTMLButtonElement>(".build-btn")) {
    button.disabled = team.compute < buildCost(content, team.raceId, button.dataset.building!);
  }
}

function announceOutcome(): void {
  const outcome = world.outcome!;
  const won = outcome.winner === HUMAN;
  const reason = outcome.reason === "survived" ? "All waves cleared." : won ? "Nest destroyed." : "Your core went down.";
  hud.status.textContent = `${won ? "UPTIME HELD" : "OUTAGE"} - ${reason} Press R for a new web. [${hashWorld(world)}]`;
  hud.status.className = won ? "won" : "lost";
  renderer.showBanner(won ? "UPTIME HELD" : "OUTAGE");
}
