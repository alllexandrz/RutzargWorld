// Procedural placeholder art, generated at boot into Phaser textures.
// Every visual is addressed by a texture key / animation key, so later these can be
// replaced 1:1 by sprite sheets and animation data from the in-house editors
// (see docs/ART_PIPELINE.md).

import Phaser from "phaser";
import { TW, TH } from "./iso.ts";

type Ctx = CanvasRenderingContext2D;

function canvasTex(scene: Phaser.Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void) {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.createCanvas(key, w, h)!;
  const ctx = tex.getContext();
  draw(ctx);
  tex.refresh();
}

// Deterministic tiny RNG for texture details
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
  else { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function diamond(ctx: Ctx, ox: number, oy: number, w = TW, h = TH, grow = 0) {
  ctx.beginPath();
  ctx.moveTo(ox + w / 2, oy - grow);
  ctx.lineTo(ox + w + grow, oy + h / 2);
  ctx.lineTo(ox + w / 2, oy + h + grow);
  ctx.lineTo(ox - grow, oy + h / 2);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

export const GROUND_VARIANTS = 4;

interface GroundStyle { base: string; draw?: (ctx: Ctx, r: () => number) => void }

const GROUND: Record<number, GroundStyle> = {
  0: { base: "#4d6633", draw: (c, r) => speckle(c, r, ["#5a7a3c", "#41582b", "#62823f"], 26) },             // grass
  1: { base: "#6b665e", draw: (c, r) => cobbles(c, r) },                                                   // cobble
  2: { base: "#6f5a3e", draw: (c, r) => speckle(c, r, ["#7d6747", "#5f4c33", "#8a7352"], 18) },             // dirt
  3: { base: "#244a66", draw: (c, r) => waves(c, r) },                                                      // water
  4: { base: "#6e4c2e", draw: (c) => planks(c) },                                                          // wood floor
  5: { base: "#5f5c57", draw: (c) => flagstones(c) },                                                       // stone floor
  6: { base: "#6f6a2c", draw: (c, r) => wheat(c, r) },                                                     // field
  7: { base: "#28352f", draw: (c, r) => speckle(c, r, ["#334438", "#1f2a25", "#5b4a8a"], 22) },             // dark grass (grove)
  8: { base: "#55524c", draw: (c, r) => speckle(c, r, ["#625e57", "#47443f", "#6b665f"], 22) },             // rocky
};

function inDiamond(x: number, y: number) {
  return Math.abs(x - TW / 2) / (TW / 2) + Math.abs(y - TH / 2) / (TH / 2) <= 0.92;
}
function speckle(ctx: Ctx, r: () => number, cols: string[], n: number) {
  for (let i = 0; i < n; i++) {
    const x = r() * TW, y = r() * TH;
    if (!inDiamond(x, y)) continue;
    ctx.fillStyle = cols[(r() * cols.length) | 0];
    ctx.fillRect(x, y, 2 + r() * 2, 1 + r() * 2);
  }
}
function cobbles(ctx: Ctx, r: () => number) {
  for (let i = 0; i < 16; i++) {
    const x = 6 + r() * (TW - 12), y = 3 + r() * (TH - 6);
    if (!inDiamond(x, y)) continue;
    ctx.fillStyle = shade("#6b665e", (r() - 0.5) * 0.35);
    ctx.beginPath(); ctx.ellipse(x, y, 4 + r() * 2, 2 + r(), 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 0.6; ctx.stroke();
  }
}
function waves(ctx: Ctx, r: () => number) {
  ctx.strokeStyle = "rgba(160,200,230,0.35)"; ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const x = 12 + r() * 36, y = 8 + r() * 16;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 4, y - 2, x + 8, y); ctx.stroke();
  }
}
function planks(ctx: Ctx) {
  ctx.strokeStyle = "rgba(30,18,8,0.45)"; ctx.lineWidth = 1;
  for (let i = -4; i < 8; i++) {
    ctx.beginPath(); ctx.moveTo(i * 8, 0); ctx.lineTo(i * 8 + 64, 32); ctx.stroke();
  }
}
function flagstones(ctx: Ctx) {
  ctx.strokeStyle = "rgba(20,20,20,0.35)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(16, 8); ctx.lineTo(48, 24); ctx.moveTo(48, 8); ctx.lineTo(16, 24); ctx.stroke();
}
function wheat(ctx: Ctx, r: () => number) {
  for (let row = 0; row < 6; row++) {
    for (let i = 0; i < 10; i++) {
      const x = 4 + i * 6 + row * 2 + r() * 2, y = 4 + row * 4 + r() * 2;
      if (!inDiamond(x, y)) continue;
      ctx.strokeStyle = r() < 0.5 ? "#c9b04a" : "#a89436"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y + 3); ctx.lineTo(x + 1, y - 3); ctx.stroke();
    }
  }
}

