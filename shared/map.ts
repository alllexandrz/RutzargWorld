// The town district map for the first vertical slice.
// Built deterministically from code so client and server share it without transfer.
// Later this will be replaced by data produced by a map editor (see docs/ARCHITECTURE.md).

import { mulberry32, tileNoise } from "./rng.ts";

export const MAP_W = 128;
export const MAP_H = 128;

// ---- Ground layer ----
export const G = {
  GRASS: 0,
  COBBLE: 1,
  DIRT: 2,
  WATER: 3,
  FLOOR_WOOD: 4,
  FLOOR_STONE: 5,
  FIELD: 6,
  DARK_GRASS: 7,
  ROCKY: 8,
} as const;
export type GroundId = (typeof G)[keyof typeof G];

// ---- Object layer (things standing on tiles) ----
export const O = {
  NONE: 0,
  WALL: 1, // building wall
  TOWN_WALL: 2,
  TREE: 3,
  ROCK: 4,
  ORE_ROCK: 5,
  BARS: 6, // jail bars
  TABLE: 7,
  COUNTER: 8,
  BED: 9,
  ANVIL: 10,
  ALTAR: 11,
  CRATE: 12,
  STALL: 13,
  BARREL: 14,
  WELL: 15,
  PILLAR: 16, // ancient ruin pillar (Klumnogi grove)
  FENCE: 17,
  LAMP: 18, // street lamp (light source, non-blocking)
  HERB: 19, // herb bush (gatherable, non-blocking)
  LOGS: 20, // log pile (sawmill)
  BENCH: 21,
  FORGE: 22, // smithy furnace (light source)
  HEARTH: 23, // tavern hearth (light source)
  SCAFFOLD: 24, // construction scaffolding (non-blocking)
  STUMP: 25, // felled tree (non-blocking; a sapling can be planted here)
  SAPLING: 26, // young tree, grows into a TREE
} as const;

/** Resource units a natural object holds before it is exhausted. */
export const RESOURCE_AMOUNT: Record<number, number> = { [O.TREE]: 5, [O.ORE_ROCK]: 6, [O.ROCK]: 8, [O.HERB]: 3 };
export type ObjId = (typeof O)[keyof typeof O];

const BLOCKING = new Set<number>([
  O.WALL, O.TOWN_WALL, O.TREE, O.ROCK, O.ORE_ROCK, O.BARS, O.TABLE, O.COUNTER, O.BED,
  O.ANVIL, O.ALTAR, O.CRATE, O.STALL, O.BARREL, O.WELL, O.PILLAR, O.FENCE, O.LOGS, O.FORGE, O.HEARTH,
]);

export type BuildingKind =
  | "tavern" | "temple" | "smithy" | "warehouse" | "residence" | "house";

export interface Building {
  id: number;
  key: string;
  name: string;
  kind: BuildingKind;
  x: number; y: number; w: number; h: number;
  door: { x: number; y: number };
  wallColor: string;
  roofColor: string;
}

export interface Area {
  id: string;
  name: string;
  x: number; y: number; w: number; h: number;
  building?: number;
}

/** Building plot where the town can build a new house (concept: the town grows with its population). */
export type PlotKind = "house" | "mine" | "quarry";

export interface Plot {
  id: string;
  name: string;
  kind: PlotKind;
  /** Mines/quarries: what the deposit holds and how much. */
  resource?: "ore" | "stone";
  amount?: number;
  x: number; y: number; w: number; h: number;
  door: { x: number; y: number };
  roofColor: string;
  /** Index in GameMap.buildings reserved for this plot. */
  buildingId: number;
}

export type PlotStage = "empty" | "site" | "built";

export interface GameMap {
  w: number;
  h: number;
  ground: Uint8Array;
  obj: Uint8Array;
  /** Building index per tile (walls + interior), -1 outside. */
  bld: Int16Array;
  buildings: Building[];
  areas: Record<string, Area>;
  /** Tiles that emit light at night (for rendering). */
  lights: { x: number; y: number; r: number; color: string }[];
  plots: Plot[];
  /** Current stage of every plot (mutated by applyPlot on server and client alike). */
  plotStage: Record<string, PlotStage>;
}

export function idx(x: number, y: number): number {
  return y * MAP_W + x;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
}

export function isBlocking(map: GameMap, x: number, y: number): boolean {
  if (!inBounds(x, y)) return true;
  const i = idx(x, y);
  if (map.ground[i] === G.WATER) return true;
  return BLOCKING.has(map.obj[i]);
}

export function isWalkable(map: GameMap, x: number, y: number): boolean {
  return !isBlocking(map, x, y);
}

export function buildingAt(map: GameMap, x: number, y: number): Building | null {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!inBounds(tx, ty)) return null;
  const b = map.bld[idx(tx, ty)];
  return b >= 0 ? map.buildings[b] : null;
}

