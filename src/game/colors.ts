// Player colours, WC3-style: pick one before the match. Red is the botnet's,
// so "red means enemy" always holds. Picked to read on the dark terrain and
// to stay apart from the yellow selection highlight.

export interface PlayerColor {
  id: string;
  name: string;
  hex: number;
}

export const PLAYER_COLORS: readonly PlayerColor[] = [
  { id: "green", name: "Green", hex: 0x4ade80 },
  { id: "blue", name: "Blue", hex: 0x60a5fa },
  { id: "cyan", name: "Cyan", hex: 0x22d3ee },
  { id: "purple", name: "Purple", hex: 0xa78bfa },
  { id: "pink", name: "Pink", hex: 0xf472b6 },
  { id: "orange", name: "Orange", hex: 0xfb923c },
  { id: "white", name: "White", hex: 0xe2e8f0 },
];

export function playerColor(id: string): PlayerColor {
  return PLAYER_COLORS.find((color) => color.id === id) ?? PLAYER_COLORS[0]!;
}
