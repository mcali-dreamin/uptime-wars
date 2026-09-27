import { buildingCard, terrainCard, unitCard, type InfoCard } from "./info";
import { Renderer, type Ghost } from "./render/renderer";
import {
  TICK_RATE,
  TILE,
  buildCost,
  canFound,
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
const HORDE_RACE = "botnet";

/** Selection value meaning "choose where the core goes". */
const FOUND = "__found";

const content = loadDefaultContent();
const renderer = new Renderer();
/** Races a person can play, in content order. */
const PLAYABLE = Object.entries(content.races).filter(([, race]) => race.controller === "human").map(([id]) => id);
let raceId = PLAYABLE.includes(localStorage.getItem("uptime:race") ?? "") ? localStorage.getItem("uptime:race")! : PLAYABLE[0]!;
/** True while the race picker is up: the match doesn't run and the map ignores input. */
let picking = true;
let world: World = newMatch();
/** A building id to place, FOUND, or nothing. */
let selected: string | null = null;
/** One of your buildings, selected by clicking it: right-click sets its rally point. */
let selectedBuildingId: number | null = null;
/** Which build bar is showing, so it can switch when the core comes online. */
let barPhase: "deploy" | "build" = "deploy";
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
  if (building === FOUND) {
    const card = buildingCard(content, raceId, content.races[raceId]!.core);
    showCard({
      ...card,
      subtitle: "Choose where your core goes. Your deploy agent walks there and becomes it. Waves start soon after.",
    });
    return;
  }
  if (building) return showCard(buildingCard(content, raceId, building));
  showCard(hoverCard ?? selectedCard());
}

function selectedBuilding() {
  if (selectedBuildingId === null) return undefined;
  const entity = world.entities.find((e) => e.id === selectedBuildingId);
  return entity?.kind === "building" && entity.hp > 0 ? entity : undefined;
}

/** Does right-clicking with this building selected set a rally point? */
function rallies(building: NonNullable<ReturnType<typeof selectedBuilding>>): boolean {
  return building.id === world.teams[HUMAN].coreId || content.buildings[building.defId]!.spawn !== undefined;
}

function selectedCard(): InfoCard | null {
  const building = selectedBuilding();
  if (!building) return null;
  const card = buildingCard(content, world.teams[HUMAN].raceId, building.defId);
  const isCore = building.id === world.teams[HUMAN].coreId;
  const hint = isCore
    ? "Selected · right-click: set the global rally point for every spawner without its own"
    : rallies(building)
      ? "Selected · right-click: set where this building's units gather (overrides the global rally)"
      : "Selected";
  return { ...card, lines: [...card.lines, hint] };
}

function builder() {
  const id = world.teams[HUMAN].builderId;
  return id === -1 ? undefined : world.entities.find((entity) => entity.id === id);
}

/** What's under the pointer on the map: an entity, else interesting terrain. */
function cardAt(clientX: number, clientY: number): InfoCard | null {
  const point = renderer.toWorld(clientX, clientY);
  if (!renderer.fog.isExplored(point.x, point.y)) {
    return { title: "Unexplored", subtitle: "Nobody has been out here yet.", lines: ["Send your deploy agent, or build closer, to see what's out there."] };
  }
  for (const entity of world.entities) {
    const hostile = world.teams[entity.team].controller !== "human";
    if (hostile && (entity.kind === "unit" ? !renderer.fog.isVisible(entity.x, entity.y) : false)) continue;
    if (entity.kind === "building") {
      const half = (entity.footprint * TILE) / 2;
      if (Math.abs(point.x - entity.x) <= half && Math.abs(point.y - entity.y) <= half) {
        if (entity.id === selectedBuildingId) return selectedCard();
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
        const owner = entity.mode === "builder" ? "Yours, deploy agent" : entity.mode === "guard" ? "Yours, guarding" : "Creep, wandering";
        return { ...card, subtitle: `${owner}. ${card.subtitle}` };
      }
    }
  }
  return terrainCard(tileAt(world.terrain, Math.floor(point.x / TILE), Math.floor(point.y / TILE)));
}

function newMatch(): World {
  const seed = (Math.random() * 2 ** 31) | 0;
  return createWorld(content, { seed, races: [raceId, HORDE_RACE] });
}

// --- race picker -----------------------------------------------------------