export function areaContains(a: Area, x: number, y: number): boolean {
  return x >= a.x && y >= a.y && x < a.x + a.w && y < a.y + a.h;
}

/** Which named area (most specific = smallest) contains the point. */
export function areaAt(map: GameMap, x: number, y: number): Area | null {
  let best: Area | null = null;
  for (const a of Object.values(map.areas)) {
    if (areaContains(a, x, y) && (!best || a.w * a.h < best.w * best.h)) best = a;
  }
  return best;
}

/** Random walkable tile center inside an area. */
export function randomSpotIn(map: GameMap, area: Area, rnd: () => number = Math.random): { x: number; y: number } {
  for (let i = 0; i < 60; i++) {
    const x = area.x + Math.floor(rnd() * area.w);
    const y = area.y + Math.floor(rnd() * area.h);
    if (isWalkable(map, x, y)) return { x: x + 0.5, y: y + 0.5 };
  }
  // fallback: scan
  for (let y = area.y; y < area.y + area.h; y++)
    for (let x = area.x; x < area.x + area.w; x++)
      if (isWalkable(map, x, y)) return { x: x + 0.5, y: y + 0.5 };
  return { x: area.x + 0.5, y: area.y + 0.5 };
}

// ---------------------------------------------------------------------------
// Map construction
// ---------------------------------------------------------------------------

let cached: GameMap | null = null;

export function getMap(): GameMap {
  if (!cached) cached = buildMap();
  return cached;
}

