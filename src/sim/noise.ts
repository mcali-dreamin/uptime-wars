// Deterministic value noise. Integer hashing plus + - * / Math.floor only, so
// every browser generates the same terrain from the same seed.

function hash2(x: number, y: number, seed: number): number {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  const top = a + (b - a) * sx;
  const bottom = c + (d - c) * sx;
  return top + (bottom - top) * sy;
}

/** Fractal value noise in [0, 1). */
export function fbm(x: number, y: number, seed: number): number {
  return (
    0.6 * valueNoise(x / 11, y / 11, seed) +
    0.3 * valueNoise(x / 5, y / 5, seed + 1) +
    0.1 * valueNoise(x / 2.5, y / 2.5, seed + 2)
  );
}
