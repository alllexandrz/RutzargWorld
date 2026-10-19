// Minimap in isometric orientation (matches the main view). Click to walk there.

import { getMap, G, O, MAP_W, MAP_H, idx } from "../../shared/map.ts";
import { state } from "./state.ts";
import { bus } from "./bus.ts";

const map = getMap();
const W = (MAP_W + MAP_H), H = (MAP_W + MAP_H) / 2; // 1px per tile-step in iso
const GROUND_COL: Record<number, string> = {
  [G.GRASS]: "#4d6633", [G.COBBLE]: "#8a857c", [G.DIRT]: "#7a6446", [G.WATER]: "#2a5a80", [G.FLOOR_WOOD]: "#6e4c2e",
  [G.FLOOR_STONE]: "#6a6660", [G.FIELD]: "#a8943a", [G.DARK_GRASS]: "#3a3a5a", [G.ROCKY]: "#6b6862",
};
const OBJ_COL: Record<number, string> = {
  [O.TREE]: "#22401a", [O.ROCK]: "#9a958c", [O.ORE_ROCK]: "#8a6aa8", [O.WALL]: "#4a3020", [O.TOWN_WALL]: "#9a958c",
  [O.STUMP]: "#7a5a3a", [O.SAPLING]: "#5a9a42", [O.HERB]: "#7acb6a", [O.SCAFFOLD]: "#c8a050",
};

let base: HTMLCanvasElement, view: HTMLCanvasElement;

function px(x: number, y: number) {
  return { x: x - y + MAP_H, y: (x + y) / 2 };
}

function drawTile(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const i = idx(x, y);
  ctx.fillStyle = OBJ_COL[map.obj[i]] ?? GROUND_COL[map.ground[i]] ?? "#333";
  const p = px(x, y);
  ctx.fillRect(p.x, p.y, 2, 1);
}

function drawBase() {
  const ctx = base.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) drawTile(ctx, x, y);
}

function drawView() {
  const ctx = view.getContext("2d")!;
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.drawImage(base, 0, 0);
  const snap = state.snaps[state.snaps.length - 1];
  if (snap) for (const e of snap.ents.values()) {
    const p = px(e.x, e.y);
    ctx.fillStyle = e.id === state.myId ? "#ffe08a" : e.k === "player" ? "#7fc8ff" : e.k === "klumnog" ? "#b9a8ff" : "#f0e8d8";
    const r = e.id === state.myId ? 3 : 1.6;
    ctx.beginPath(); ctx.arc(p.x + 1, p.y, r, 0, Math.PI * 2); ctx.fill();
  }
  // construction sites
  for (const pl of state.plots) if (pl.stage === "site") {
    const plot = map.plots.find((p) => p.id === pl.id);
    if (!plot) continue;
    const p = px(plot.x + 2.5, plot.y + 2.5);
    ctx.strokeStyle = "#ffd890"; ctx.lineWidth = 1; ctx.strokeRect(p.x - 3, p.y - 2, 6, 4);
  }
}

export function initMinimap() {
  const el = document.getElementById("minimap") as HTMLCanvasElement;
  view = el;
  view.width = W; view.height = H;
  base = document.createElement("canvas");
  base.width = W; base.height = H;
  drawBase();
  bus.on("tilesChanged", (changes: [number, number, number, number][]) => {
    const ctx = base.getContext("2d")!;
    if (!changes.length) return drawBase();
    for (const [x, y] of changes) drawTile(ctx, x, y);
  });
  setInterval(drawView, 400);
  view.onclick = (ev) => {
    const r = view.getBoundingClientRect();
    const mx = ((ev.clientX - r.left) / r.width) * W, my = ((ev.clientY - r.top) / r.height) * H;
    const a = mx - MAP_H, b = my * 2; // a = x - y, b = x + y
    bus.emit("walkTo", (a + b) / 2, (b - a) / 2);
  };
}