const picker = $("race-picker");

function showPicker(): void {
  picking = true;
  const cards = $("race-cards");
  cards.replaceChildren(
    ...PLAYABLE.map((id, index) => {
      const race = content.races[id]!;
      const card = document.createElement("button");
      card.className = `race-card${id === raceId ? " last" : ""}`;
      const roster = race.buildings.map((b) => `<li>${content.buildings[b]!.name}: ${content.buildings[b]!.description}</li>`).join("");
      card.innerHTML = `<strong>${index + 1}. ${race.name}</strong><em>${race.specialty}</em><ul>${roster}</ul>`;
      card.addEventListener("click", () => pickRace(id));
      return card;
    }),
  );
  picker.hidden = false;
}

function pickRace(id: string): void {
  raceId = id;
  localStorage.setItem("uptime:race", id);
  picker.hidden = true;
  picking = false;
  restart();
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

showPicker();

renderer.app.ticker.add((ticker) => {
  if (!paused && !picking && !world.outcome) {
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
  if (selectedBuildingId !== null && !selectedBuilding()) {
    selectedBuildingId = null;
    refreshCard();
  }
  renderer.draw(world, content, paused ? 1 : accumulator / STEP_MS, ticker.deltaMS, ghost, selectedBuildingId);
  updateHud();
});

// --- pointer ---------------------------------------------------------------

const canvas = renderer.app.canvas;
let drag: { x: number; y: number; moved: boolean; minimap: boolean } | null = null;

canvas.addEventListener("pointerdown", (event) => {
  if (picking) return;
  if (event.button === 2) {
    // Right-click cancels a placement, sets a rally point for a selected
    // building, and otherwise moves the deploy agent.
    if (selected) return select(null);
    const rallyFrom = selectedBuilding();
    const onMinimap = renderer.minimapHit(event.clientX, event.clientY);
    if (rallyFrom && rallies(rallyFrom)) {
      const point = onMinimap ?? renderer.toWorld(event.clientX, event.clientY);
      queueCommand(world, { type: "rally", tick: world.tick + INPUT_DELAY_TICKS, team: HUMAN, buildingId: rallyFrom.id, x: point.x, y: point.y });
      return;
    }
    if (builder() && !onMinimap) {
      const point = renderer.toWorld(event.clientX, event.clientY);
      queueCommand(world, { type: "move", tick: world.tick + INPUT_DELAY_TICKS, team: HUMAN, x: point.x, y: point.y });
    }
    return;
  }
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
  const wasClick = drag && !drag.moved && !drag.minimap && event.button === 0;
  drag = null;
  if (!wasClick) return;
  if (!selected) {
    selectBuildingAt(event.clientX, event.clientY);
    return;
  }
  const target = ghostAt(event.clientX, event.clientY);
  if (!target?.valid) return;
  if (selected === FOUND) {
    queueCommand(world, { type: "found", tick: world.tick + INPUT_DELAY_TICKS, team: HUMAN, col: target.col, row: target.row });
    select(null);
    return;
  }
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
  if (picking) {
    const id = PLAYABLE[Number(key) - 1];
    if (id) pickRace(id);
    return;
  }
  if (PAN_KEYS[key]) {
    held.add(key);
    updatePanKeys();
    event.preventDefault();
    return;
  }
  if (key === "escape") {
    selectedBuildingId = null;
    return select(null);
  }
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
    const home = renderer.home(world);
    if (home) renderer.camera.centerOn(home.x, home.y);
    return;
  }
  if (key === "r" && world.outcome) return showPicker();
  if (barPhase === "deploy") {
    if (key === "c" && builder()) select(FOUND);
    return;
  }
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
  const point = renderer.toWorld(clientX, clientY);
  if (selected === FOUND) {
    const def = content.buildings[content.races[world.teams[HUMAN].raceId]!.core]!;
    // Center the 2x2 footprint on the pointer.
    const col = Math.round(point.x / TILE) - 1;
    const row = Math.round(point.y / TILE) - 1;
    const valid = canFound(world, content, HUMAN, col, row) === null && renderer.fog.isExplored(point.x, point.y);
    return { col, row, footprint: def.footprint, valid, range: def.attack?.range ?? 0 };
  }
  const def = content.buildings[selected]!;
  const col = Math.floor(point.x / TILE);
  const row = Math.floor(point.y / TILE);
  const valid = canPlace(world, content, HUMAN, selected, col, row) === null;
  return { col, row, footprint: def.footprint, valid, range: def.attack?.range ?? 0 };
}

/** Select your own building under the pointer, or clear the selection. */
function selectBuildingAt(clientX: number, clientY: number): void {
  const point = renderer.toWorld(clientX, clientY);
  const hit = world.entities.find(
    (e) =>
      e.kind === "building" &&
      e.team === HUMAN &&
      Math.abs(point.x - e.x) <= (e.footprint * TILE) / 2 &&
      Math.abs(point.y - e.y) <= (e.footprint * TILE) / 2,
  );
  selectedBuildingId = hit?.id ?? null;
  hoverCard = cardAt(clientX, clientY);
  refreshCard();
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
  selectedBuildingId = null;
  select(null);
  buildBar();
  renderer.setWorld(world);
  accumulator = 0;
  hud.status.textContent = "";
  hud.status.className = "";
  renderer.showBanner("");
}

// --- HUD -------------------------------------------------------------------

function buildBar(): void {
  const race = content.races[world.teams[HUMAN].raceId]!;
  barPhase = world.teams[HUMAN].coreId === -1 ? "deploy" : "build";
  hud.buildBar.innerHTML = "";
  const label = document.createElement("div");
  label.className = "stat";
  label.innerHTML = `<span class="label">${race.name}</span><span>${race.specialty}</span>`;
  hud.buildBar.append(label);

  if (barPhase === "deploy") {
    const button = document.createElement("button");
    button.className = "build-btn";
    button.dataset.building = FOUND;
    button.innerHTML = `C. Deploy core here<small>free · your agent walks there</small>`;
    button.addEventListener("click", () => select(selected === FOUND ? null : FOUND));
    button.addEventListener("pointerenter", () => {
      hoverButton = FOUND;
      refreshCard();
    });
    button.addEventListener("pointerleave", () => {
      hoverButton = null;
      refreshCard();
    });
    hud.buildBar.append(button);
    const help = document.createElement("div");
    help.className = "stat help";
    help.innerHTML =
      '<span class="label">Deploy</span><span>Right-click: move your agent and scout · C: choose where your core goes · Space: find your agent</span>';
    hud.buildBar.append(help);
    return;
  }

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
    '<span class="label">Controls</span><span>Click a building to select · right-click: rally point (core = global) · WASD / drag / window edge: pan · E: edge scroll · Space: home · P: pause</span>';
  hud.buildBar.append(help);
}

function updateHud(): void {
  const team = world.teams[HUMAN];
  if ((team.coreId === -1) !== (barPhase === "deploy")) {
    select(null);
    buildBar();
  }
  const core = world.entities.find((entity) => entity.id === team.coreId);
  hud.compute.textContent = String(team.compute);
  hud.core.textContent = core ? `${Math.max(0, Math.ceil(core.hp))} / ${core.maxHp}` : team.builderId !== -1 ? "not deployed" : "offline";
  hud.uptime.textContent = clock((world.outcome?.tick ?? world.tick) / TICK_RATE);
  hud.wave.textContent = String(world.waves.nextIndex);
  hud.nextWave.textContent = `${Math.max(0, Math.ceil((world.waves.nextWaveTick - world.tick) / TICK_RATE))}s`;
  if (paused && !world.outcome) hud.status.textContent = "PAUSED (P)";
  else if (!world.outcome) hud.status.textContent = "";

  for (const button of hud.buildBar.querySelectorAll<HTMLButtonElement>(".build-btn")) {
    const id = button.dataset.building!;
    button.disabled = id !== FOUND && team.compute < buildCost(content, team.raceId, id);
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
    : world.teams[HUMAN].coreId === -1
      ? `OUTAGE - your deploy agent was lost before the core came online.`
      : `OUTAGE - uptime ${uptime}, reached wave ${world.waves.nextIndex}.`;
  hud.status.textContent = `${summary} Press R to pick a race for a new web. [${hashWorld(world)}]`;
  hud.status.className = won ? "won" : "lost";
  renderer.showBanner(won ? "NEST OFFLINE" : `OUTAGE · uptime ${uptime}`);
}
