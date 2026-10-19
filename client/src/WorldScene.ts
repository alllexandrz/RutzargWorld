// Main Phaser scene: isometric world rendering, entities, input, client-side prediction.

import Phaser from "phaser";
import { getMap, G, O, MAP_W, MAP_H, idx, applyPlot, setTile, type Building } from "../../shared/map.ts";
import { tileNoise } from "../../shared/rng.ts";
import { stepMove, screenDirToWorld } from "../../shared/move.ts";
import { findPath } from "../../shared/path.ts";
import { INPUT_DT, PLAYER_SPEED, INTERACT_RANGE } from "../../shared/constants.ts";
import type { EntSnap, Anim, PlotInfo } from "../../shared/protocol.ts";
import { TW, TH, toScreen, toWorld, depthOf } from "./iso.ts";
import { generateTextures, groundKey, GROUND_VARIANTS, cubeTex, shade, CHAR_H } from "./textures.ts";
import { net } from "./net.ts";
import { state, pushSnap } from "./state.ts";
import { bus } from "./bus.ts";

const WALL_H = 46;
const WALL_LOW = 12;
const INTERP_DELAY = 120; // ms of interpolation delay for remote entities
const CHUNK = 16; // tiles per chunk side (rendering is chunked & lazy for big maps)

interface BuildingGfx {
  b: Building;
  roofs: Phaser.GameObjects.Image[];
  frontWalls: { img: Phaser.GameObjects.Image; tall: string; low: string; tx: number; ty: number }[];
}

class EntityView {
  container: Phaser.GameObjects.Container;
  layers: Phaser.GameObjects.Sprite[] = [];
  orb: Phaser.GameObjects.Image | null = null;
  ring: Phaser.GameObjects.Image;
  anim = "";
  row = 0;
  x = 0; y = 0; // world (tile units), rendered position
  snap: EntSnap;
  constructor(scene: Phaser.Scene, e: EntSnap) {
    this.snap = e;
    const shadow = scene.add.image(0, 0, "shadow");
    this.ring = scene.add.image(0, 0, "ring").setVisible(false);
    const children: Phaser.GameObjects.GameObject[] = [shadow, this.ring];
    if (e.k === "klumnog") {
      this.orb = scene.add.image(0, -40, "klumnog").setScale(0.8);
      children.push(this.orb);
      scene.tweens.add({ targets: this.orb, y: -50, duration: 2200, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      scene.tweens.add({ targets: this.orb, alpha: 0.75, duration: 1300, yoyo: true, repeat: -1 });
      for (let i = 0; i < 3; i++) {
        const s = scene.add.image(0, -40, "shard").setScale(0.7);
        children.push(s);
        const a0 = (i / 3) * Math.PI * 2;
        scene.tweens.addCounter({
          from: 0, to: Math.PI * 2, duration: 4000, repeat: -1,
          onUpdate: (tw) => { const a = a0 + (tw.getValue() ?? 0); s.setPosition(Math.cos(a) * 26, -44 + Math.sin(a) * 9); s.setDepth(Math.sin(a)); },
        });
      }
    } else {
      for (const layer of ["body", "skin", "hair"] as const) {
        const sp = scene.add.sprite(0, 0, `char_${layer}`, 0).setOrigin(0.5, (CHAR_H - 4) / CHAR_H);
        sp.setTint(Phaser.Display.Color.HexStringToColor(layer === "body" ? e.l.body : layer === "skin" ? e.l.skin : e.l.hair).color);
        this.layers.push(sp);
        children.push(sp);
      }
    }
    this.container = scene.add.container(0, 0, children);
    this.container.setSize(32, 52);
    this.container.setScale(e.c ? 0.65 : 1);
    this.x = e.x; this.y = e.y;
    this.apply(e);
  }

  apply(e: EntSnap) {
    this.snap = e;
    this.container?.setScale(e.c ? 0.65 : 1);
    if (!this.layers.length) return;
    const ang = (e.f * Math.PI) / 4;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const sdx = dx - dy, sdy = (dx + dy) / 2;
    const row = sdy < -0.05 ? 1 : 0;
    const flip = sdx < -0.05;
    const anim = mapAnim(e.a);
    if (anim !== this.anim || row !== this.row) {
      this.anim = anim; this.row = row;
      const layerNames = ["body", "skin", "hair"];
      this.layers.forEach((sp, i) => sp.play(`${layerNames[i]}_${row}_${anim}`, true));
    }
    for (const sp of this.layers) sp.setFlipX(flip);
  }

  place(x: number, y: number) {
    this.x = x; this.y = y;
    const s = toScreen(x, y);
    this.container.setPosition(s.x, s.y);
    this.container.setDepth(depthOf(x, y, 3));
  }

  destroy() { this.container.destroy(); }
}

function mapAnim(a: Anim): string {
  switch (a) {
    case "walk": return "walk";
    case "work": return "work";
    case "sleep": return "sleep";
    case "pray": return "pray";
    case "eat": return "work";
    default: return "idle";
  }
}

export class WorldScene extends Phaser.Scene {
  map = getMap();
  views = new Map<string, EntityView>();
  buildings: BuildingGfx[] = [];
  plotInfo = new Map<string, PlotInfo>();
  insideBuilding = -2;

  // prediction
  myPos = { x: 0, y: 0 };
  renderPos = { x: 0, y: 0 };
  hasPos = false;
  seq = 0;
  pending: { seq: number; dx: number; dy: number }[] = [];
  acc = 0;
  clickPath: { x: number; y: number }[] | null = null;
  marker!: Phaser.GameObjects.Image;
  keys!: Record<string, Phaser.Input.Keyboard.Key>;

  constructor() { super("world"); }

  create() {
    state.sceneReady = true;
    generateTextures(this);
    this.buildGround();
    this.buildObjects();
    this.applyTiles(state.tiles);
    this.applyPlots(state.plots);
    this.marker = this.add.image(0, 0, "marker").setVisible(false).setDepth(-1000);

    const cam = this.cameras.main;
    cam.setBackgroundColor("#0d0f12");
    const left = toScreen(0, MAP_H).x, right = toScreen(MAP_W, 0).x;
    cam.setBounds(left - 200, -200, right - left + 400, toScreen(MAP_W, MAP_H).y + 400);
    cam.setZoom(window.devicePixelRatio > 1.5 ? 1.25 : 1);
    cam.setRoundPixels(false);

    this.keys = this.input.keyboard!.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT", false) as Record<string, Phaser.Input.Keyboard.Key>;
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => this.onPointer(p));
    this.input.on("wheel", (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.5, 2.5));
    });