function buildMap(): GameMap {
  const n = MAP_W * MAP_H;
  const ground = new Uint8Array(n);
  const obj = new Uint8Array(n);
  const bld = new Int16Array(n).fill(-1);
  const buildings: Building[] = [];
  const areas: Record<string, Area> = {};
  const lights: GameMap["lights"] = [];
  const rnd = mulberry32(1337);

  const setG = (x: number, y: number, g: number) => { if (inBounds(x, y)) ground[idx(x, y)] = g; };
  const setO = (x: number, y: number, o: number) => { if (inBounds(x, y)) obj[idx(x, y)] = o; };
  const getO = (x: number, y: number) => (inBounds(x, y) ? obj[idx(x, y)] : O.NONE);
  const fillG = (x0: number, y0: number, w: number, h: number, g: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setG(x, y, g);
  };
  const clearO = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setO(x, y, O.NONE);
  };
  const area = (id: string, name: string, x: number, y: number, w: number, h: number, building?: number) => {
    areas[id] = { id, name, x, y, w, h, building };
  };

  // Base: grass with darker patches.
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++) setG(x, y, tileNoise(x, y, 7) < 0.12 ? G.DIRT : G.GRASS);

  // ---- Outside world ----
  // Forest (north-east)
  for (let y = 1; y < 21; y++)
    for (let x = 46; x < 63; x++)
      if (rnd() < 0.55) setO(x, y, O.TREE);
  // Map border trees
  for (let x = 0; x < MAP_W; x++) { setO(x, 0, O.TREE); setO(x, MAP_H - 1, O.TREE); }
  for (let y = 0; y < MAP_H; y++) { setO(0, y, O.TREE); setO(MAP_W - 1, y, O.TREE); }
  // Scattered trees outside town
  for (let y = 1; y < MAP_H - 1; y++)
    for (let x = 1; x < MAP_W - 1; x++) {
      const outsideTown = x > 45 || y > 47;
      if (outsideTown && getO(x, y) === O.NONE && rnd() < 0.05) setO(x, y, O.TREE);
    }

  // Sawmill clearings in the forest
  fillG(47, 14, 6, 6, G.DIRT); clearO(47, 14, 6, 6);
  setO(48, 15, O.LOGS); setO(49, 15, O.LOGS); setO(51, 17, O.LOGS);
  area("sawmill_north", "Північна лісопилка", 47, 14, 6, 6);
  fillG(56, 13, 6, 6, G.DIRT); clearO(56, 13, 6, 6);
  setO(57, 14, O.LOGS); setO(60, 17, O.LOGS);
  area("sawmill_old", "Стара лісопилка", 56, 13, 6, 6);
  area("forest", "Ліс", 46, 1, 17, 20);
  // paths into clearings
  for (let y = 19; y < 23; y++) { setG(49, y, G.DIRT); setO(49, y, O.NONE); setG(50, y, G.DIRT); setO(50, y, O.NONE); }
  for (let x = 50; x < 59; x++) { setG(x, 19, G.DIRT); setO(x, 19, O.NONE); setO(x, 20, O.NONE); }
  for (let y = 18; y < 21; y++) { setO(58, y, O.NONE); setG(58, y, G.DIRT); }

  // East road from the gate
  for (let x = 44; x < 60; x++) for (let y = 23; y < 26; y++) { setG(x, y, G.DIRT); setO(x, y, O.NONE); }
  // Road south to the mine
  for (let y = 25; y < 47; y++) for (let x = 48; x < 50; x++) { setG(x, y, G.DIRT); setO(x, y, O.NONE); }

  // Farm (east, between road and mine)
  fillG(51, 28, 10, 10, G.FIELD); clearO(50, 27, 12, 12);
  for (let x = 50; x < 62; x++) { setO(x, 27, O.FENCE); setO(x, 38, O.FENCE); }
  for (let y = 27; y < 39; y++) { setO(61, y, O.FENCE); }
  for (let y = 27; y < 39; y++) if (y !== 32 && y !== 33) setO(50, y, O.FENCE);
  area("farm", "Ферма Ірми", 51, 28, 10, 10);

  // Mine (south-east)
  for (let y = 44; y < 63; y++)
    for (let x = 50; x < 63; x++) {
      setG(x, y, G.ROCKY);
      const r = rnd();
      setO(x, y, r < 0.28 ? O.ROCK : r < 0.42 ? O.ORE_ROCK : O.NONE);
    }
  fillG(48, 46, 8, 5, G.DIRT); clearO(48, 46, 8, 5);
  setO(52, 47, O.CRATE); setO(48, 50, O.LAMP);
  for (let x = 51; x < 58; x++) for (let y = 51; y < 56; y++) if (getO(x, y) === O.ROCK && rnd() < 0.6) setO(x, y, O.NONE);
  // guarantee some ore next to the camp
  setO(56, 47, O.ORE_ROCK); setO(56, 49, O.ORE_ROCK); setO(53, 51, O.ORE_ROCK); setO(50, 51, O.ORE_ROCK);
  area("mine", "Шахта Каргат", 48, 44, 15, 19);
  lights.push({ x: 48.5, y: 50.5, r: 4, color: "255,190,110" });

  // Pond (south)
  for (let y = 51; y < 59; y++)
    for (let x = 28; x < 40; x++) {
      const dx = (x - 33.5) / 6, dy = (y - 54.5) / 4;
      if (dx * dx + dy * dy < 1) { setG(x, y, G.WATER); setO(x, y, O.NONE); }
    }

  // Klumnogi grove (south-west): dark grass, ring of ancient pillars, herbs
  for (let y = 49; y < 63; y++)
    for (let x = 1; x < 20; x++) {
      const dx = (x - 10) / 9, dy = (y - 56) / 7;
      if (dx * dx + dy * dy < 1) { setG(x, y, G.DARK_GRASS); if (getO(x, y) === O.TREE && dx * dx + dy * dy < 0.5) setO(x, y, O.NONE); }
    }
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    setO(Math.round(10 + Math.cos(ang) * 4), Math.round(56 + Math.sin(ang) * 3), O.PILLAR);
  }
  for (const [hx, hy] of [[5, 52], [15, 53], [6, 60], [14, 60], [3, 56], [17, 57], [12, 51]]) setO(hx, hy, O.HERB);
  for (const [hx, hy] of [[45, 12], [45, 6], [53, 22], [62, 22]]) if (inBounds(hx, hy)) setO(hx, hy, O.HERB);
  area("grove", "Гай Клумногів", 3, 50, 15, 12);
  lights.push({ x: 10.5, y: 56.5, r: 5, color: "150,120,255" });
  // path from south gate to grove
  for (let y = 46; y < 51; y++) { setG(8, y, G.DIRT); setG(9, y, G.DIRT); setO(8, y, O.NONE); setO(9, y, O.NONE); }

  // ---- Wider region (128×128): forests, river, lake, hills with deposits, new quarter ----
  const forest = (x0: number, y0: number, x1: number, y1: number, density: number) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        if (getO(x, y) === O.NONE && rnd() < density * (0.75 + tileNoise(x, y, 11) * 0.5)) setO(x, y, O.TREE);
  };
  const ellipse = (cx: number, cy: number, rx: number, ry: number, fn: (x: number, y: number) => void) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy < 1 && inBounds(x, y)) fn(x, y);
      }
  };
  /** Carve a 2-wide dirt road; water becomes a wooden bridge. */
  const road = (x0: number, y0: number, x1: number, y1: number, g: number = G.DIRT) => {
    const xs = Math.min(x0, x1), xe = Math.max(x0, x1), ys = Math.min(y0, y1), ye = Math.max(y0, y1);
    for (let y = ys; y <= ye; y++)
      for (let x = xs; x <= xe; x++) {
        if (!inBounds(x, y) || x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1) continue;
        setG(x, y, ground[idx(x, y)] === G.WATER ? G.FLOOR_WOOD : g);
        setO(x, y, O.NONE);
      }
  };

  // Great northern forest beyond the sawmills
  forest(63, 1, 94, 20, 0.55);
  area("forest_n", "Північна пуща", 46, 1, 49, 20);
  // River from the north into a lake
  for (let y = 1; y < 60; y++) {
    const cx = 97 + Math.round(Math.sin(y / 7) * 2);
    for (let x = cx - 1; x <= cx + 1; x++) { setG(x, y, G.WATER); setO(x, y, O.NONE); }
  }
  ellipse(97, 64, 9, 5, (x, y) => { setG(x, y, G.WATER); setO(x, y, O.NONE); });
  area("river", "Річка Сіра", 94, 1, 7, 68);
  // Eastern forest beyond the river
  forest(101, 28, 126, 58, 0.5);
  area("forest_e", "Заріччя", 101, 28, 26, 31);
  // South-western forest and a lake
  forest(2, 66, 44, 124, 0.5);
  ellipse(36, 82, 7, 5, (x, y) => { setG(x, y, G.WATER); setO(x, y, O.NONE); });
  area("forest_sw", "Південна діброва", 2, 66, 43, 59);
  area("lake", "Тихе озеро", 29, 77, 15, 11);
  // Rocky hills (south-east) and an outcrop (south)
  const hills = (x0: number, y0: number, x1: number, y1: number, ore: number, stone: number) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (getO(x, y) !== O.NONE && getO(x, y) !== O.TREE) continue;
        const n = tileNoise(x, y, 21);
        if (n > 0.3) {
          setG(x, y, G.ROCKY);
          const r = rnd();
          setO(x, y, r < ore ? O.ORE_ROCK : r < ore + stone ? O.ROCK : O.NONE);
        } else if (rnd() < 0.04) setO(x, y, O.TREE);
      }
  };
  hills(66, 76, 126, 126, 0.07, 0.13);
  hills(44, 98, 66, 124, 0.03, 0.18);
  area("hills", "Кам'яні пагорби", 66, 76, 61, 51);
  area("outcrop", "Південні скелі", 44, 98, 23, 27);
  // Herbs in meadows and forests
  for (let y = 1; y < MAP_H - 1; y++)
    for (let x = 1; x < MAP_W - 1; x++)
      if ((x > 46 || y > 48) && getO(x, y) === O.NONE && ground[idx(x, y)] !== G.WATER && rnd() < 0.006) setO(x, y, O.HERB);

  // Roads: east to the capital (bridge over the river), south from the south gate, into the hills
  road(44, 23, MAP_W - 2, 25);
  road(8, 47, 25, 48);
  road(24, 47, 25, MAP_H - 2);
  road(48, 46, 49, 91);
  road(24, 90, 118, 91);
  // New quarter outside the walls (east road)
  clearO(63, 26, 24, 16);
  fillG(63, 26, 24, 16, G.GRASS);
  road(63, 26, 64, 34, G.COBBLE);
  road(63, 32, 86, 34, G.COBBLE);
  area("quarter", "Новий квартал", 63, 26, 24, 16);
  for (const [lx, ly] of [[68, 33], [76, 33], [84, 33]]) { setO(lx, ly, O.LAMP); lights.push({ x: lx + 0.5, y: ly + 0.5, r: 4.5, color: "255,180,100" }); }
  // Deposit sites: cleared ground + access path from the hill road
  const depositSites: [number, number][] = [[82, 92], [100, 102], [114, 84], [52, 106]];
  for (const [dx, dy] of depositSites) {
    clearO(dx - 1, dy - 1, 7, 7);
    fillG(dx, dy, 5, 5, G.DIRT);
    road(dx + 2, Math.min(dy, 90), dx + 3, Math.max(dy, 91));
  }

  // ---- Town ----
  // Town wall
  const TW = { x0: 2, y0: 2, x1: 44, y1: 46 };
  for (let x = TW.x0; x <= TW.x1; x++) { setO(x, TW.y0, O.TOWN_WALL); setO(x, TW.y1, O.TOWN_WALL); }
  for (let y = TW.y0; y <= TW.y1; y++) { setO(TW.x0, y, O.TOWN_WALL); setO(TW.x1, y, O.TOWN_WALL); }
  for (let y = TW.y0 + 1; y < TW.y1; y++)
    for (let x = TW.x0 + 1; x < TW.x1; x++) { setO(x, y, O.NONE); setG(x, y, tileNoise(x, y, 3) < 0.2 ? G.DIRT : G.GRASS); }
  // East gate (3 wide) and south gate (2 wide)
  for (let y = 23; y < 26; y++) { setO(TW.x1, y, O.NONE); setG(TW.x1, y, G.COBBLE); }
  setO(8, TW.y1, O.NONE); setO(9, TW.y1, O.NONE); setG(8, TW.y1, G.COBBLE); setG(9, TW.y1, G.COBBLE);
  area("gate", "Східна брама", 41, 22, 6, 5);
  area("south_gate", "Південна брама", 7, 44, 4, 4);
  lights.push({ x: 43.5, y: 22.2, r: 4, color: "255,170,90" }, { x: 43.5, y: 26.8, r: 4, color: "255,170,90" });

  // Roads
  for (let x = TW.x0 + 1; x < TW.x1; x++) for (let y = 23; y < 26; y++) setG(x, y, G.COBBLE);
  for (let y = TW.y0 + 1; y < TW.y1; y++) for (let x = 21; x < 24; x++) setG(x, y, G.COBBLE);
  for (let y = 26; y < TW.y1; y++) { setG(8, y, G.COBBLE); setG(9, y, G.COBBLE); }
  // Market plaza
  fillG(16, 17, 13, 15, G.COBBLE);
  for (const [sx, sy] of [[17, 19], [19, 19], [25, 19], [27, 19], [17, 29], [19, 29], [25, 29], [27, 29]]) setO(sx, sy, O.STALL);
  setO(18, 24, O.WELL);
  setO(26, 22, O.BENCH); setO(26, 27, O.BENCH);
  area("market", "Ринкова площа", 16, 17, 13, 15);
  area("town", "Місто", 3, 3, 41, 43);

  // Street lamps
  for (const [lx, ly] of [[15, 22], [29, 22], [15, 26], [29, 26], [20, 12], [24, 12], [20, 34], [24, 34], [36, 22], [36, 26], [10, 26]]) {
    setO(lx, ly, O.LAMP);
    lights.push({ x: lx + 0.5, y: ly + 0.5, r: 4.5, color: "255,180,100" });
  }

  // Buildings
  const addBuilding = (
    key: string, name: string, kind: BuildingKind,
    x: number, y: number, w: number, h: number,
    door: { x: number; y: number }, wallColor: string, roofColor: string, floor: number = G.FLOOR_WOOD,
  ): Building => {
    const b: Building = { id: buildings.length, key, name, kind, x, y, w, h, door, wallColor, roofColor };
    buildings.push(b);
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        bld[idx(xx, yy)] = b.id;
        const edge = xx === x || yy === y || xx === x + w - 1 || yy === y + h - 1;
        setO(xx, yy, edge ? O.WALL : O.NONE);
        setG(xx, yy, floor);
      }
    setO(door.x, door.y, O.NONE);
    area(key, name, x + 1, y + 1, w - 2, h - 2, b.id);
    // path from door outward
    const out = doorOutside(b);
    if (ground[idx(out.x, out.y)] !== G.COBBLE) setG(out.x, out.y, G.DIRT);
    return b;
  };

  const tavern = addBuilding("tavern", "Таверна «Іржавий кухоль»", "tavern", 5, 5, 10, 9, { x: 10, y: 13 }, "#6b4a33", "#7a3b2a");
  setO(6, 6, O.COUNTER); setO(7, 6, O.COUNTER); setO(8, 6, O.COUNTER); setO(6, 7, O.BARREL); setO(9, 6, O.BARREL);
  setO(13, 6, O.HEARTH);
  setO(7, 9, O.TABLE); setO(11, 9, O.TABLE); setO(7, 11, O.TABLE); setO(11, 11, O.TABLE);
  setO(13, 9, O.BED); setO(13, 11, O.BED);
  lights.push({ x: 13.5, y: 6.8, r: 5, color: "255,150,70" }, { x: 9, y: 9.5, r: 5, color: "255,190,120" });
  for (let y = 14; y < 23; y++) setG(10, y, G.DIRT);

  const temple = addBuilding("temple", "Храм Світанку", "temple", 30, 4, 10, 9, { x: 34, y: 12 }, "#8f8a80", "#3d4b63", G.FLOOR_STONE);
  setO(34, 5, O.ALTAR); setO(33, 5, O.LAMP); setO(35, 5, O.LAMP);
  setO(32, 8, O.BENCH); setO(36, 8, O.BENCH); setO(32, 10, O.BENCH); setO(36, 10, O.BENCH);
  setO(38, 6, O.BED);
  lights.push({ x: 34.5, y: 6, r: 5, color: "255,230,170" });
  for (let y = 13; y < 23; y++) setG(34, y, G.DIRT);

  const smithy = addBuilding("smithy", "Кузня Ульфа", "smithy", 5, 16, 8, 6, { x: 12, y: 19 }, "#5c4a3e", "#4a3a33", G.FLOOR_STONE);
  setO(6, 17, O.FORGE); setO(8, 18, O.ANVIL); setO(10, 17, O.CRATE); setO(6, 20, O.BARREL);
  lights.push({ x: 6.5, y: 17.5, r: 4.5, color: "255,120,40" });
  for (let x = 13; x < 16; x++) setG(x, 19, G.DIRT);

  const warehouse = addBuilding("warehouse", "Склад", "warehouse", 5, 28, 8, 7, { x: 12, y: 31 }, "#6e5b45", "#5a4a3a");
  for (const [cx, cy] of [[6, 29], [7, 29], [6, 30], [10, 29], [10, 33], [6, 33], [7, 33]]) setO(cx, cy, O.CRATE);
  setO(9, 31, O.BARREL);
  for (let x = 13; x < 21; x++) setG(x, 31, G.DIRT);

  const residence = addBuilding("residence", "Резиденція старости", "residence", 30, 33, 12, 11, { x: 35, y: 33 }, "#7f6f5f", "#5b2e2e", G.FLOOR_STONE);
  setO(32, 35, O.TABLE); setO(33, 35, O.COUNTER); setO(31, 41, O.BED); setO(32, 41, O.CRATE);
  // Jail cell (bars) in the south-east corner of the residence
  for (let y = 39; y < 43; y++) setO(37, y, O.BARS);
  for (let x = 37; x < 41; x++) setO(x, 39, O.BARS);
  area("jail", "В'язниця", 38, 40, 3, 3, residence.id);
  lights.push({ x: 33, y: 36, r: 4, color: "255,200,140" });
  for (let y = 26; y < 33; y++) setG(35, y, G.DIRT);

  const houseDefs: [string, string, number, number, number, number, { x: number; y: number }][] = [
    ["house_1", "Будинок біля таверни", 16, 5, 5, 5, { x: 18, y: 9 }],
    ["house_2", "Будинок з синіми віконницями", 25, 5, 5, 5, { x: 27, y: 9 }],
    ["house_3", "Будинок у провулку", 16, 35, 5, 5, { x: 18, y: 35 }],
    ["house_4", "Будинок ткача", 25, 35, 5, 5, { x: 27, y: 35 }],
    ["house_5", "Хата біля південної брами", 4, 38, 5, 5, { x: 6, y: 38 }],
    ["house_6", "Будинок вартових", 32, 16, 6, 5, { x: 34, y: 20 }],
    ["house_7", "Кам'яний будинок", 32, 27, 6, 5, { x: 34, y: 27 }],
  ];
  const roofs = ["#6d3a2c", "#3e4f6e", "#6a4a2a", "#5a3a4a", "#4f5a33", "#4a3a2e", "#5e3328"];
  houseDefs.forEach(([key, name, x, y, w, h, door], i) => {
    const b = addBuilding(key, name, "house", x, y, w, h, door, "#7a6450", roofs[i]);
    // a bed or two and a crate
    const beds = [[x + 1, y + 1], [x + w - 2, y + 1]];
    for (const [bx, by] of beds) if (!(bx === door.x && by === door.y)) setO(bx, by, O.BED);
    setO(x + 1, y + h - 2, O.CRATE);
    if (i === 6) setO(x + w - 2, y + h - 2, O.TABLE);
    lights.push({ x: x + w / 2, y: y + h / 2, r: 3, color: "255,190,120" });
  });

  void tavern; void temple; void smithy; void warehouse;

  // Building plots for future houses (reserved building ids; stamped onto the map when built)
  const plotDefs: [string, string, number, number, { x: number; y: number }, string][] = [
    ["plot_1", "Будинок біля східної стіни", 39, 15, { x: 41, y: 19 }, "#5a4a6e"],
    ["plot_2", "Будинок за управою", 39, 27, { x: 41, y: 27 }, "#6e4a3a"],
    ["plot_3", "Будинок у південному кварталі", 11, 40, { x: 13, y: 40 }, "#4a5e3a"],
    ["plot_4", "Будинок біля резиденції", 24, 41, { x: 26, y: 41 }, "#6a3a3a"],
    ["plot_5", "Будинок за таверною", 15, 11, { x: 17, y: 15 }, "#3a4a6a"],
    ["plot_6", "Будинок біля храму", 25, 11, { x: 27, y: 15 }, "#5e5a33"],
  ];
  // New quarter outside the walls
  for (const [i, x] of [66, 72, 78].entries()) {
    plotDefs.push([`plot_q${i + 1}`, `Будинок у Новому кварталі №${i + 1}`, x, 27, { x: x + 2, y: 31 }, ["#5a3a2a", "#3a4a5a", "#4a5a3a"][i]]);
    plotDefs.push([`plot_q${i + 4}`, `Будинок у Новому кварталі №${i + 4}`, x, 35, { x: x + 2, y: 35 }, ["#6a4a3a", "#4a3a5a", "#5a5a3a"][i]]);
  }
  const plots: Plot[] = plotDefs.map(([id, name, x, y, door, roofColor]) => {
    const b: Building = { id: buildings.length, key: id, name, kind: "house", x, y, w: 5, h: 5, door, wallColor: "#7d6a55", roofColor };
    buildings.push(b);
    return { id, name, kind: "house" as PlotKind, x, y, w: 5, h: 5, door, roofColor, buildingId: b.id };
  });
  // Deposits: sites for mines (ore) and quarries (stone)
  const depositDefs: [string, string, "ore" | "stone", number, number, number][] = [
    ["dep_1", "Залізна жила", "ore", 82, 92, 600],
    ["dep_2", "Сірий кар'єр", "stone", 100, 102, 800],
    ["dep_3", "Глибока жила", "ore", 114, 84, 600],
    ["dep_4", "Південні скелі", "stone", 52, 106, 800],
  ];
  for (const [id, name, resource, x, y, amount] of depositDefs) {
    const kind: PlotKind = resource === "ore" ? "mine" : "quarry";
    const door = { x: x + 2, y };
    const b: Building = { id: buildings.length, key: id, name, kind: "house", x, y, w: 5, h: 5, door, wallColor: "#6a6660", roofColor: "#36343a" };
    buildings.push(b);
    plots.push({ id, name, kind, resource, amount, x, y, w: 5, h: 5, door, roofColor: b.roofColor, buildingId: b.id });
  }
  const plotStage: Record<string, PlotStage> = Object.fromEntries(plots.map((p) => [p.id, "empty" as PlotStage]));

  // Make sure every door has a free tile outside.
  for (const b of buildings) {
    const out = doorOutside(b);
    setO(out.x, out.y, O.NONE);
  }

  // unbuilt plots don't have a door yet — skip the "free tile outside the door" fix above for them
  return { w: MAP_W, h: MAP_H, ground, obj, bld, buildings, areas, lights, plots, plotStage };
}

