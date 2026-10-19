// Natural resources: every tree/rock/herb holds a finite amount. Exhausted trees leave stumps
// (re-forest by planting saplings), exhausted rocks disappear (then the town needs mines and
// quarries on deposits), herbs regrow. Every map change is broadcast to clients as a tile diff.

import type { World } from "./world.ts";
import type { Business } from "./types.ts";
import type { ItemId } from "../../shared/items.ts";
import { G, O, RESOURCE_AMOUNT, canPlant, idx, inBounds, setTile, MAP_W } from "../../shared/map.ts";

export const SAPLING_GROW_DAYS = 3;
export const HERB_REGROW_DAYS = 2;
const LUMBER_RADIUS = 14;

export interface ResourceState {
  /** Remaining units per tile index (missing = full default amount). */
  amounts: Record<number, number>;
  /** Tiles that differ from the code-generated map: index → [ground, obj]. */
  overrides: Record<number, [number, number]>;
  /** Planted saplings: index → game minute planted. */
  saplings: Record<number, number>;
  /** Things that will come back by themselves: index → { at, obj }. */
  regrow: Record<number, { at: number; obj: number }>;
  /** Underground deposits (mines/quarries): id → remaining units. */
  deposits: Record<string, number>;
  /** Things people have put down: tile index → item and who owns it ("town" for municipal). */
  placed: Record<number, { item: ItemId; by: string }>;
}

export function initialResources(w: World): ResourceState {
  const deposits: Record<string, number> = { karg_ore: 800, karg_stone: 1000 };
  for (const p of w.map.plots) if (p.amount) deposits[p.id] = p.amount;
  return { amounts: {}, overrides: {}, saplings: {}, regrow: {}, deposits, placed: {} };
}

/** Change a tile on the authoritative map, remember it for persistence and queue it for clients. */
export function changeTile(w: World, x: number, y: number, ground: number | null, obj: number) {
  if (!setTile(w.map, x, y, ground, obj)) return;
  const i = idx(x, y);
  w.res.overrides[i] = [w.map.ground[i], w.map.obj[i]];
  w.pendingTiles.push([x, y, w.map.ground[i], w.map.obj[i]]);
}

/** Re-apply saved tile changes onto a freshly generated map (after loading a save). */
export function applyOverrides(w: World) {
  for (const [k, [g, o]] of Object.entries(w.res.overrides)) {
    const i = Number(k);
    setTile(w.map, i % MAP_W, Math.floor(i / MAP_W), g, o);
  }
}

export function remaining(w: World, x: number, y: number): number {
  const i = idx(x, y);
  const o = w.map.obj[i];
  const full = RESOURCE_AMOUNT[o];
  if (full === undefined) return 0;
  return w.res.amounts[i] ?? full;
}

/** Take one unit from a resource tile. Returns false if there is nothing left. */
export function harvestTile(w: World, x: number, y: number): boolean {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  const o = w.map.obj[i];
  const left = remaining(w, x, y);
  if (left <= 0) return false;
  if (left > 1) { w.res.amounts[i] = left - 1; return true; }
  delete w.res.amounts[i];
  if (o === O.TREE) changeTile(w, x, y, null, O.STUMP);
  else if (o === O.ORE_ROCK || o === O.ROCK) changeTile(w, x, y, G.ROCKY, O.NONE);
  else if (o === O.HERB) {
    changeTile(w, x, y, null, O.NONE);
    w.res.regrow[i] = { at: w.time + HERB_REGROW_DAYS * 1440, obj: O.HERB };
  }
  return true;
}

export function plantSapling(w: World, x: number, y: number): boolean {
  if (!canPlant(w.map, x, y)) return false;
  changeTile(w, x, y, null, O.SAPLING);
  w.res.saplings[idx(x, y)] = w.time;
  return true;
}

/** Nearest tile with the given object within radius (Chebyshev scan, then Euclid). */
export function nearestObj(w: World, cx: number, cy: number, obj: number, r: number, filter?: (x: number, y: number) => boolean): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null, bd = Infinity;
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  for (let y = y0 - r; y <= y0 + r; y++)
    for (let x = x0 - r; x <= x0 + r; x++) {
      if (!inBounds(x, y) || w.map.obj[idx(x, y)] !== obj) continue;
      if (filter && !filter(x, y)) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r && d < bd) { bd = d; best = { x, y }; }
    }
  return best;
}

function bizCenter(w: World, b: Business): { x: number; y: number } {
  const a = w.map.areas[b.area];
  return a ? { x: a.x + a.w / 2, y: a.y + a.h / 2 } : { x: 50, y: 17 };
}

/**
 * Lumber camps fell real trees around them. If the forest nearby is cut down, workers
 * plant saplings on the stumps instead (the camp produces nothing until it regrows).
 * Returns the units of wood actually obtained.
 */
export function fellTrees(w: World, b: Business, units: number): number {
  const c = bizCenter(w, b);
  let got = 0;
  for (let k = 0; k < units; k++) {
    const t = nearestObj(w, c.x, c.y, O.TREE, LUMBER_RADIUS);
    if (!t || !harvestTile(w, t.x, t.y)) break;
    got++;
  }
  if (got < units) {
    let planted = 0;
    for (let k = 0; k < 2; k++) {
      const s = nearestObj(w, c.x, c.y, O.STUMP, LUMBER_RADIUS);
      if (s && plantSapling(w, s.x, s.y)) planted++;
    }
    const day = Math.floor(w.time / 1440);
    if ((b.lastShortageDay ?? -1) !== day) {
      b.lastShortageDay = day;
      w.log(`Біля «${b.name}» вирубано майже весь ліс. Лісоруби садять саджанці (${planted}) — деревини стане менше.`, "nature");
    }
  }
  return got;
}

/** Mines and quarries dig from a finite deposit. */
export function digDeposit(w: World, b: Business, units: number): number {
  const id = b.deposit;
  if (!id) return units;
  const left = w.res.deposits[id] ?? 0;
  const got = Math.min(left, units);
  w.res.deposits[id] = left - got;
  if (left > 0 && left - got <= 0) w.log(`Родовище «${b.name}» вичерпано! Потрібна нова шахта чи кар'єр.`, "nature");
  return got;
}

/** Hourly: saplings grow into trees, herbs regrow. */
export function onHourResources(w: World) {
  for (const [k, planted] of Object.entries(w.res.saplings)) {
    if (w.time - planted < SAPLING_GROW_DAYS * 1440) continue;
    const i = Number(k);
    delete w.res.saplings[i];
    const x = i % MAP_W, y = Math.floor(i / MAP_W);
    if (w.map.obj[i] === O.SAPLING) { changeTile(w, x, y, null, O.TREE); delete w.res.amounts[i]; }
  }
  for (const [k, r] of Object.entries(w.res.regrow)) {
    if (w.time < r.at) continue;
    const i = Number(k);
    delete w.res.regrow[i];
    const x = i % MAP_W, y = Math.floor(i / MAP_W);
    if (w.map.obj[i] === O.NONE) changeTile(w, x, y, null, r.obj);
  }
}

/** Surface resources left on the map (for diagnostics / UI). */
export function surfaceCounts(w: World) {
  let trees = 0, ore = 0, stone = 0, stumps = 0, saplings = 0;
  for (let i = 0; i < w.map.obj.length; i++) {
    const o = w.map.obj[i];
    if (o === O.TREE) trees++;
    else if (o === O.ORE_ROCK) ore++;
    else if (o === O.ROCK) stone++;
    else if (o === O.STUMP) stumps++;
    else if (o === O.SAPLING) saplings++;
  }
  return { trees, ore, stone, stumps, saplings };
}
