// A 2D camera over a map bigger than the screen. Render-side only: the
// simulation never knows where anyone is looking.

const PAN_SPEED = 900; // screen pixels per second
/** Edge scroll only in a thin band at the very edge of the browser window. */
const EDGE_PX = 6;
/** Hold at the edge this long before scrolling starts... */
const EDGE_DELAY_MS = 250;
/** ...then ramp from a crawl to full speed over this long. */
const EDGE_RAMP_MS = 600;
const EDGE_MIN_SPEED = 0.25;
const MAX_ZOOM = 2;
/** Far enough out to see a big chunk of the web; the minimap covers the rest. */
const MIN_ZOOM = 0.15;

export class Camera {
  /** World point at the center of the screen. */
  x = 0;
  y = 0;
  zoom = 1;
  private mapWidth = 1;
  private mapHeight = 1;
  private viewWidth = 1;
  private viewHeight = 1;
  /** Held pan keys and edge-scroll direction, each -1..1. */
  readonly keys = { x: 0, y: 0 };
  edge = { x: 0, y: 0 };
  edgeScrollEnabled = true;
  /** How long the pointer has been resting in the current edge direction. */
  private edgeHeldMs = 0;

  setBounds(width: number, height: number): void {
    this.mapWidth = width;
    this.mapHeight = height;
    this.clamp();
  }

  setViewport(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    this.zoom = Math.max(this.zoom, this.minZoom());
    this.clamp();
  }

  /** Zoomed all the way out you still see only a slice of the map. */
  minZoom(): number {
    return Math.max(MIN_ZOOM, this.viewWidth / this.mapWidth, this.viewHeight / this.mapHeight);
  }

  update(deltaMs: number): void {
    const keyed = this.keys.x !== 0 || this.keys.y !== 0;
    const edging = !keyed && this.edgeScrollEnabled && (this.edge.x !== 0 || this.edge.y !== 0);
    this.edgeHeldMs = edging ? this.edgeHeldMs + deltaMs : 0;
    let speed = 1;
    if (edging) {
      if (this.edgeHeldMs < EDGE_DELAY_MS) return;
      const ramp = Math.min(1, (this.edgeHeldMs - EDGE_DELAY_MS) / EDGE_RAMP_MS);
      speed = EDGE_MIN_SPEED + (1 - EDGE_MIN_SPEED) * ramp;
    }
    const dx = keyed ? this.keys.x : edging ? this.edge.x : 0;
    const dy = keyed ? this.keys.y : edging ? this.edge.y : 0;
    if (dx === 0 && dy === 0) return;
    const distance = (PAN_SPEED * speed * deltaMs) / 1000 / this.zoom;
    this.x += dx * distance;
    this.y += dy * distance;
    this.clamp();
  }

  centerOn(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.clamp();
  }

  panByScreen(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  /** Zoom by `factor`, keeping the world point under (sx, sy) fixed. */
  zoomAt(factor: number, sx: number, sy: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(this.minZoom(), this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  /**
   * Edge-scroll from the pointer's position in the *browser window*, not the
   * canvas: the canvas's bottom edge sits right above the build bar, and
   * reaching for a button must never pan the map. Call with null to stop.
   */
  setEdgeFromWindowPointer(clientX: number | null, clientY: number | null, windowWidth = 0, windowHeight = 0): void {
    const next =
      clientX === null || clientY === null
        ? { x: 0, y: 0 }
        : {
            x: clientX < EDGE_PX ? -1 : clientX > windowWidth - EDGE_PX ? 1 : 0,
            y: clientY < EDGE_PX ? -1 : clientY > windowHeight - EDGE_PX ? 1 : 0,
          };
    if (next.x !== this.edge.x || next.y !== this.edge.y) this.edgeHeldMs = 0;
    this.edge = next;
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: this.x + (sx - this.viewWidth / 2) / this.zoom,
      y: this.y + (sy - this.viewHeight / 2) / this.zoom,
    };
  }

  /** Visible world rectangle, padded by `margin` world pixels. */
  view(margin: number) {
    const halfW = this.viewWidth / 2 / this.zoom;
    const halfH = this.viewHeight / 2 / this.zoom;
    return {
      left: this.x - halfW - margin,
      right: this.x + halfW + margin,
      top: this.y - halfH - margin,
      bottom: this.y + halfH + margin,
    };
  }

  private clamp(): void {
    const halfW = this.viewWidth / 2 / this.zoom;
    const halfH = this.viewHeight / 2 / this.zoom;
    this.x = halfW * 2 >= this.mapWidth ? this.mapWidth / 2 : Math.min(this.mapWidth - halfW, Math.max(halfW, this.x));
    this.y = halfH * 2 >= this.mapHeight ? this.mapHeight / 2 : Math.min(this.mapHeight - halfH, Math.max(halfH, this.y));
  }
}