/**
 * Change a plot's stage on a map. Deterministic and idempotent: the server and every client
 * apply the same stages and end up with identical tiles (walkability, pathfinding, rendering).
 */
export function applyPlot(map: GameMap, plotId: string, stage: PlotStage): boolean {
  const p = map.plots.find((x) => x.id === plotId);
  if (!p || map.plotStage[plotId] === stage) return false;
  const set = (x: number, y: number, g: number | null, o: number) => {
    const i = idx(x, y);
    if (g !== null) map.ground[i] = g;
    map.obj[i] = o;
  };
  if (stage === "site") {
    for (let y = p.y; y < p.y + p.h; y++)
      for (let x = p.x; x < p.x + p.w; x++) {
        const edge = x === p.x || y === p.y || x === p.x + p.w - 1 || y === p.y + p.h - 1;
        set(x, y, G.DIRT, edge && !(x === p.door.x && y === p.door.y) ? O.SCAFFOLD : O.NONE);
      }
    set(p.x + 2, p.y + 2, null, O.LOGS);
    map.areas[p.id] = { id: p.id, name: `Будова: ${p.kind === "mine" ? "шахта" : p.kind === "quarry" ? "кар'єр" : "дім"} «${p.name}»`, x: p.x, y: p.y, w: p.w, h: p.h };
  } else if (stage === "built" && p.kind === "quarry") {
    // Open-pit quarry: rocky ground, a fence, tools and crates — no roof
    for (let y = p.y; y < p.y + p.h; y++)
      for (let x = p.x; x < p.x + p.w; x++) {
        const edge = x === p.x || y === p.y || x === p.x + p.w - 1 || y === p.y + p.h - 1;
        set(x, y, G.ROCKY, edge && !(x === p.door.x && y === p.door.y) ? O.FENCE : O.NONE);
      }
    set(p.x + 1, p.y + p.h - 2, null, O.CRATE);
    set(p.x + p.w - 2, p.y + p.h - 2, null, O.LOGS);
    map.areas[p.id] = { id: p.id, name: `Кар'єр «${p.name}»`, x: p.x + 1, y: p.y + 1, w: p.w - 2, h: p.h - 2 };
  } else if (stage === "built" && p.kind === "mine") {
    // Mine head: a stone building over the shaft
    const b = map.buildings[p.buildingId];
    for (let y = p.y; y < p.y + p.h; y++)
      for (let x = p.x; x < p.x + p.w; x++) {
        const edge = x === p.x || y === p.y || x === p.x + p.w - 1 || y === p.y + p.h - 1;
        map.bld[idx(x, y)] = b.id;
        set(x, y, G.FLOOR_STONE, edge ? O.WALL : O.NONE);
      }
    set(p.door.x, p.door.y, null, O.NONE);
    set(p.x + 1, p.y + p.h - 2, null, O.CRATE);
    set(p.x + p.w - 2, p.y + p.h - 2, null, O.BARREL);
    map.areas[p.id] = { id: p.id, name: `Шахта «${p.name}»`, x: p.x + 1, y: p.y + 1, w: p.w - 2, h: p.h - 2, building: b.id };
    map.lights.push({ x: p.x + p.w / 2, y: p.y + p.h / 2, r: 3, color: "255,170,90" });
  } else if (stage === "built") {
    const b = map.buildings[p.buildingId];
    for (let y = p.y; y < p.y + p.h; y++)
      for (let x = p.x; x < p.x + p.w; x++) {
        const edge = x === p.x || y === p.y || x === p.x + p.w - 1 || y === p.y + p.h - 1;
        map.bld[idx(x, y)] = b.id;
        set(x, y, G.FLOOR_WOOD, edge ? O.WALL : O.NONE);
      }
    set(p.door.x, p.door.y, null, O.NONE);
    const beds = [[p.x + 1, p.y + 1], [p.x + p.w - 2, p.y + 1]];
    if (p.door.y === p.y) { beds[0][1] = p.y + p.h - 2; beds[1][1] = p.y + p.h - 2; }
    for (const [bx, by] of beds) set(bx, by, null, O.BED);
    set(p.x + 1, p.door.y === p.y ? p.y + 1 : p.y + p.h - 2, null, O.CRATE);
    const out = doorOutside(b);
    set(out.x, out.y, G.DIRT, O.NONE);
    map.areas[p.id] = { id: p.id, name: p.name, x: p.x + 1, y: p.y + 1, w: p.w - 2, h: p.h - 2, building: b.id };
    map.lights.push({ x: p.x + p.w / 2, y: p.y + p.h / 2, r: 3, color: "255,190,120" });
  } else {
    for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) { set(x, y, G.GRASS, O.NONE); map.bld[idx(x, y)] = -1; }
    delete map.areas[p.id];
  }
  map.plotStage[plotId] = stage;
  return true;
}

