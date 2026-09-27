// A 2D camera over a map bigger than the screen. Render-side only: the
// simulation never knows where anyone is looking.

const EDGE_PX = 14;
const PAN_SPEED = 900; // screen pixels per second
const MAX_ZOOM = 2;
/** Never zoom out past this: the map should always be bigger than the screen. */
const MIN_ZOOM = 0.45;

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
    const dx = this.keys.x || this.edge.x;
    const dy = this.keys.y || this.edge.y;
    if (dx === 0 && dy === 0) return;
    const distance = (PAN_SPEED * deltaMs) / 1000 / this.zoom;
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

  /** Edge-scroll from a pointer position; call with null when the pointer leaves. */
  setEdgeFromPointer(sx: number | null, sy: number | null): void {
    if (sx === null || sy === null) {
      this.edge = { x: 0, y: 0 };
      return;
    }
    this.edge = {
      x: sx < EDGE_PX ? -1 : sx > this.viewWidth - EDGE_PX ? 1 : 0,
      y: sy < EDGE_PX ? -1 : sy > this.viewHeight - EDGE_PX ? 1 : 0,
    };
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
