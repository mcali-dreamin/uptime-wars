import { Renderer, type Ghost } from "./render/renderer";
import {
  SIDES,
  TICK_RATE,
  TILE,
  createWorld,
  hashWorld,
  inZone,
  isOccupied,
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

await renderer.init($("stage"));
buildBar();

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

// --- input -----------------------------------------------------------------

const canvas = renderer.app.canvas;

canvas.addEventListener("pointermove", (event) => {
  ghost = selected ? ghostAt(event.clientX, event.clientY) : null;
});

canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 2) return select(null);
  if (!selected) return;
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

canvas.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") return select(null);
  if (event.key === " ") {
    paused = !paused;
    event.preventDefault();
    return;
  }
  if (event.key === "r" && world.outcome) return restart();
  const roster = content.races[world.teams[HUMAN].raceId]!.buildings;
  const index = Number(event.key) - 1;
  if (index >= 0 && index < roster.length) select(roster[index]!);
});

function ghostAt(clientX: number, clientY: number): Ghost | null {
  if (!selected) return null;
  const def = content.buildings[selected]!;
  const point = renderer.toWorld(clientX, clientY);
  const col = Math.floor(point.x / TILE);
  const row = Math.floor(point.y / TILE);
  const cost = Math.round(def.cost * content.races[world.teams[HUMAN].raceId]!.modifiers.costMultiplier);
  const valid =
    inZone(SIDES[HUMAN].buildZone, col, row, def.footprint) &&
    !isOccupied(world, col, row, def.footprint) &&
    world.teams[HUMAN].compute >= cost;
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
    button.innerHTML = `${index + 1}. ${def.name}<small>${Math.round(def.cost * race.modifiers.costMultiplier)} compute</small>`;
    button.addEventListener("click", () => select(selected === id ? null : id));
    hud.buildBar.append(button);
  });
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
  if (paused && !world.outcome) hud.status.textContent = "PAUSED (space)";
  else if (!world.outcome) hud.status.textContent = "";

  for (const button of hud.buildBar.querySelectorAll<HTMLButtonElement>(".build-btn")) {
    const def = content.buildings[button.dataset.building!]!;
    button.disabled = team.compute < def.cost;
  }
}

function announceOutcome(): void {
  const outcome = world.outcome!;
  const won = outcome.winner === HUMAN;
  const reason = outcome.reason === "survived" ? "All waves cleared." : won ? "Enemy core offline." : "Your core went down.";
  hud.status.textContent = `${won ? "UPTIME HELD" : "OUTAGE"} - ${reason} Press R to restart. [${hashWorld(world)}]`;
  hud.status.className = won ? "won" : "lost";
  renderer.showBanner(won ? "UPTIME HELD" : "OUTAGE");
}
