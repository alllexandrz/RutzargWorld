// Isometric projection helpers (2:1 diamonds).

export const TW = 64; // tile width in px
export const TH = 32; // tile height in px

/** World (tile units, continuous) → screen px. Tile (x,y) center = toScreen(x+0.5, y+0.5). */
export function toScreen(x: number, y: number): { x: number; y: number } {
  return { x: (x - y) * (TW / 2), y: (x + y) * (TH / 2) };
}

/** Screen px → world (tile units). */
export function toWorld(sx: number, sy: number): { x: number; y: number } {
  const a = sx / (TW / 2), b = sy / (TH / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Painter's-algorithm depth for a world position. */
export function depthOf(x: number, y: number, bias = 0): number {
  return (x + y) * 10 + bias;
}
