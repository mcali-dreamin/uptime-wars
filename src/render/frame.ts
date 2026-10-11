// The contract between the renderer shell and a world view (2D or 3D).
//
// The shell owns everything shared (camera, fog, minimap, banner,
// interpolation, transient effects) and hands a view one Frame per animation
// frame. A view draws the world however it likes and maps screen points back
// to world points.

import type { Content, Point, SimEvent, World } from "../sim";
import type { Camera } from "./camera";
import type { Fog } from "./fog";

export const SHOT_TTL_MS = 120;
export const PING_MS = 600;

export interface Shot {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  team: 0 | 1;
  age: number;
}

export interface Ghost {
  col: number;
  row: number;
  footprint: number;
  valid: boolean;
  /** Attack range to preview, in pixels, if the building shoots. */
  range: number;
}

/** Everything a world view needs to draw one frame. Render-only. */
export interface Frame {
  world: World;
  content: Content;
  alpha: number;
  deltaMs: number;
  ghost: Ghost | null;
  selectedId: number | null;
  width: number;
  height: number;
  camera: Camera;
  fog: Fog;
  shots: readonly Readonly<Shot>[];
  pings: readonly Readonly<{ x: number; y: number; age: number }>[];
  /** Interpolated position of an entity this frame. */
  position(entity: World["entities"][number]): Point;
  /** Whether the local player may see this entity right now. */
  shows(entity: World["entities"][number], x: number, y: number): boolean;
}

/**
 * A way of drawing the world: the Three.js view (default) or the 2D one
 * (`?2d`). The Pixi shell keeps the minimap, banner, and fog bookkeeping.
 */
export interface WorldView {
  setWorld(world: World): void;
  draw(frame: Frame): void;
  /** Sim events as they happen (deaths, for effects). Optional. */
  event?(event: SimEvent): void;
  /** Canvas-local pixels to a ground point, or null if nothing is there. */
  pick(x: number, y: number): Point | null;
  /** The entity drawn under canvas-local pixels, if the view can tell (tall 3D models). */
  entityAt?(x: number, y: number): number | null;
  /** A world ground point to canvas-local pixels. */
  project(x: number, y: number): Point;
  /** The world rectangle the view covers, for the minimap. */
  viewRect(): { left: number; right: number; top: number; bottom: number } | null;
}
