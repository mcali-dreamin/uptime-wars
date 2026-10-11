// Raw input. Camera controls (drag, wheel, edge scroll, pan keys, minimap)
// are handled here directly; anything that means something in the game is
// handed to the game as a world point or a key.

import type { Point } from "./sim";
import type { Renderer } from "./render/renderer";

export interface GameInput {
  /** True while something (the race picker) owns input. */
  blocked(): boolean;
  /** `entity`: the entity drawn under the pointer, when the view knows (3D). */
  click(point: Point, shift: boolean, entity: number | null): void;
  rightClick(point: Point, onMinimap: boolean): void;
  /** Pointer moved over the map (null when it left or is over the minimap). */
  hover(point: Point | null): void;
  /** Game keys. Return true when handled. */
  key(key: string, event: KeyboardEvent): boolean;
}

const DRAG_THRESHOLD_PX = 5;
const ZOOM_STEP = 1.15;
const PAN_KEYS: Record<string, [number, number]> = {
  w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0],
  arrowup: [0, -1], arrowleft: [-1, 0], arrowdown: [0, 1], arrowright: [1, 0],
};
const EDGE_KEY = "uptime:edge-scroll";
/** A Ctrl-click we already handled may be followed by the browser's own contextmenu. */
const MENU_SUPPRESS_MS = 400;

export function bindInput(renderer: Renderer, game: GameInput): void {
  const canvas = renderer.app.canvas;
  const camera = renderer.camera;
  camera.edgeScrollEnabled = localStorage.getItem(EDGE_KEY) !== "off";
  let drag: { x: number; y: number; moved: boolean; minimap: boolean } | null = null;
  let suppressMenuUntil = 0;

  // Right-click means "whatever the platform calls a secondary click": a right
  // button, a two-finger tap or click on a trackpad, Ctrl-click on a Mac, a
  // long press. Browsers report all of those as a contextmenu event (laptop
  // trackpads often never send button 2 at all), so that's what we listen to.
  const secondary = (event: MouseEvent) => {
    if (game.blocked()) return;
    const onMinimap = renderer.minimapHit(event.clientX, event.clientY);
    game.rightClick(onMinimap ?? renderer.toWorld(event.clientX, event.clientY), onMinimap !== null);
  };

  const local = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (game.blocked()) return;
    // The right button arrives as a contextmenu event below.
    if (event.button === 2) return;
    // Ctrl-click is a secondary click everywhere. macOS also fires contextmenu
    // for it; other platforms don't, so handle it here and skip that one.
    if (event.button === 0 && event.ctrlKey) {
      suppressMenuUntil = performance.now() + MENU_SUPPRESS_MS;
      secondary(event);
      return;
    }
    if (event.button !== 0 && event.button !== 1) return;
    const onMinimap = renderer.minimapHit(event.clientX, event.clientY);
    if (onMinimap) camera.centerOn(onMinimap.x, onMinimap.y);
    drag = { x: event.clientX, y: event.clientY, moved: onMinimap !== null || event.button === 1, minimap: onMinimap !== null };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (drag?.minimap) {
      const point = renderer.minimapHit(event.clientX, event.clientY);
      if (point) camera.centerOn(point.x, point.y);
      return;
    }
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) drag.moved = true;
      if (drag.moved) {
        camera.panByScreen(dx, dy);
        drag.x = event.clientX;
        drag.y = event.clientY;
        return;
      }
    }
    const overMinimap = renderer.minimapHit(event.clientX, event.clientY) !== null;
    game.hover(overMinimap ? null : renderer.toWorld(event.clientX, event.clientY));
  });

  canvas.addEventListener("pointerup", (event) => {
    const click = drag && !drag.moved && event.button === 0;
    drag = null;
    if (click && !game.blocked()) {
      game.click(renderer.toWorld(event.clientX, event.clientY), event.shiftKey, renderer.entityUnder(event.clientX, event.clientY));
    }
  });

  canvas.addEventListener("pointerleave", () => game.hover(null));
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (performance.now() < suppressMenuUntil) return;
    secondary(event);
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const at = local(event);
      // Smooth for trackpads, a fixed step for wheels.
      camera.zoomAt(Math.exp(-event.deltaY * 0.0015), at.x, at.y);
    },
    { passive: false },
  );

  // Edge scroll tracks the pointer over the whole window, like WC3: only the
  // outermost few pixels count, so reaching for a toolbar button never pans.
  window.addEventListener("pointermove", (event) => {
    if (drag || game.blocked()) return camera.setEdgeFromWindowPointer(null, null);
    camera.setEdgeFromWindowPointer(event.clientX, event.clientY, window.innerWidth, window.innerHeight);
  });
  document.documentElement.addEventListener("pointerleave", () => camera.setEdgeFromWindowPointer(null, null));

  const held = new Set<string>();
  const updatePan = () => {
    let x = 0;
    let y = 0;
    for (const key of held) {
      const pan = PAN_KEYS[key];
      if (pan) {
        x += pan[0];
        y += pan[1];
      }
    }
    camera.keys.x = Math.sign(x);
    camera.keys.y = Math.sign(y);
  };
  const zoomCenter = (factor: number) => {
    const { width, height } = renderer.app.screen;
    camera.zoomAt(factor, width / 2, height / 2);
  };

  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (game.blocked()) {
      game.key(key, event);
      return;
    }
    if (PAN_KEYS[key]) {
      held.add(key);
      updatePan();
      event.preventDefault();
      return;
    }
    if (key === "=" || key === "+") return zoomCenter(ZOOM_STEP);
    if (key === "-" || key === "_") return zoomCenter(1 / ZOOM_STEP);
    if (key === "e") {
      camera.edgeScrollEnabled = !camera.edgeScrollEnabled;
      localStorage.setItem(EDGE_KEY, camera.edgeScrollEnabled ? "on" : "off");
      renderer.showBanner(`Edge scroll ${camera.edgeScrollEnabled ? "on" : "off"} (E)`);
      return;
    }
    if (game.key(key, event)) event.preventDefault();
  });
  window.addEventListener("keyup", (event) => {
    held.delete(event.key.toLowerCase());
    updatePan();
  });
  window.addEventListener("blur", () => {
    held.clear();
    updatePan();
  });
}
