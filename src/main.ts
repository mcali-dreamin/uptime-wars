import { buildingCard, terrainCard, unitCard, type InfoCard } from "./info";
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
  tileAt,
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
  uptime: $("uptime"),
  compute: $("compute"),
  core: $("core"),
  wave: $("wave"),
  nextWave: $("next-wave"),
  status: $("status"),
  buildBar: $("build-bar"),
  info: $("info"),
  infoTitle: $("info-title"),
  infoSubtitle: $("info-subtitle"),
  infoLines: $("info-lines"),
};

// --- info panel ------------------------------------------------------------

let hoverButton: string | null = null;
let hoverCard: InfoCard | null = null;

function showCard(card: InfoCard | null): void {
  if (!card) {
    hud.info.hidden = true;
    return;
  }
  hud.info.hidden = false;
  hud.infoTitle.textContent = card.title;
  hud.infoSubtitle.textContent = card.subtitle;
  hud.infoLines.replaceChildren(
    ...card.lines.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }),
  );
}

/** Priority: hovered build button, then the building being placed, then what's under the cursor. */
function refreshCard(): void {
  const raceId = world.teams[HUMAN].raceId;
  const building = hoverButton ?? selected;
  showCard(building ? buildingCard(content, raceId, building) : hoverCard);
}

/** What's under the pointer on the map: an entity, else interesting terrain. */
function cardAt(clientX: number, clientY: number): InfoCard | null {
  const point = renderer.toWorld(clientX, clientY);
  for (const entity of world.entities) {
    if (entity.kind === "building") {
      const half = (entity.footprint * TILE) / 2;
      if (Math.abs(point.x - entity.x) <= half && Math.abs(point.y - entity.y) <= half) {
        const card = buildingCard(content, world.teams[entity.team].raceId, entity.defId);
        const owner = world.teams[entity.team].controller === "human" ? "Yours" : "Hostile";
        const status = entity.buildRemaining > 0 ? `building, ${Math.ceil(entity.buildRemaining / TICK_RATE)}s left` : "online";
        return { ...card, subtitle: `${owner} · ${status} · ${Math.ceil(entity.hp)} / ${entity.maxHp} HP. ${card.subtitle}` };
      }
    } else {
      const dx = point.x - entity.x;
      const dy = point.y - entity.y;
      if (dx * dx + dy * dy <= (entity.radius + 4) ** 2) {
        const card = unitCard(content, entity.defId, entity.hp);
        const owner = entity.mode === "guard" ? "Yours, guarding" : "Creep, wandering";
        return { ...card, subtitle: `${owner}. ${card.subtitle}` };
      }
    }
  }
  return terrainCard(tileAt(world.terrain, Math.floor(point.x / TILE), Math.floor(point.y / TILE)));
}

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
renderer.camera.edgeScrollEnabled = localStorage.getItem("uptime:edge-scroll") !== "off";
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
  const overMinimap = renderer.minimapHit(event.clientX, event.clientY) !== null;
  ghost = selected && !overMinimap ? ghostAt(event.clientX, event.clientY) : null;
  hoverCard = overMinimap ? null : cardAt(event.clientX, event.clientY);
  refreshCard();
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

// Edge scroll tracks the pointer over the whole window, like WC3: only the
// outermost few pixels of the screen count, even over the HUD, so moving
// onto a toolbar button never pans. Paused while dragging.
window.addEventListener("pointermove", (event) => {
  if (drag) return renderer.camera.setEdgeFromWindowPointer(null, null);
  renderer.camera.setEdgeFromWindowPointer(event.clientX, event.clientY, window.innerWidth, window.innerHeight);
});
document.documentElement.addEventListener("pointerleave", () => renderer.camera.setEdgeFromWindowPointer(null, null));

canvas.addEventListener("pointerleave", () => {
  hoverCard = null;
  refreshCard();
});
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
  if (key === "e") {
    renderer.camera.edgeScrollEnabled = !renderer.camera.edgeScrollEnabled;
    localStorage.setItem("uptime:edge-scroll", renderer.camera.edgeScrollEnabled ? "on" : "off");
    renderer.showBanner(`Edge scroll ${renderer.camera.edgeScrollEnabled ? "on" : "off"} (E)`);
    return;
  }
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
  return { col, row, footprint: def.footprint, valid, range: def.attack?.range ?? 0 };
}

function select(buildingId: string | null): void {
  selected = buildingId;
  ghost = null;
  refreshCard();
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
    button.innerHTML = `${index + 1}. ${def.name}<small>${buildCost(content, world.teams[HUMAN].raceId, id)} compute</small>`;
    button.addEventListener("click", () => select(selected === id ? null : id));
    button.addEventListener("pointerenter", () => {
      hoverButton = id;
      refreshCard();
    });
    button.addEventListener("pointerleave", () => {
      hoverButton = null;
      refreshCard();
    });
    hud.buildBar.append(button);
  });

  const help = document.createElement("div");
  help.className = "stat help";
  help.innerHTML =
    '<span class="label">Controls</span><span>WASD / drag / window edge: pan · E: edge scroll on/off · wheel: zoom · Space: home · P: pause</span>';
  hud.buildBar.append(help);
}

function updateHud(): void {
  const team = world.teams[HUMAN];
  const core = world.entities.find((entity) => entity.id === team.coreId);
  hud.compute.textContent = String(team.compute);
  hud.core.textContent = core ? `${Math.max(0, Math.ceil(core.hp))} / ${core.maxHp}` : "offline";
  hud.uptime.textContent = clock((world.outcome?.tick ?? world.tick) / TICK_RATE);
  hud.wave.textContent = String(world.waves.nextIndex);
  hud.nextWave.textContent = `${Math.max(0, Math.ceil((world.waves.nextWaveTick - world.tick) / TICK_RATE))}s`;
  if (paused && !world.outcome) hud.status.textContent = "PAUSED (P)";
  else if (!world.outcome) hud.status.textContent = "";

  for (const button of hud.buildBar.querySelectorAll<HTMLButtonElement>(".build-btn")) {
    button.disabled = team.compute < buildCost(content, team.raceId, button.dataset.building!);
  }
}

function clock(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function announceOutcome(): void {
  const outcome = world.outcome!;
  const won = outcome.winner === HUMAN;
  const uptime = clock(outcome.tick / TICK_RATE);
  const summary = won
    ? `NEST OFFLINE - you took down the botnet at ${uptime}.`
    : `OUTAGE - uptime ${uptime}, reached wave ${world.waves.nextIndex}.`;
  hud.status.textContent = `${summary} Press R for a new web. [${hashWorld(world)}]`;
  hud.status.className = won ? "won" : "lost";
  renderer.showBanner(won ? "NEST OFFLINE" : `OUTAGE · uptime ${uptime}`);
}
