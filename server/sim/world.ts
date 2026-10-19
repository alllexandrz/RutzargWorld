// The authoritative world state + main simulation tick.
// Systems are split across files; they all operate on a World instance.

import { getMap, type GameMap, areaAt } from "../../shared/map.ts";
import { GAME_MINUTES_PER_SECOND, WORLD_START_MINUTE } from "../../shared/constants.ts";
import { ITEM_IDS, ITEMS, type ItemId } from "../../shared/items.ts";
import type { Agent, Being, Business, ChronicleRecord, ConstructionProject, MarketState, Player } from "./types.ts";
import { createAgents, createBusinesses } from "./seed.ts";
import { tickAgents } from "./brain.ts";
import { onHour, onDay } from "./economy.ts";
import { tickNeeds } from "./needs.ts";
import { tickPlayers } from "./players.ts";
import { tickSocial } from "./social.ts";
import { onHourFamily, tickFamily } from "./family.ts";
import { onDayHousing, onHourHousing } from "./construction.ts";
import { initialResources, onHourResources, type ResourceState } from "./resources.ts";

export type WorldListener = {
  say(id: string, text: string): void;
  toast(playerId: string, text: string, kind?: "info" | "good" | "bad"): void;
  teleport(playerId: string, x: number, y: number): void;
  selfChanged(playerId: string): void;
  dialog(playerId: string, npcId: string, lines: { who: string; text: string }[]): void;
  /** A building plot changed stage (map changed) — clients must update their map. */
  plotsChanged(): void;
};

export class World {
  map: GameMap = getMap();
  time = WORLD_START_MINUTE; // game minutes
  agents = new Map<string, Agent>();
  players = new Map<string, Player>();
  businesses = new Map<string, Business>();
  market: MarketState = { stock: {} };
  /** Houses under construction (normally one at a time). */
  projects: ConstructionProject[] = [];
  /** Natural resources, tile changes, deposits. */
  res!: ResourceState;
  /** Tile changes not yet sent to clients: [x, y, ground, obj]. */
  pendingTiles: [number, number, number, number][] = [];
  /** Municipal treasury: funds the market (it buys from sellers) and town-owned businesses. */
  townTreasury = 400;
  chronicle: ChronicleRecord[] = [];
  /** Total number of chronicle records ever written (for incremental streaming). */
  chronicleTotal = 0;
  memorySeq = 1;
  factSeq = 1;
  listener: WorldListener | null = null;

  lastHour = -1;
  lastDay = -1;
  private socialAcc = 0;

  constructor() {
    // Dev/testing: START_HOUR=21 starts a *fresh* world in the evening.
    const startHour = Number(globalThis.process?.env?.START_HOUR);
    if (Number.isFinite(startHour) && startHour >= 0 && startHour < 24) this.time = startHour * 60;
    for (const a of createAgents()) this.agents.set(a.id, a);
    for (const b of createBusinesses()) this.businesses.set(b.id, b);
    this.res = initialResources(this);
    for (const b of this.businesses.values()) for (const w of b.workers) {
      const a = this.agents.get(w);
      if (a) a.jobBiz = b.id;
    }
    for (const id of ITEM_IDS) this.market.stock[id] = Math.round(ITEMS[id].targetStock * 0.8);
    this.syncClock();
    this.log("Світ Rutzarg прокинувся. Каргат, прикордонне містечко Домініону Варон, зустрічає світанок.", "world");
  }

  /** Re-align hour/day boundary trackers with the current time (after loading a save). */
  syncClock() {
    this.lastHour = Math.floor(this.time / 60);
    this.lastDay = Math.floor(this.time / 1440);
  }

  // ---- lookup helpers ----
  being(id: string): Being | undefined {
    return this.agents.get(id) ?? this.players.get(id);
  }

  nameOf(id: string | null | undefined): string {
    if (!id) return "ніхто";
    if (id === "town") return "Громада Каргата";
    return this.being(id)?.name ?? this.businesses.get(id)?.name ?? id;
  }

  areaName(x: number, y: number): string {
    return areaAt(this.map, x, y)?.name ?? "околиці Каргата";
  }

  areaIdAt(x: number, y: number): string {
    return areaAt(this.map, x, y)?.id ?? "outside";
  }

  /** All beings that are physically present in the world (offline players are not). */
  *presentBeings(): Iterable<Being> {
    for (const a of this.agents.values()) yield a;
    for (const p of this.players.values()) if (p.online) yield p;
  }

  isJailed(b: Being): boolean {
    return b.jailedUntil !== null && b.jailedUntil > this.time;
  }

  log(text: string, kind = "event") {
    this.chronicle.push({ t: this.time, text, kind });
    this.chronicleTotal++;
    if (this.chronicle.length > 400) this.chronicle.splice(0, this.chronicle.length - 400);
  }

  say(id: string, text: string) {
    this.listener?.say(id, text);
  }

  toast(playerId: string, text: string, kind: "info" | "good" | "bad" = "info") {
    this.listener?.toast(playerId, text, kind);
  }

  selfChanged(playerId: string) {
    this.listener?.selfChanged(playerId);
  }

  // ---- main tick ----
  /** Advance the simulation by dt real seconds. */
  tick(dt: number) {
    const gdt = dt * GAME_MINUTES_PER_SECOND; // game minutes elapsed
    this.time += gdt;

    tickPlayers(this, dt);
    tickAgents(this, dt);
    tickNeeds(this, gdt);

    this.socialAcc += gdt;
    if (this.socialAcc >= 1) {
      tickSocial(this, this.socialAcc);
      tickFamily(this);
      this.socialAcc = 0;
    }

    const hour = Math.floor(this.time / 60);
    if (hour !== this.lastHour) {
      this.lastHour = hour;
      onHour(this, hour % 24);
      onHourFamily(this, hour % 24);
      onHourHousing(this, hour % 24);
      onHourResources(this);
    }
    const day = Math.floor(this.time / 1440);
    if (day !== this.lastDay) {
      this.lastDay = day;
      onDay(this, day + 1);
      onDayHousing(this);
    }
  }

  marketStock(item: ItemId): number {
    return this.market.stock[item] ?? 0;
  }
}