    net.on((m) => {
      if (m.t === "snap") {
        state.time = m.time; state.timeAt = performance.now();
        pushSnap(m.ents);
        if (m.me) this.reconcile(m.me, m.ack);
      } else if (m.t === "teleport") {
        this.myPos = { x: m.x, y: m.y }; this.renderPos = { ...this.myPos };
        this.pending = []; this.clickPath = null;
      } else if (m.t === "say") {
        bus.emit("bubble", m.id, m.text);
      } else if (m.t === "plots") {
        this.applyPlots(m.plots);
      } else if (m.t === "tiles") {
        this.applyTiles(m.changes);
      }
    });

    this.scene.launch("overlay");
    bus.on("walkTo", (x: number, y: number) => this.walkTo(x, y));
  }

  // ---------------------------------------------------------------------------
  // Static world
  // ---------------------------------------------------------------------------

  // ---- Chunked world: only chunks near the camera exist as GPU textures / game objects ----
  private chunks = new Map<string, { cx: number; cy: number; rt: Phaser.GameObjects.RenderTexture; left: number; top: number; objs: Map<number, Phaser.GameObjects.GameObject[]> }>();
  private lastChunkCheck = 0;

  private chunkBox(cx: number, cy: number) {
    const x0 = cx * CHUNK, y0 = cy * CHUNK;
    const left = toScreen(x0, y0 + CHUNK).x - TW / 2 - 2;
    const right = toScreen(x0 + CHUNK, y0).x + TW / 2 + 2;
    const top = toScreen(x0, y0).y - 2;
    const bottom = toScreen(x0 + CHUNK, y0 + CHUNK).y + TH + 2;
    return { left, top, right, bottom };
  }

  private buildGround() { /* ground is drawn per chunk on demand (see updateChunks) */ }

  private buildObjects() {
    this.buildings = this.map.buildings.map((b) => ({ b, roofs: [], frontWalls: [] }));
    cubeTex(this, "townwall", 34, { top: "#77736a", left: "#5d5a53", right: "#4a4741", crenel: true });
  }

  /** Create/destroy chunks depending on the camera view (with hysteresis). */
  private updateChunks(force = false) {
    const now = performance.now();
    if (!force && now - this.lastChunkCheck < 200) return;
    this.lastChunkCheck = now;
    const v = this.cameras.main.worldView;
    const near = (box: { left: number; top: number; right: number; bottom: number }, m: number) =>
      box.right > v.x - m && box.left < v.right + m && box.bottom > v.y - m - 140 && box.top < v.bottom + m;
    const nCx = Math.ceil(MAP_W / CHUNK), nCy = Math.ceil(MAP_H / CHUNK);
    for (let cy = 0; cy < nCy; cy++)
      for (let cx = 0; cx < nCx; cx++) {
        const key = `${cx},${cy}`;
        const box = this.chunkBox(cx, cy);
        const loaded = this.chunks.get(key);
        if (!loaded && near(box, 350)) this.loadChunk(cx, cy);
        else if (loaded && !near(box, 1100)) this.unloadChunk(key);
      }
  }

  private loadChunk(cx: number, cy: number) {
    const box = this.chunkBox(cx, cy);
    const rt = this.add.renderTexture(box.left, box.top, Math.ceil(box.right - box.left), Math.ceil(box.bottom - box.top)).setOrigin(0, 0).setDepth(-100000);
    const chunk = { cx, cy, rt, left: box.left, top: box.top, objs: new Map<number, Phaser.GameObjects.GameObject[]>() };
    this.chunks.set(`${cx},${cy}`, chunk);
    rt.beginDraw();
    for (let y = cy * CHUNK; y < Math.min(MAP_H, cy * CHUNK + CHUNK); y++)
      for (let x = cx * CHUNK; x < Math.min(MAP_W, cx * CHUNK + CHUNK); x++) this.drawGroundTile(chunk, x, y, true);
    rt.endDraw();
    for (let y = cy * CHUNK; y < Math.min(MAP_H, cy * CHUNK + CHUNK); y++)
      for (let x = cx * CHUNK; x < Math.min(MAP_W, cx * CHUNK + CHUNK); x++) {
        const objs = this.buildTile(x, y);
        if (objs.length) chunk.objs.set(idx(x, y), objs);
      }
    this.insideBuilding = -2; // new walls/roofs must reflect the current inside-view
  }

  private unloadChunk(key: string) {
    const c = this.chunks.get(key);
    if (!c) return;
    c.rt.destroy();
    for (const list of c.objs.values()) for (const o of list) { this.tweens.killTweensOf(o); o.destroy(); }
    this.chunks.delete(key);
    for (const g of this.buildings) {
      g.roofs = g.roofs.filter((r) => r.active);
      g.frontWalls = g.frontWalls.filter((f) => f.img.active);
    }
  }

  private drawGroundTile(chunk: { rt: Phaser.GameObjects.RenderTexture; left: number; top: number }, x: number, y: number, batch = false) {
    const s = toScreen(x, y);
    const g = this.map.ground[idx(x, y)];
    const v = Math.floor(tileNoise(x, y, 1) * GROUND_VARIANTS);
    const px = s.x - TW / 2 - chunk.left - 1, py = s.y - chunk.top - 1;
    if (batch) chunk.rt.batchDraw(groundKey(g, v), px, py);
    else chunk.rt.draw(groundKey(g, v), px, py);
  }

  /** A tile changed on the map (resource depleted, sapling planted, plot built): redraw it. */
  refreshTile(x: number, y: number) {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return;
    const c = this.chunks.get(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`);
    if (!c) return; // not loaded: it will be built from the current map when it comes into view
    const i = idx(x, y);
    for (const o of c.objs.get(i) ?? []) { this.tweens.killTweensOf(o); o.destroy(); }
    c.objs.delete(i);
    for (const g of this.buildings) {
      g.roofs = g.roofs.filter((r) => r.active);
      g.frontWalls = g.frontWalls.filter((f) => f.img.active);
    }
    this.drawGroundTile(c, x, y);
    const objs = this.buildTile(x, y);
    if (objs.length) c.objs.set(i, objs);
    this.insideBuilding = -2;
  }

  /** Apply a batch of server tile changes. */
  applyTiles(changes: [number, number, number, number][]) {
    for (const [x, y, g, o] of changes) if (setTile(this.map, x, y, g, o)) this.refreshTile(x, y);
    bus.emit("tilesChanged", changes);
  }

  /** Create the visuals standing on one tile. Returns created objects (used to rebuild tiles). */
  private buildTile(tx: number, ty: number): Phaser.GameObjects.GameObject[] {
    const map = this.map;
    const out: Phaser.GameObjects.GameObject[] = [];
    const img = (x: number, y: number, key: string) => { const im = this.add.image(x, y, key); out.push(im); return im; };
    const i = idx(tx, ty);
    const o = map.obj[i];
    const s = toScreen(tx, ty); // tile top corner
    const cx = s.x, cy = s.y + TH / 2; // tile center
    const depth = depthOf(tx + 0.5, ty + 0.5);
    const bi = map.bld[i];

    if (bi >= 0) {
      const g = this.buildings[bi];
      const b = g.b;
      if (o === O.WALL) {
        const front = ty === b.y + b.h - 1 || tx === b.x + b.w - 1;
        const nearDoorL = ty === b.y + b.h - 1 && Math.abs(tx - b.door.x) === 1 && b.door.y === ty;
        const tall = cubeTex(this, `wall_${b.id}_${front ? 1 : 0}`, WALL_H, {
          top: shade(b.roofColor, -0.1), left: shade(b.wallColor, -0.05), right: shade(b.wallColor, -0.3),
          beams: true, windows: front && (tx + ty) % 3 === 0 && !nearDoorL,
        });
        const wall = img(s.x, s.y - WALL_H, tall).setOrigin(0.5, 0).setDepth(depth);
        if (front) {
          const low = cubeTex(this, `walllow_${b.id}`, WALL_LOW, { top: shade(b.wallColor, 0.1), left: shade(b.wallColor, -0.05), right: shade(b.wallColor, -0.3) });
          g.frontWalls.push({ img: wall, tall, low, tx, ty });
        }
      } else {
        // roof cube over interior tile (stepped gable along the longer axis)
        const alongX = b.w >= b.h;
        const span = alongX ? b.h : b.w;
        const pos = alongX ? ty - b.y : tx - b.x;
        const centre = (span - 1) / 2;
        const t = 1 - Math.abs(pos - centre) / Math.max(1, centre);
        const h = WALL_H + Math.round(t * 3) * 7;
        const key = cubeTex(this, `roof_${b.id}_${h}`, h, {
          top: shade(b.roofColor, 0.08 * (t - 0.5)), left: shade(b.roofColor, -0.25), right: shade(b.roofColor, -0.42),
        });
        g.roofs.push(img(s.x, s.y - h, key).setOrigin(0.5, 0).setDepth(depth + 1));
      }
    }

    switch (o) {
      case O.TOWN_WALL: img(s.x, s.y - 34, "townwall").setOrigin(0.5, 0).setDepth(depth); break;
      case O.TREE: {
        const v = Math.floor(tileNoise(tx, ty, 9) * 3);
        const sc = 0.85 + tileNoise(tx, ty, 4) * 0.35;
        img(cx + (tileNoise(tx, ty, 5) - 0.5) * 8, cy + 6, `tree_${v}`).setOrigin(0.5, 0.92).setScale(sc).setDepth(depth);
        break;
      }
      case O.ROCK: img(cx, cy + 6, "rock").setOrigin(0.5, 0.82).setDepth(depth); break;
      case O.ORE_ROCK: img(cx, cy + 6, "ore").setOrigin(0.5, 0.82).setDepth(depth); break;
      case O.STALL: img(cx, cy + 6, "stall").setOrigin(0.5, 0.86).setDepth(depth); break;
      case O.TABLE: img(cx, cy + 4, "table").setOrigin(0.5, 0.8).setDepth(depth); break;
      case O.COUNTER: img(cx, cy + 4, "counter").setOrigin(0.5, 0.78).setDepth(depth); break;
      case O.BED: img(cx, cy + 4, "bed").setOrigin(0.5, 0.75).setDepth(depth); break;
      case O.ANVIL: img(cx, cy + 4, "anvil").setOrigin(0.5, 0.8).setDepth(depth); break;
      case O.ALTAR: img(cx, cy + 4, "altar").setOrigin(0.5, 0.82).setDepth(depth); break;
      case O.CRATE: img(cx, cy + 4, "crate").setOrigin(0.5, 0.86).setDepth(depth); break;
      case O.BARREL: img(cx, cy + 4, "barrel").setOrigin(0.5, 0.86).setDepth(depth); break;
      case O.WELL: img(cx, cy + 4, "well").setOrigin(0.5, 0.8).setDepth(depth); break;
      case O.PILLAR: img(cx, cy + 6, "pillar").setOrigin(0.5, 0.92).setDepth(depth); break;
      case O.FENCE: img(cx, cy + 4, "fence").setOrigin(0.5, 0.8).setDepth(depth); break;
      case O.LAMP: img(cx, cy + 4, "lamp").setOrigin(0.5, 0.92).setDepth(depth); break;
      case O.HERB: img(cx, cy + 4, "herb").setOrigin(0.5, 0.82).setDepth(depth - 4); break;
      case O.LOGS: img(cx, cy + 4, "logs").setOrigin(0.5, 0.84).setDepth(depth); break;
      case O.BENCH: img(cx, cy + 4, "bench").setOrigin(0.5, 0.78).setDepth(depth); break;
      case O.FORGE: img(cx, cy + 4, "forge").setOrigin(0.5, 0.86).setDepth(depth); break;
      case O.HEARTH: img(cx, cy + 4, "hearth").setOrigin(0.5, 0.86).setDepth(depth); break;
      case O.BARS: img(cx, cy + 8, "bars").setOrigin(0.5, 0.86).setDepth(depth); break;
      case O.SCAFFOLD: img(cx, cy + 4, "scaffold").setOrigin(0.5, 0.9).setDepth(depth); break;
      case O.STUMP: img(cx, cy + 4, "stump").setOrigin(0.5, 0.8).setDepth(depth - 2); break;
      case O.SAPLING: img(cx, cy + 4, "sapling").setOrigin(0.5, 0.9).setDepth(depth); break;
      default: break;
    }
    if (map.ground[i] === G.WATER && tileNoise(tx, ty, 2) < 0.15) {
      const glint = img(cx, cy, "glow").setScale(0.12).setAlpha(0.25).setDepth(-90000).setTint(0x9fd0ff);
      this.tweens.add({ targets: glint, alpha: 0.05, duration: 1200 + tileNoise(tx, ty, 3) * 1500, yoyo: true, repeat: -1 });
    }
    return out;
  }

  /** Apply server plot states: change the shared map and rebuild the plot's visuals. */
  private applyPlots(plots: PlotInfo[]) {
    for (const pi of plots) {
      this.plotInfo.set(pi.id, pi);
      const plot = this.map.plots.find((p) => p.id === pi.id);
      if (!plot || !applyPlot(this.map, pi.id, pi.stage)) continue;
      const g = this.buildings[plot.buildingId];
      for (const r of g.roofs) r.destroy();
      for (const f of g.frontWalls) f.img.destroy();
      g.roofs = []; g.frontWalls = [];
      for (let y = plot.y - 1; y <= plot.y + plot.h; y++)
        for (let x = plot.x - 1; x <= plot.x + plot.w; x++) this.refreshTile(x, y);
      bus.emit("tilesChanged", []);
    }
  }

  private setInside(bid: number) {
    if (bid === this.insideBuilding) return;
    this.insideBuilding = bid;
    for (const g of this.buildings) {
      const inside = g.b.id === bid;
      for (const r of g.roofs) r.setVisible(!inside);
      for (const fw of g.frontWalls) {
        const s = toScreen(fw.tx, fw.ty);
        if (inside) fw.img.setTexture(fw.low).setPosition(s.x, s.y - WALL_LOW);
        else fw.img.setTexture(fw.tall).setPosition(s.x, s.y - WALL_H);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Input + prediction
  // ---------------------------------------------------------------------------

  private typing(): boolean {
    const el = document.activeElement;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
  }

  private inputDir(): { x: number; y: number } {
    const k = this.keys;
    let sx = 0, sy = 0;
    if (!this.typing()) {
      if (k.A.isDown || k.LEFT.isDown) sx -= 1;
      if (k.D.isDown || k.RIGHT.isDown) sx += 1;
      if (k.W.isDown || k.UP.isDown) sy -= 1;
      if (k.S.isDown || k.DOWN.isDown) sy += 1;
    }
    if (sx || sy) { this.clickPath = null; this.marker.setVisible(false); return screenDirToWorld(sx, sy); }
    if (this.clickPath && this.clickPath.length) {
      const wp = this.clickPath[0];
      const dx = wp.x - this.myPos.x, dy = wp.y - this.myPos.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.12) { this.clickPath.shift(); if (!this.clickPath.length) { this.clickPath = null; this.marker.setVisible(false); } return this.inputDir(); }
      return { x: dx / d, y: dy / d };
    }
    return { x: 0, y: 0 };
  }

  private reconcile(server: { x: number; y: number }, ack: number) {
    if (!this.hasPos) {
      this.hasPos = true;
      this.myPos = { ...server }; this.renderPos = { ...server };
      this.cameras.main.centerOn(toScreen(server.x, server.y).x, toScreen(server.x, server.y).y);
    }
    this.pending = this.pending.filter((p) => p.seq > ack);
    const pos = { ...server };
    for (const p of this.pending) stepMove(this.map, pos, p.dx, p.dy, PLAYER_SPEED, INPUT_DT);
    const err = Math.hypot(pos.x - this.myPos.x, pos.y - this.myPos.y);
    if (err > 0.01) this.myPos = pos;
  }

  private onPointer(p: Phaser.Input.Pointer) {
    if (!p.leftButtonDown() && !p.rightButtonDown()) return;
    const wp = this.cameras.main.getWorldPoint(p.x, p.y);
    // Entity hit test (sprites stand ~40px above their feet)
    let hit: EntityView | null = null, best = 30;
    for (const v of this.views.values()) {
      if (!v.container.visible || v.snap.id === state.myId) continue;
      const s = toScreen(v.x, v.y);
      const d = Math.hypot(wp.x - s.x, wp.y - (s.y - 24));
      if (d < best) { best = d; hit = v; }
    }
    if (hit) {
      state.selectedId = hit.snap.id;
      bus.emit("select", hit.snap.id);
      const near = Math.hypot(hit.x - this.myPos.x, hit.y - this.myPos.y) < INTERACT_RANGE;
      if (!near && p.leftButtonDown()) this.walkTo(hit.x, hit.y);
      return;
    }
    const w = toWorld(wp.x, wp.y);
    this.walkTo(w.x, w.y);
  }

  walkTo(x: number, y: number) {
    const path = findPath(this.map, this.myPos, { x, y });
    if (!path) return;
    this.clickPath = path;
    const last = path[path.length - 1];
    const s = toScreen(last.x, last.y);
    this.marker.setPosition(s.x, s.y).setVisible(true);
  }

  // ---------------------------------------------------------------------------
  // Frame update
  // ---------------------------------------------------------------------------

  update(_time: number, delta: number) {
    const dt = Math.min(0.1, delta / 1000);
    // fixed-step inputs (same step size the server simulates)
    if (this.hasPos) {
      this.acc += dt;
      while (this.acc >= INPUT_DT) {
        this.acc -= INPUT_DT;
        const d = this.inputDir();
        if (Math.abs(d.x) > 1e-3 || Math.abs(d.y) > 1e-3) {
          const seq = ++this.seq;
          net.send({ t: "input", seq, dx: d.x, dy: d.y });
          this.pending.push({ seq, dx: d.x, dy: d.y });
          if (this.pending.length > 60) this.pending.shift();
          stepMove(this.map, this.myPos, d.x, d.y, PLAYER_SPEED, INPUT_DT);
        }
      }
      // smooth visual position toward predicted position
      const k = 1 - Math.pow(0.0001, dt);
      this.renderPos.x += (this.myPos.x - this.renderPos.x) * k;
      this.renderPos.y += (this.myPos.y - this.renderPos.y) * k;
      if (Math.hypot(this.myPos.x - this.renderPos.x, this.myPos.y - this.renderPos.y) > 3) this.renderPos = { ...this.myPos };
    }

    this.updateChunks();
    state.myPos = this.myPos;
    const myB = this.hasPos ? this.map.bld[idx(Math.floor(this.myPos.x), Math.floor(this.myPos.y))] : -1;
    this.setInside(myB);
    this.updateEntities(myB);

    if (this.hasPos) {
      const s = toScreen(this.renderPos.x, this.renderPos.y);
      const cam = this.cameras.main;
      const tx = s.x - cam.width / 2, ty = s.y - 30 - cam.height / 2;
      cam.scrollX += (tx - cam.scrollX) * Math.min(1, dt * 6);
      cam.scrollY += (ty - cam.scrollY) * Math.min(1, dt * 6);
    }
  }

  private updateEntities(myB: number) {
    const snaps = state.snaps;
    if (!snaps.length) return;
    const renderAt = performance.now() - INTERP_DELAY;
    let a = snaps[0], b = snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].at <= renderAt) { a = snaps[i - 1]; b = snaps[i]; break; }
    }
    const span = Math.max(1, b.at - a.at);
    const t = Phaser.Math.Clamp((renderAt - a.at) / span, 0, 1);
    const latest = snaps[snaps.length - 1].ents;

    for (const [id, e] of latest) {
      let v = this.views.get(id);
      if (!v) { v = new EntityView(this, e); this.views.set(id, v); }
      v.apply(e);
      let x: number, y: number;
      if (id === state.myId) {
        x = this.renderPos.x; y = this.renderPos.y;
        // local facing/anim from prediction for responsiveness
        if (this.pending.length && v.layers.length) {
          const last = this.pending[this.pending.length - 1];
          const f = Math.round(Math.atan2(last.dy, last.dx) / (Math.PI / 4));
          v.apply({ ...e, a: "walk", f: ((f % 8) + 8) % 8 });
        }
      } else {
        const ea = a.ents.get(id) ?? e, eb = b.ents.get(id) ?? e;
        x = ea.x + (eb.x - ea.x) * t; y = ea.y + (eb.y - ea.y) * t;
        if (Math.hypot(eb.x - ea.x, eb.y - ea.y) > 3) { x = eb.x; y = eb.y; }
      }
      v.place(x, y);
      // Characters inside other buildings are hidden from view (roofs are opaque).
      const eb2 = this.map.bld[idx(Math.floor(x), Math.floor(y))];
      v.container.setVisible(eb2 < 0 || eb2 === myB || id === state.myId);
      v.ring.setVisible(state.selectedId === id);
    }
    for (const [id, v] of this.views) if (!latest.has(id)) { v.destroy(); this.views.delete(id); }
  }

  /** For the overlay scene: entity label positions in world pixels. */
  labelData(): { id: string; name: string; status?: string; kind: string; sx: number; sy: number; visible: boolean; child: boolean }[] {
    const out = [];
    for (const v of this.views.values()) {
      const s = toScreen(v.x, v.y);
      out.push({ id: v.snap.id, name: v.snap.n, status: v.snap.s, kind: v.snap.id === state.myId ? "me" : v.snap.k, sx: s.x, sy: s.y, visible: v.container.visible, child: !!v.snap.c });
    }
    return out;
  }

  /** Construction sites with progress (for overlay labels). */
  siteLabels(): { id: string; text: string; sx: number; sy: number }[] {
    const out = [];
    for (const p of this.map.plots) {
      const info = this.plotInfo.get(p.id);
      if (!info || info.stage !== "site") continue;
      const s = toScreen(p.x + p.w / 2, p.y + p.h / 2);
      out.push({ id: p.id, text: `🔨 Будова ${info.progress ?? 0}%\n${info.materials ?? ""}`, sx: s.x, sy: s.y });
    }
    return out;
  }

  getMyPos() { return this.myPos; }
}
