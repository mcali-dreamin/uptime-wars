// Seeded PRNG (mulberry32). The state lives in the world so a match can be
// serialized, replayed, and verified. Never call Math.random() in the sim.

export function nextRandom(state: { rngState: number }): number {
  state.rngState = (state.rngState + 0x6d2b79f5) | 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Integer in [min, max]. */
export function randomInt(state: { rngState: number }, min: number, max: number): number {
  return min + Math.floor(nextRandom(state) * (max - min + 1));
}