export function groundKey(g: number, v: number) {
  return `g_${g}_${v}`;
}

function makeGround(scene: Phaser.Scene) {
  for (const [gs, style] of Object.entries(GROUND)) {
    const g = Number(gs);
    for (let v = 0; v < GROUND_VARIANTS; v++) {
      canvasTex(scene, groundKey(g, v), TW + 2, TH + 2, (ctx) => {
        ctx.save(); ctx.translate(1, 1);
        diamond(ctx, 0, 0, TW, TH, 0.8);
        ctx.fillStyle = shade(style.base, (v - 1.5) * 0.04);
        ctx.fill();
        ctx.save(); diamond(ctx, 0, 0); ctx.clip();
        style.draw?.(ctx, rng(g * 100 + v * 7 + 1));
        ctx.restore();
        ctx.restore();
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Cubes (walls, roofs, town wall)
// ---------------------------------------------------------------------------

export interface CubeOpts {
  top: string; left: string; right: string;
  windows?: boolean; beams?: boolean; crenel?: boolean; door?: "left" | "right";
}

/** Texture for a cube occupying one tile, height h. Place with origin (0.5,0) at (sx, tileTopY - h). */
export function cubeTex(scene: Phaser.Scene, key: string, h: number, o: CubeOpts): string {
  canvasTex(scene, key, TW, TH + h, (ctx) => {
    // left face
    ctx.fillStyle = o.left;
    ctx.beginPath(); ctx.moveTo(0, TH / 2); ctx.lineTo(TW / 2, TH); ctx.lineTo(TW / 2, TH + h); ctx.lineTo(0, TH / 2 + h); ctx.closePath(); ctx.fill();
    // right face
    ctx.fillStyle = o.right;
    ctx.beginPath(); ctx.moveTo(TW / 2, TH); ctx.lineTo(TW, TH / 2); ctx.lineTo(TW, TH / 2 + h); ctx.lineTo(TW / 2, TH + h); ctx.closePath(); ctx.fill();
    if (o.beams && h > 20) {
      ctx.strokeStyle = "rgba(35,22,12,0.75)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, TH / 2 + 2); ctx.lineTo(TW / 2, TH + 2); ctx.lineTo(TW, TH / 2 + 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, TH / 2 + h - 1); ctx.lineTo(TW / 2, TH + h - 1); ctx.lineTo(TW, TH / 2 + h - 1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(TW / 2, TH); ctx.lineTo(TW / 2, TH + h); ctx.stroke();
    }
    if (o.windows && h > 26) {
      ctx.fillStyle = "#2a1c10";
      ctx.beginPath(); ctx.moveTo(10, TH / 2 + 12); ctx.lineTo(20, TH / 2 + 17); ctx.lineTo(20, TH / 2 + 27); ctx.lineTo(10, TH / 2 + 22); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(255,190,90,0.55)";
      ctx.beginPath(); ctx.moveTo(11.5, TH / 2 + 14); ctx.lineTo(18.5, TH / 2 + 17.5); ctx.lineTo(18.5, TH / 2 + 25); ctx.lineTo(11.5, TH / 2 + 21.5); ctx.closePath(); ctx.fill();
    }
    if (o.door) {
      ctx.fillStyle = "#24160b";
      if (o.door === "left") { ctx.beginPath(); ctx.moveTo(10, TH / 2 + 5 + h - 30); ctx.lineTo(22, TH / 2 + 11 + h - 30); ctx.lineTo(22, TH / 2 + h + 11); ctx.lineTo(10, TH / 2 + h + 5); ctx.closePath(); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(42, TH / 2 + 11 + h - 30); ctx.lineTo(54, TH / 2 + 5 + h - 30); ctx.lineTo(54, TH / 2 + h + 5); ctx.lineTo(42, TH / 2 + h + 11); ctx.closePath(); ctx.fill(); }
    }
    // top
    diamond(ctx, 0, 0); ctx.fillStyle = o.top; ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1; ctx.stroke();
    if (o.crenel) {
      ctx.fillStyle = shade(o.top, 0.1);
      for (const [x, y] of [[16, 8], [48, 8], [16, 24], [48, 24]]) ctx.fillRect(x - 4, y - 6, 8, 6);
    }
  });
  return key;
}

// ---------------------------------------------------------------------------
// Props & nature
// ---------------------------------------------------------------------------

function makeTrees(scene: Phaser.Scene) {
  const palettes = [["#2f4a23", "#3d5e2c", "#4f7536"], ["#2a4220", "#36552a", "#47693a"], ["#3b4a22", "#4d5e2b", "#62753a"]];
  palettes.forEach((pal, i) => {
    canvasTex(scene, `tree_${i}`, 64, 104, (ctx) => {
      const r = rng(i + 11);
      ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.beginPath(); ctx.ellipse(32, 96, 20, 8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#4a3320"; ctx.fillRect(28, 64, 8, 32);
      ctx.fillStyle = "#3a2716"; ctx.fillRect(28, 64, 3, 32);
      const blobs = [[32, 58, 22], [22, 46, 16], [42, 44, 16], [32, 30, 16], [30, 18, 10]];
      for (let k = 0; k < 3; k++)
        for (const [x, y, rad] of blobs) {
          ctx.fillStyle = pal[k];
          ctx.beginPath(); ctx.arc(x + (r() - 0.5) * 4 - k, y - k * 2 + (r() - 0.5) * 3, rad - k * 3, 0, Math.PI * 2); ctx.fill();
        }
    });
  });
}

function makeProps(scene: Phaser.Scene) {
  const P = (key: string, w: number, h: number, draw: (c: Ctx) => void) => canvasTex(scene, key, w, h, draw);
  const shadow = (c: Ctx, x: number, y: number, rx: number, ry: number) => { c.fillStyle = "rgba(0,0,0,0.28)"; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); c.fill(); };

  P("rock", 64, 56, (c) => {
    shadow(c, 32, 46, 24, 9);
    c.fillStyle = "#6c6964"; c.beginPath(); c.moveTo(10, 44); c.lineTo(18, 18); c.lineTo(36, 10); c.lineTo(54, 24); c.lineTo(56, 44); c.closePath(); c.fill();
    c.fillStyle = "#57544f"; c.beginPath(); c.moveTo(36, 10); c.lineTo(54, 24); c.lineTo(56, 44); c.lineTo(34, 46); c.closePath(); c.fill();
  });
  P("ore", 64, 56, (c) => {
    shadow(c, 32, 46, 24, 9);
    c.fillStyle = "#5a5660"; c.beginPath(); c.moveTo(10, 44); c.lineTo(16, 20); c.lineTo(34, 8); c.lineTo(54, 22); c.lineTo(56, 44); c.closePath(); c.fill();
    c.fillStyle = "#47434d"; c.beginPath(); c.moveTo(34, 8); c.lineTo(54, 22); c.lineTo(56, 44); c.lineTo(34, 46); c.closePath(); c.fill();
    const r = rng(5);
    for (let i = 0; i < 9; i++) { c.fillStyle = r() < 0.5 ? "#d08a3a" : "#7fb2d8"; c.fillRect(16 + r() * 34, 16 + r() * 24, 3, 3); }
  });
  P("stall", 64, 72, (c) => {
    shadow(c, 32, 62, 26, 10);
    c.fillStyle = "#5a3d24"; c.fillRect(12, 30, 3, 32); c.fillRect(49, 30, 3, 32);
    c.fillStyle = "#7a5634"; c.beginPath(); c.moveTo(8, 48); c.lineTo(32, 60); c.lineTo(56, 48); c.lineTo(32, 38); c.closePath(); c.fill();
    c.fillStyle = "#c9a24a"; c.fillRect(20, 44, 5, 4); c.fillStyle = "#8a3a2a"; c.fillRect(30, 46, 5, 4); c.fillStyle = "#6a8a3a"; c.fillRect(38, 44, 5, 4);
    for (let i = 0; i < 6; i++) {
      c.fillStyle = i % 2 ? "#e8dcc0" : "#9a2f2a";
      c.beginPath(); c.moveTo(6 + i * 9, 26 + i * 0); c.lineTo(15 + i * 9, 26); c.lineTo(15 + i * 9, 34); c.lineTo(6 + i * 9, 34); c.closePath(); c.fill();
    }
    c.fillStyle = "#9a2f2a"; c.beginPath(); c.moveTo(4, 26); c.lineTo(32, 10); c.lineTo(60, 26); c.closePath(); c.fill();
  });
  P("table", 64, 48, (c) => {
    shadow(c, 32, 38, 20, 8);
    c.fillStyle = "#5a3a20"; c.fillRect(16, 26, 3, 12); c.fillRect(45, 26, 3, 12);
    c.fillStyle = "#7a5230"; c.beginPath(); c.moveTo(10, 26); c.lineTo(32, 16); c.lineTo(54, 26); c.lineTo(32, 36); c.closePath(); c.fill();
    c.fillStyle = "#c8c0a0"; c.fillRect(28, 22, 5, 4);
  });
  P("counter", 64, 56, (c) => {
    c.fillStyle = "#4a301a"; c.beginPath(); c.moveTo(4, 30); c.lineTo(32, 44); c.lineTo(32, 54); c.lineTo(4, 40); c.closePath(); c.fill();
    c.fillStyle = "#3a2412"; c.beginPath(); c.moveTo(32, 44); c.lineTo(60, 30); c.lineTo(60, 40); c.lineTo(32, 54); c.closePath(); c.fill();
    c.fillStyle = "#7a5230"; c.beginPath(); c.moveTo(4, 30); c.lineTo(32, 16); c.lineTo(60, 30); c.lineTo(32, 44); c.closePath(); c.fill();
  });
  P("bed", 64, 48, (c) => {
    shadow(c, 32, 36, 24, 9);
    c.fillStyle = "#5a3a20"; c.beginPath(); c.moveTo(6, 28); c.lineTo(32, 16); c.lineTo(58, 28); c.lineTo(32, 40); c.closePath(); c.fill();
    c.fillStyle = "#8a7a6a"; c.beginPath(); c.moveTo(12, 27); c.lineTo(32, 18); c.lineTo(52, 27); c.lineTo(32, 36); c.closePath(); c.fill();
    c.fillStyle = "#e0d8c8"; c.beginPath(); c.ellipse(22, 24, 6, 3, -0.4, 0, Math.PI * 2); c.fill();
  });
  P("anvil", 64, 48, (c) => {
    shadow(c, 32, 38, 16, 6);
    c.fillStyle = "#4a3a2a"; c.fillRect(26, 28, 12, 10);
    c.fillStyle = "#3a3a40"; c.beginPath(); c.moveTo(16, 22); c.lineTo(48, 22); c.lineTo(44, 28); c.lineTo(22, 28); c.closePath(); c.fill();
    c.fillStyle = "#5a5a64"; c.fillRect(18, 19, 28, 4);
  });
  P("altar", 64, 64, (c) => {
    shadow(c, 32, 52, 22, 8);
    c.fillStyle = "#8a857a"; c.beginPath(); c.moveTo(10, 38); c.lineTo(32, 28); c.lineTo(54, 38); c.lineTo(32, 48); c.closePath(); c.fill();
    c.fillStyle = "#6a665c"; c.fillRect(10, 38, 22, 12); c.fillStyle = "#5a564c"; c.fillRect(32, 38, 22, 12);
    c.fillStyle = "#f0d890"; c.beginPath(); c.arc(32, 22, 8, 0, Math.PI * 2); c.fill();
    c.strokeStyle = "#f0d890"; c.lineWidth = 2; for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; c.beginPath(); c.moveTo(32 + Math.cos(a) * 10, 22 + Math.sin(a) * 10); c.lineTo(32 + Math.cos(a) * 15, 22 + Math.sin(a) * 15); c.stroke(); }
  });
  P("crate", 64, 52, (c) => {
    shadow(c, 32, 44, 18, 7);
    c.fillStyle = "#8a6a3a"; c.beginPath(); c.moveTo(14, 22); c.lineTo(32, 13); c.lineTo(50, 22); c.lineTo(32, 31); c.closePath(); c.fill();
    c.fillStyle = "#6e5230"; c.beginPath(); c.moveTo(14, 22); c.lineTo(32, 31); c.lineTo(32, 46); c.lineTo(14, 37); c.closePath(); c.fill();
    c.fillStyle = "#5a4224"; c.beginPath(); c.moveTo(32, 31); c.lineTo(50, 22); c.lineTo(50, 37); c.lineTo(32, 46); c.closePath(); c.fill();
    c.strokeStyle = "rgba(30,20,10,0.6)"; c.beginPath(); c.moveTo(14, 22); c.lineTo(32, 46); c.moveTo(50, 22); c.lineTo(32, 46); c.stroke();
  });
  P("barrel", 64, 52, (c) => {
    shadow(c, 32, 44, 12, 5);
    c.fillStyle = "#6e4a26"; c.fillRect(22, 20, 20, 24);
    c.fillStyle = "#3a2a1a"; c.fillRect(22, 24, 20, 2); c.fillRect(22, 38, 20, 2);
    c.fillStyle = "#8a5e32"; c.beginPath(); c.ellipse(32, 20, 10, 4, 0, 0, Math.PI * 2); c.fill();
  });
  P("well", 64, 64, (c) => {
    shadow(c, 32, 50, 22, 8);
    c.fillStyle = "#6a665e"; c.beginPath(); c.ellipse(32, 44, 18, 9, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#1a2a38"; c.beginPath(); c.ellipse(32, 40, 13, 6, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#4a3320"; c.fillRect(15, 16, 3, 28); c.fillRect(46, 16, 3, 28);
    c.fillStyle = "#6a3a2a"; c.beginPath(); c.moveTo(10, 18); c.lineTo(32, 6); c.lineTo(54, 18); c.closePath(); c.fill();
  });
  P("pillar", 64, 112, (c) => {
    shadow(c, 32, 102, 16, 6);
    const g = c.createLinearGradient(20, 0, 44, 0); g.addColorStop(0, "#5a566a"); g.addColorStop(1, "#3a3648");
    c.fillStyle = g; c.fillRect(22, 20, 20, 84);
    c.fillStyle = "#6a667a"; c.fillRect(18, 16, 28, 8); c.fillRect(18, 98, 28, 6);
    c.fillStyle = "rgba(170,140,255,0.9)";
    for (const y of [40, 58, 76]) { c.beginPath(); c.moveTo(32, y - 6); c.lineTo(36, y); c.lineTo(32, y + 6); c.lineTo(28, y); c.closePath(); c.fill(); }
  });
  P("fence", 64, 44, (c) => {
    c.strokeStyle = "#6a4a2a"; c.lineWidth = 3;
    c.beginPath(); c.moveTo(8, 30); c.lineTo(56, 30); c.moveTo(8, 22); c.lineTo(56, 22); c.stroke();
    c.lineWidth = 4; for (const x of [10, 32, 54]) { c.beginPath(); c.moveTo(x, 36); c.lineTo(x, 16); c.stroke(); }
  });
  P("lamp", 64, 96, (c) => {
    shadow(c, 32, 88, 8, 3);
    c.fillStyle = "#2a2622"; c.fillRect(30, 26, 4, 62);
    c.fillStyle = "#3a342c"; c.fillRect(25, 16, 14, 12);
    c.fillStyle = "#ffcf7a"; c.fillRect(27, 18, 10, 8);
  });
  P("herb", 64, 44, (c) => {
    const r = rng(77);
    for (let i = 0; i < 14; i++) {
      c.strokeStyle = r() < 0.6 ? "#4f9a4a" : "#3a7a3a"; c.lineWidth = 2;
      const x = 22 + r() * 20; c.beginPath(); c.moveTo(32, 36); c.quadraticCurveTo(x, 26, x + (r() - 0.5) * 8, 16 + r() * 8); c.stroke();
    }
    c.fillStyle = "#c8a0e8"; for (let i = 0; i < 5; i++) c.fillRect(22 + r() * 20, 16 + r() * 10, 3, 3);
  });
  P("logs", 64, 48, (c) => {
    shadow(c, 32, 40, 24, 8);
    for (const [x, y] of [[14, 30], [30, 34], [22, 22], [38, 26], [30, 16]]) {
      c.fillStyle = "#6a4a2a"; c.beginPath(); c.moveTo(x, y); c.lineTo(x + 20, y - 8); c.lineTo(x + 20, y - 2); c.lineTo(x, y + 6); c.closePath(); c.fill();
      c.fillStyle = "#c8a070"; c.beginPath(); c.ellipse(x + 1, y + 3, 3, 4, 0, 0, Math.PI * 2); c.fill();
    }
  });
  P("bench", 64, 44, (c) => {
    shadow(c, 32, 34, 18, 6);
    c.fillStyle = "#5a3a20"; c.fillRect(18, 26, 3, 8); c.fillRect(43, 26, 3, 8);
    c.fillStyle = "#7a5230"; c.beginPath(); c.moveTo(12, 26); c.lineTo(36, 14); c.lineTo(52, 22); c.lineTo(28, 34); c.closePath(); c.fill();
  });
  P("forge", 64, 72, (c) => {
    c.fillStyle = "#4a4240"; c.beginPath(); c.moveTo(8, 36); c.lineTo(32, 24); c.lineTo(56, 36); c.lineTo(56, 56); c.lineTo(32, 68); c.lineTo(8, 56); c.closePath(); c.fill();
    c.fillStyle = "#3a3230"; c.fillRect(24, 4, 16, 28);
    const g = c.createRadialGradient(32, 46, 2, 32, 46, 14); g.addColorStop(0, "#ffd070"); g.addColorStop(1, "rgba(255,80,20,0.2)");
    c.fillStyle = g; c.beginPath(); c.ellipse(32, 46, 14, 8, 0, 0, Math.PI * 2); c.fill();
  });
  P("hearth", 64, 72, (c) => {
    c.fillStyle = "#5a5450"; c.beginPath(); c.moveTo(8, 36); c.lineTo(32, 24); c.lineTo(56, 36); c.lineTo(56, 58); c.lineTo(32, 70); c.lineTo(8, 58); c.closePath(); c.fill();
    c.fillStyle = "#1a1410"; c.beginPath(); c.ellipse(32, 52, 12, 9, 0, 0, Math.PI * 2); c.fill();
    const g = c.createRadialGradient(32, 54, 1, 32, 54, 10); g.addColorStop(0, "#fff0a0"); g.addColorStop(1, "rgba(255,100,20,0.3)");
    c.fillStyle = g; c.beginPath(); c.ellipse(32, 54, 10, 7, 0, 0, Math.PI * 2); c.fill();
  });
  P("stump", 64, 40, (c) => {
    shadow(c, 32, 30, 12, 5);
    c.fillStyle = "#5a3d24"; c.fillRect(25, 18, 14, 12);
    c.fillStyle = "#c8a070"; c.beginPath(); c.ellipse(32, 18, 7, 3.5, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = "#8a6a3a"; c.lineWidth = 1; c.beginPath(); c.ellipse(32, 18, 4, 2, 0, 0, Math.PI * 2); c.stroke();
  });
  P("sapling", 64, 56, (c) => {
    shadow(c, 32, 50, 8, 3);
    c.strokeStyle = "#5a3d24"; c.lineWidth = 2; c.beginPath(); c.moveTo(32, 50); c.lineTo(32, 28); c.stroke();
    for (const [x, y, r, col] of [[32, 24, 8, "#4f8a3a"], [27, 30, 6, "#3d7a2c"], [37, 30, 6, "#5a9a42"]] as const) {
      c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    }
  });
  P("scaffold", 64, 80, (c) => {
    c.strokeStyle = "#8a6a3a"; c.lineWidth = 3;
    for (const x of [14, 50]) { c.beginPath(); c.moveTo(x, 70); c.lineTo(x, 14); c.stroke(); }
    c.lineWidth = 2;
    for (const y of [24, 44, 62]) { c.beginPath(); c.moveTo(10, y); c.lineTo(54, y - 6); c.stroke(); }
    c.strokeStyle = "#6a4a2a"; c.beginPath(); c.moveTo(14, 62); c.lineTo(50, 18); c.stroke();
  });
  P("bars", 64, 80, (c) => {
    c.strokeStyle = "#3a3a40"; c.lineWidth = 3;
    for (let i = 0; i < 6; i++) { const x = 6 + i * 10; c.beginPath(); c.moveTo(x, 24 + (x < 32 ? x / 2 : 32 - x / 2) - 16); c.lineTo(x, 72 + (x < 32 ? x / 2 : 32 - x / 2) - 16); c.stroke(); }
    c.beginPath(); c.moveTo(0, 22); c.lineTo(32, 38); c.lineTo(64, 22); c.stroke();
  });
}

// ---------------------------------------------------------------------------
// Characters — layered grayscale sprite sheets tinted per character (body / skin / hair).
// Frames: 0 idle, 1-4 walk, 5-6 work, 7 sleep, 8 pray. Row 0 = facing camera, row 1 = facing away.
// ---------------------------------------------------------------------------

export const CHAR_W = 32, CHAR_H = 52;
export const CHAR_FRAMES = 9;
const LAYERS = ["body", "skin", "hair"] as const;
export type CharLayer = (typeof LAYERS)[number];

function drawCharFrame(c: Ctx, layer: CharLayer, frame: number, back: boolean) {
  const cx = 16;
  let bob = 0, legA = 0, legB = 0, armA = 0, armB = 0;
  if (frame >= 1 && frame <= 4) {
    const ph = [0, 1, 0, -1][frame - 1];
    legA = ph * 3; legB = -ph * 3; armA = -ph * 3; armB = ph * 3; bob = frame % 2 === 0 ? -1 : 0;
  }
  if (frame === 5) { armA = -10; armB = -8; }
  if (frame === 6) { armA = 4; armB = 3; bob = 1; }
  const sleep = frame === 7, pray = frame === 8;
  if (sleep) {
    // lying down
    if (layer === "body") { c.fillStyle = "#d8d8d8"; c.fillRect(4, 38, 22, 8); c.fillStyle = "#b8b8b8"; c.fillRect(4, 44, 22, 2); }
    if (layer === "skin") { c.fillStyle = "#f4f4f4"; c.beginPath(); c.arc(27, 41, 5, 0, Math.PI * 2); c.fill(); }
    if (layer === "hair") { c.fillStyle = "#e8e8e8"; c.beginPath(); c.arc(29, 40, 4.5, 0, Math.PI * 2); c.fill(); }
    return;
  }
  const y0 = 2 + bob;
  if (layer === "body") {
    // legs
    c.fillStyle = "#9a9a9a";
    c.fillRect(cx - 5, y0 + 32 + Math.min(0, legA), 4, 14 - Math.abs(legA) * 0.3);
    c.fillRect(cx + 1, y0 + 32 + Math.min(0, legB), 4, 14 - Math.abs(legB) * 0.3);
    // boots
    c.fillStyle = "#5a5a5a"; c.fillRect(cx - 6, y0 + 44 + legA * 0.3, 5, 3); c.fillRect(cx + 1, y0 + 44 + legB * 0.3, 5, 3);
    // torso (tunic)
    c.fillStyle = "#dedede";
    c.beginPath(); c.moveTo(cx - 8, y0 + 16); c.lineTo(cx + 8, y0 + 16); c.lineTo(cx + 9, y0 + 36); c.lineTo(cx - 9, y0 + 36); c.closePath(); c.fill();
    c.fillStyle = "#bdbdbd"; c.fillRect(cx - 9, y0 + 28, 18, 2); // belt shade
    // arms (sleeves)
    c.fillStyle = "#c8c8c8";
    if (pray) { c.fillRect(cx - 6, y0 + 18, 4, 9); c.fillRect(cx + 2, y0 + 18, 4, 9); }
    else { c.fillRect(cx - 11, y0 + 17 + armA * 0.4, 4, 13); c.fillRect(cx + 7, y0 + 17 + armB * 0.4, 4, 13); }
  }
  if (layer === "skin") {
    c.fillStyle = "#f6f6f6";
    c.beginPath(); c.arc(cx, y0 + 9, 7, 0, Math.PI * 2); c.fill(); // head
    if (pray) { c.fillRect(cx - 2, y0 + 24, 4, 4); }
    else { c.fillRect(cx - 11, y0 + 29 + armA * 0.4, 4, 4); c.fillRect(cx + 7, y0 + 29 + armB * 0.4, 4, 4); }
    if (!back) { c.fillStyle = "#3a3a3a"; c.fillRect(cx - 3, y0 + 9, 2, 2); c.fillRect(cx + 2, y0 + 9, 2, 2); }
  }
  if (layer === "hair") {
    c.fillStyle = "#ececec";
    c.beginPath(); c.arc(cx, y0 + 7, 7.5, Math.PI, Math.PI * 2); c.fill();
    if (back) { c.beginPath(); c.arc(cx, y0 + 9, 7.2, 0, Math.PI * 2); c.fill(); }
    else { c.fillRect(cx - 7.5, y0 + 6, 2.5, 6); c.fillRect(cx + 5, y0 + 6, 2.5, 6); }
  }
}

function makeCharacters(scene: Phaser.Scene) {
  for (const layer of LAYERS) {
    const key = `char_${layer}`;
    if (scene.textures.exists(key)) continue;
    const tex = scene.textures.createCanvas(key, CHAR_W * CHAR_FRAMES, CHAR_H * 2)!;
    const ctx = tex.getContext();
    for (let row = 0; row < 2; row++)
      for (let f = 0; f < CHAR_FRAMES; f++) {
        ctx.save();
        ctx.translate(f * CHAR_W, row * CHAR_H);
        drawCharFrame(ctx, layer, f, row === 1);
        ctx.restore();
      }
    tex.refresh();
    let i = 0;
    for (let row = 0; row < 2; row++)
      for (let f = 0; f < CHAR_FRAMES; f++) tex.add(i++, 0, f * CHAR_W, row * CHAR_H, CHAR_W, CHAR_H);
  }
  // Animations: `${layer}_${row}_${anim}`
  const defs: Record<string, { frames: number[]; rate: number; repeat: number }> = {
    idle: { frames: [0], rate: 1, repeat: -1 },
    walk: { frames: [1, 2, 3, 4], rate: 8, repeat: -1 },
    work: { frames: [5, 6], rate: 3, repeat: -1 },
    sleep: { frames: [7], rate: 1, repeat: -1 },
    pray: { frames: [8], rate: 1, repeat: -1 },
  };
  for (const layer of LAYERS)
    for (let row = 0; row < 2; row++)
      for (const [name, d] of Object.entries(defs)) {
        const key = `${layer}_${row}_${name}`;
        if (scene.anims.exists(key)) continue;
        scene.anims.create({
          key,
          frames: d.frames.map((f) => ({ key: `char_${layer}`, frame: row * CHAR_FRAMES + f })),
          frameRate: d.rate,
          repeat: d.repeat,
        });
      }
}

function makeKlumnog(scene: Phaser.Scene) {
  canvasTex(scene, "klumnog", 56, 96, (c) => {
    const g = c.createLinearGradient(0, 0, 56, 96);
    g.addColorStop(0, "#c4b0ff"); g.addColorStop(0.5, "#5a36c8"); g.addColorStop(1, "#1e0f4a");
    c.fillStyle = g;
    c.beginPath(); c.moveTo(28, 0); c.lineTo(50, 34); c.lineTo(34, 92); c.lineTo(28, 96); c.lineTo(22, 92); c.lineTo(6, 34); c.closePath(); c.fill();
    c.strokeStyle = "rgba(220,200,255,0.6)"; c.lineWidth = 1.5; c.stroke();
    const core = c.createRadialGradient(28, 38, 1, 28, 38, 14);
    core.addColorStop(0, "#ffffff"); core.addColorStop(0.4, "#a9c8ff"); core.addColorStop(1, "rgba(120,90,255,0)");
    c.fillStyle = core; c.beginPath(); c.arc(28, 38, 14, 0, Math.PI * 2); c.fill();
  });
  canvasTex(scene, "shard", 12, 24, (c) => {
    c.fillStyle = "#7a5ae8"; c.beginPath(); c.moveTo(6, 0); c.lineTo(12, 10); c.lineTo(6, 24); c.lineTo(0, 10); c.closePath(); c.fill();
  });
}

function makeFx(scene: Phaser.Scene) {
  canvasTex(scene, "lightmask", 256, 256, (c) => {
    const g = c.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.5, "rgba(255,255,255,0.75)"); g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g; c.fillRect(0, 0, 256, 256);
  });
  canvasTex(scene, "glow", 128, 128, (c) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,0.9)"); g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  });
  canvasTex(scene, "shadow", 32, 12, (c) => {
    c.fillStyle = "rgba(0,0,0,0.35)"; c.beginPath(); c.ellipse(16, 6, 13, 5, 0, 0, Math.PI * 2); c.fill();
  });
  canvasTex(scene, "ring", 48, 24, (c) => {
    c.strokeStyle = "rgba(255,220,120,0.95)"; c.lineWidth = 2; c.beginPath(); c.ellipse(24, 12, 20, 9, 0, 0, Math.PI * 2); c.stroke();
  });
  canvasTex(scene, "marker", 32, 16, (c) => {
    c.strokeStyle = "rgba(255,255,255,0.8)"; c.lineWidth = 2; c.beginPath(); c.ellipse(16, 8, 12, 5, 0, 0, Math.PI * 2); c.stroke();
  });
  canvasTex(scene, "rain", 2, 12, (c) => { c.fillStyle = "rgba(180,200,230,0.5)"; c.fillRect(0, 0, 1, 12); });
}

export function generateTextures(scene: Phaser.Scene) {
  makeGround(scene);
  makeTrees(scene);
  makeProps(scene);
  makeCharacters(scene);
  makeKlumnog(scene);
  makeFx(scene);
}
