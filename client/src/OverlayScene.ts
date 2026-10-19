// Screen-space overlay above the world: night darkness with light sources,
// name labels and speech bubbles (kept un-darkened and un-zoomed).

import Phaser from "phaser";
import { getMap, idx } from "../../shared/map.ts";
import { darkness } from "../../shared/time.ts";
import { toScreen } from "./iso.ts";
import { gameNow, state } from "./state.ts";
import { bus } from "./bus.ts";
import type { WorldScene } from "./WorldScene.ts";

interface Bubble { text: Phaser.GameObjects.Text; until: number }

export class OverlayScene extends Phaser.Scene {
  private dark!: Phaser.GameObjects.RenderTexture;
  private mask!: Phaser.GameObjects.Image;
  private glows: Phaser.GameObjects.Image[] = [];
  private labels = new Map<string, Phaser.GameObjects.Text>();
  private bubbles = new Map<string, Bubble>();
  private map = getMap();

  constructor() { super("overlay"); }

  create() {
    this.dark = this.add.renderTexture(0, 0, this.scale.width, this.scale.height).setOrigin(0, 0).setDepth(0);
    this.mask = this.make.image({ x: 0, y: 0, key: "lightmask", add: false });
    this.scale.on("resize", (s: Phaser.Structs.Size) => this.dark.resize(s.width, s.height));
    bus.on("bubble", (id: string, text: string) => this.showBubble(id, text));
  }

  private world(): WorldScene {
    return this.scene.get("world") as WorldScene;
  }

  private toView(cam: Phaser.Cameras.Scene2D.Camera, wx: number, wy: number) {
    return { x: (wx - cam.worldView.x) * cam.zoom, y: (wy - cam.worldView.y) * cam.zoom };
  }

  update() {
    const ws = this.world();
    if (!ws || !ws.cameras?.main) return;
    const cam = ws.cameras.main;
    const z = cam.zoom;
    const d = darkness(gameNow());
    const myPos = ws.getMyPos();
    const myB = this.map.bld[idx(Math.floor(myPos.x), Math.floor(myPos.y))] ?? -1;

    // --- darkness with light cut-outs ---
    this.dark.clear();
    let gi = 0;
    if (d > 0.02) {
      this.dark.fill(0x070914, Math.min(0.8, d * 0.8));
      const viewW = this.scale.width, viewH = this.scale.height;
      const cut = (wx: number, wy: number, radiusPx: number, strength: number, color?: string) => {
        const p = this.toView(cam, wx, wy);
        const r = radiusPx * z;
        if (p.x < -r || p.y < -r || p.x > viewW + r || p.y > viewH + r) return;
        this.mask.setScale((r * 2) / 256).setAlpha(strength);
        this.dark.erase(this.mask, p.x, p.y);
        if (color) {
          let g = this.glows[gi];
          if (!g) { g = this.add.image(0, 0, "glow").setBlendMode(Phaser.BlendModes.ADD).setDepth(1); this.glows.push(g); }
          const [r0, g0, b0] = color.split(",").map(Number);
          g.setVisible(true).setPosition(p.x, p.y).setScale((r * 1.6) / 128).setAlpha(0.22 * d).setTint(Phaser.Display.Color.GetColor(r0, g0, b0));
          gi++;
        }
      };
      for (const l of this.map.lights) {
        const s = toScreen(l.x, l.y);
        const indoor = this.map.bld[idx(Math.floor(l.x), Math.floor(l.y))];
        if (indoor >= 0 && indoor !== myB) continue; // interior lights only when you're inside
        const flick = 1 + Math.sin(performance.now() / 180 + l.x * 3) * 0.04;
        cut(s.x, s.y - 10, l.r * 34 * flick, 1, l.color);
      }
      // the player always sees a little around themselves; blessed players glow
      const me = toScreen(myPos.x, myPos.y);
      cut(me.x, me.y - 16, state.self?.blessing ? 150 : 90, state.self?.blessing ? 0.9 : 0.55, state.self?.blessing ? "170,140,255" : undefined);
      // Klumnog glow
      for (const lb of ws.labelData()) if (lb.kind === "klumnog" && lb.visible) cut(lb.sx, lb.sy - 40, 120, 0.9, "150,110,255");
    }
    for (let i = gi; i < this.glows.length; i++) this.glows[i].setVisible(false);

    // --- labels ---
    const seen = new Set<string>();
    for (const lb of ws.labelData()) {
      seen.add(lb.id);
      let t = this.labels.get(lb.id);
      if (!t) {
        const color = lb.kind === "me" ? "#ffe08a" : lb.kind === "player" ? "#9fd3ff" : lb.kind === "klumnog" ? "#c9b6ff" : "#e8e0d0";
        t = this.add.text(0, 0, "", { fontFamily: "Georgia, serif", fontSize: "12px", color, align: "center", stroke: "#000", strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(5);
        this.labels.set(lb.id, t);
      }
      const p = this.toView(cam, lb.sx, lb.sy);
      const head = lb.kind === "klumnog" ? 90 : lb.child ? 38 : 54;
      const sel = state.selectedId === lb.id;
      t.setText(sel && lb.status ? `${lb.name}\n${lb.status}` : lb.name);
      const onScreen = p.x > -80 && p.y > 0 && p.x < this.scale.width + 80 && p.y < this.scale.height + 120;
      t.setPosition(p.x, p.y - head * z).setVisible(lb.visible && onScreen);
      const b = this.bubbles.get(lb.id);
      if (b) {
        b.text.setPosition(p.x, p.y - head * z - t.height - 4).setVisible(lb.visible && onScreen);
        if (performance.now() > b.until) { b.text.destroy(); this.bubbles.delete(lb.id); }
      }
    }
    // construction sites
    for (const site of ws.siteLabels()) {
      const key = `site:${site.id}`;
      seen.add(key);
      let t = this.labels.get(key);
      if (!t) {
        t = this.add.text(0, 0, "", { fontFamily: "Georgia, serif", fontSize: "12px", color: "#ffd890", align: "center", stroke: "#000", strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(5);
        this.labels.set(key, t);
      }
      const p = this.toView(cam, site.sx, site.sy);
      t.setText(site.text).setPosition(p.x, p.y - 30 * z);
    }
    for (const [id, t] of this.labels) if (!seen.has(id)) { t.destroy(); this.labels.delete(id); this.bubbles.get(id)?.text.destroy(); this.bubbles.delete(id); }
  }

  showBubble(id: string, text: string) {
    const old = this.bubbles.get(id);
    old?.text.destroy();
    const t = this.add.text(0, 0, text, {
      fontFamily: "Georgia, serif", fontSize: "13px", color: "#1d1710", backgroundColor: "#efe3c8",
      padding: { x: 7, y: 4 }, wordWrap: { width: 220 }, align: "center",
    }).setOrigin(0.5, 1).setDepth(6).setVisible(false);
    this.bubbles.set(id, { text: t, until: performance.now() + 3500 + text.length * 45 });
  }
}