/** Number of beds inside an area's building (housing capacity). */
export function bedsIn(map: GameMap, areaId: string): number {
  const a = map.areas[areaId];
  if (!a || a.building === undefined) return 0;
  const b = map.buildings[a.building];
  let n = 0;
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (map.obj[idx(x, y)] === O.BED) n++;
  return n;
}

/** The tile just outside the building door. */
export function doorOutside(b: Building): { x: number; y: number } {
  const { door } = b;
  if (door.y === b.y) return { x: door.x, y: door.y - 1 };
  if (door.y === b.y + b.h - 1) return { x: door.x, y: door.y + 1 };
  if (door.x === b.x) return { x: door.x - 1, y: door.y };
  return { x: door.x + 1, y: door.y };
}

export function isLightObj(o: number): boolean {
  return o === O.LAMP || o === O.FORGE || o === O.HEARTH;
}

/** Is there an object of the given type within `r` tiles of (x,y)? Returns its tile or null. */
export function findObjNear(map: GameMap, x: number, y: number, objId: number, r = 1.6): { x: number; y: number } | null {
  const tx = Math.floor(x), ty = Math.floor(y);
  let best: { x: number; y: number } | null = null, bestD = Infinity;
  const R = Math.ceil(r);
  for (let yy = ty - R; yy <= ty + R; yy++)
    for (let xx = tx - R; xx <= tx + R; xx++) {
      if (!inBounds(xx, yy) || map.obj[idx(xx, yy)] !== objId) continue;
      const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y);
      if (d <= r + 0.5 && d < bestD) { best = { x: xx, y: yy }; bestD = d; }
    }
  return best;
}

export function groundAt(map: GameMap, x: number, y: number): number {
  const tx = Math.floor(x), ty = Math.floor(y);
  return inBounds(tx, ty) ? map.ground[idx(tx, ty)] : G.GRASS;
}

/** Change one tile (resource depletion, planting...). Returns true if something changed. */
export function setTile(map: GameMap, x: number, y: number, ground: number | null, obj: number): boolean {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  const g = ground ?? map.ground[i];
  if (map.ground[i] === g && map.obj[i] === obj) return false;
  map.ground[i] = g;
  map.obj[i] = obj;
  return true;
}

/** Can a sapling be planted on this tile? */
export function canPlant(map: GameMap, x: number, y: number): boolean {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  if (map.bld[i] >= 0) return false;
  const o = map.obj[i], g = map.ground[i];
  if (o === O.STUMP) return true;
  if (o !== O.NONE) return false;
  const town = x >= 2 && x <= 44 && y >= 2 && y <= 46;
  return !town && (g === G.GRASS || g === G.DARK_GRASS || g === G.DIRT);
}
