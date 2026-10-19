// Persistent world: JSON snapshots on disk (concept §30.1 "Persistent World").
// No player save/load — only server snapshots for crash recovery.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { World } from "./sim/world.ts";
import type { Agent, Business, ChronicleRecord, ConstructionProject, MarketState, Player } from "./sim/types.ts";
import type { PlotStage } from "../shared/map.ts";
import { applyPlot } from "../shared/map.ts";
import { createBusinesses } from "./sim/seed.ts";
import { ITEM_IDS, ITEMS } from "../shared/items.ts";
import { MAP_W } from "../shared/map.ts";
import { applyOverrides, initialResources, type ResourceState } from "./sim/resources.ts";

const SAVE_VERSION = 1;

export interface SaveFile {
  version: number;
  savedAt: string;
  time: number;
  townTreasury: number;
  memorySeq: number;
  factSeq: number;
  agents: Agent[];
  players: Player[];
  businesses: Business[];
  market: MarketState;
  chronicle: ChronicleRecord[];
  projects?: ConstructionProject[];
  res?: ResourceState;
  mapSize?: number;
  plotStage?: Record<string, PlotStage>;
}

/** Serialisable snapshot of the whole world (runtime-only fields stripped). */
export function snapshot(w: World): SaveFile {
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    time: w.time,
    townTreasury: w.townTreasury,
    memorySeq: w.memorySeq,
    factSeq: w.factSeq,
    agents: [...w.agents.values()].map((a) => ({ ...a, path: null, thinking: false })),
    players: [...w.players.values()].map((p) => ({ ...p, online: false, busy: null })),
    businesses: [...w.businesses.values()],
    market: w.market,
    chronicle: w.chronicle,
    projects: w.projects,
    plotStage: w.map.plotStage,
    res: w.res,
    mapSize: MAP_W,
  };
}

export function saveWorld(w: World, file: string) {
  writeSnapshotFile(snapshot(w), file);
}

export function writeSnapshotFile(data: SaveFile, file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file); // atomic replace
}

/** Returns true if a save was loaded. */
export function loadWorld(w: World, file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    return restore(w, JSON.parse(readFileSync(file, "utf8")) as SaveFile);
  } catch (e) {
    console.error("[persist] failed to read save:", e);
    return false;
  }
}

/** Load a snapshot into a freshly created World (with migrations for older saves). */
export function restore(w: World, data: SaveFile): boolean {
  try {
    if (data.version !== SAVE_VERSION) {
      console.warn(`[persist] save version ${data.version} != ${SAVE_VERSION}, starting a fresh world`);
      return false;
    }
    w.time = data.time;
    w.townTreasury = data.townTreasury;
    w.memorySeq = data.memorySeq;
    w.factSeq = data.factSeq;
    w.agents = new Map(data.agents.map((a) => [a.id, { ...a, path: null, thinking: false, nextThinkAt: 0 }]));
    w.players = new Map(data.players.map((p) => [p.id, { ...p, online: false, busy: null, lastInputSeq: 0, inputBudget: 0 }]));
    w.businesses = new Map(data.businesses.map((b) => [b.id, b]));
    w.market = data.market;
    w.chronicle = data.chronicle;
    w.projects = data.projects ?? [];
    // tile overrides are indexed by map width — only valid for the same map size
    if (data.res && data.mapSize === MAP_W) {
      w.res = { ...initialResources(w), ...data.res, deposits: { ...initialResources(w).deposits, ...data.res.deposits } };
      applyOverrides(w);
    }
    // re-apply town growth to the (code-generated) map
    for (const [plotId, stage] of Object.entries(data.plotStage ?? {})) if (stage !== "empty") applyPlot(w.map, plotId, stage);
    // migration: businesses added in newer versions
    for (const b of createBusinesses()) {
      const cur = w.businesses.get(b.id);
      if (!cur) w.businesses.set(b.id, b);
      else if (b.deposit && !cur.deposit) cur.deposit = b.deposit;
    }
    for (const id of ITEM_IDS) if (w.market.stock[id] === undefined) w.market.stock[id] = Math.round(ITEMS[id].targetStock * 0.8);
    for (const a of w.agents.values()) a.skills ??= {};
    for (const p of w.players.values()) p.skills ??= {};
    w.syncClock();
    return true;
  } catch (e) {
    console.error("[persist] failed to load save:", e);
    return false;
  }
}
