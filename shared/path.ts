// A* path finding on the tile grid (8 directions, no corner cutting).

import { type GameMap, MAP_W, MAP_H, isWalkable } from "./map.ts";

export interface Pt { x: number; y: number }

class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];
  get size() { return this.items.length; }
  push(item: number, p: number) {
    const a = this.items, pr = this.prio;
    a.push(item); pr.push(p);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pr[parent] <= pr[i]) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      [pr[parent], pr[i]] = [pr[i], pr[parent]];
      i = parent;
    }
  }
  pop(): number {
    const a = this.items, pr = this.prio;
    const top = a[0];
    const last = a.pop()!, lastP = pr.pop()!;
    if (a.length > 0) {
      a[0] = last; pr[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && pr[l] < pr[m]) m = l;
        if (r < a.length && pr[r] < pr[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [pr[m], pr[i]] = [pr[i], pr[m]];
        i = m;
      }
    }
    return top;
  }
}

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
] as const;

/**
 * Find a path from world position `from` to world position `to`.
 * Returns a list of waypoints (tile centers), excluding the start tile, ending at `to`.
 * Returns null when unreachable. If the target tile is blocked, the nearest walkable
 * neighbour is used.
 */
export function findPath(map: GameMap, from: Pt, to: Pt, maxNodes = 40000): Pt[] | null {
  const sx = Math.floor(from.x), sy = Math.floor(from.y);
  let tx = Math.floor(to.x), ty = Math.floor(to.y);
  let exactTarget = true;
  if (!isWalkable(map, tx, ty)) {
    exactTarget = false;
    let found = false;
    for (let r = 1; r <= 2 && !found; r++)
      for (let dy = -r; dy <= r && !found; dy++)
        for (let dx = -r; dx <= r && !found; dx++)
          if (isWalkable(map, tx + dx, ty + dy)) { tx += dx; ty += dy; found = true; }
    if (!found) return null;
  }
  if (sx === tx && sy === ty) return [exactTarget ? { x: to.x, y: to.y } : { x: tx + 0.5, y: ty + 0.5 }];

  const start = sy * MAP_W + sx, goal = ty * MAP_W + tx;
  const g = new Map<number, number>();
  const came = new Map<number, number>();
  const open = new MinHeap();
  const h = (i: number) => {
    const x = i % MAP_W, y = (i / MAP_W) | 0;
    const dx = Math.abs(x - tx), dy = Math.abs(y - ty);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  g.set(start, 0);
  open.push(start, h(start));
  let expanded = 0;
  while (open.size > 0) {
    const cur = open.pop();
    if (cur === goal) break;
    if (++expanded > maxNodes) return null;
    const cx = cur % MAP_W, cy = (cur / MAP_W) | 0;
    const cg = g.get(cur)!;
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      if (!isWalkable(map, nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!isWalkable(map, cx + dx, cy) || !isWalkable(map, cx, cy + dy))) continue;
      const ni = ny * MAP_W + nx;
      const ng = cg + cost;
      const old = g.get(ni);
      if (old !== undefined && old <= ng) continue;
      g.set(ni, ng);
      came.set(ni, cur);
      open.push(ni, ng + h(ni));
    }
  }
  if (!came.has(goal)) return null;
  const tiles: number[] = [];
  for (let c = goal; c !== start; c = came.get(c)!) tiles.push(c);
  tiles.reverse();
  const pts = tiles.map((i) => ({ x: (i % MAP_W) + 0.5, y: ((i / MAP_W) | 0) + 0.5 }));
  if (exactTarget) pts[pts.length - 1] = { x: to.x, y: to.y };
  return smoothPath(map, from, pts);
}

/** Remove intermediate waypoints when a straight line is clear. */
function smoothPath(map: GameMap, from: Pt, pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const out: Pt[] = [];
  let anchor = from;
  let i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !lineClear(map, anchor, pts[j])) j--;
    out.push(pts[j]);
    anchor = pts[j];
    i = j + 1;
  }
  return out;
}

/** Check a straight segment against blocked tiles (sampled, with a clearance margin). */
export function lineClear(map: GameMap, a: Pt, b: Pt, margin = 0.3): boolean {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.ceil(d / 0.2);
  for (let s = 0; s <= steps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    for (const [ox, oy] of [[-margin, -margin], [margin, -margin], [-margin, margin], [margin, margin]]) {
      if (!isWalkable(map, Math.floor(x + ox), Math.floor(y + oy))) return false;
    }
  }
  return true;
}
