// Network protocol between the Phaser client and the authoritative server.
// JSON over WebSocket. Keep messages small and explicit.

import type { Inventory, ItemId } from "./items.ts";

export type EntityKind = "player" | "npc" | "klumnog";

export type Anim = "idle" | "walk" | "work" | "sleep" | "eat" | "talk" | "jail" | "pray";

export interface Look {
  body: string; // clothes color
  hair: string;
  skin: string;
}

/** Entity as sent in a snapshot. */
export interface EntSnap {
  id: string;
  k: EntityKind;
  n: string; // name
  x: number;
  y: number;
  f: number; // facing 0..7
  a: Anim;
  l: Look;
  /** Short status label shown under the name (e.g. "Лісоруб", "у в'язниці"). */
  s?: string;
  /** Child (rendered smaller). */
  c?: 1;
}

export interface SelfState {
  id: string;
  name: string;
  coins: number;
  inv: Inventory;
  hunger: number; // 0..100 (100 = full)
  energy: number; // 0..100
  jailedUntil: number | null;
  ownedBusinesses: string[];
  job: string | null;
  /** Current long action (gathering, eating ...) with progress 0..1 */
  busy: { label: string; progress: number } | null;
  /** Relationship summary: npc id -> attitude toward the player (-100..100) */
  blessing: boolean;
  /** Family lines: spouse / engagement / pregnancy / children. */
  family: string[];
  /** Skill levels 0..100. */
  skills: Partial<Record<string, number>>;
}

export interface MarketInfo {
  items: { id: ItemId; name: string; stock: number; buy: number; sell: number }[];
}

export interface BusinessInfo {
  id: string;
  name: string;
  kind: string;
  ownerId: string | null;
  ownerName: string;
  forSale: number | null;
  wage: number;
  maxWorkers: number;
  workers: { id: string; name: string; unpaidDays: number }[];
  treasury: number;
  stock: Inventory;
  product: ItemId | null;
  workHours: [number, number];
  areaId: string;
  allowedClasses: string[];
}

export interface DialogOption {
  id: string;
  label: string;
  /** Option needs an extra argument (target person, wage...) chosen by the client. */
  arg?: "person" | "wage" | "text" | "buy";
}

export interface DialogLine { who: string; text: string; id: number; t: number; mine: boolean }

export interface DialogMsg {
  t: "dialog";
  npcId: string;
  npcName: string;
  title: string; // e.g. profession
  /** Conversation lines; `id` is unique & increasing (client uses it for its conversation log). */
  lines: DialogLine[];
  options: DialogOption[];
  /** Persons the player can ask about. */
  persons?: { id: string; name: string }[];
  /** Businesses owned by the player with free slots (for job offers). */
  offerable?: { id: string; name: string; wage: number }[];
  /** Businesses this NPC owns that the player can try to buy; `ask` = price the NPC names. */
  sellable?: { id: string; name: string; ask: number | null }[];
  pending?: boolean;
}

export interface InspectInfo {
  id: string;
  name: string;
  kind: EntityKind;
  faction: string;
  socialClass: string;
  profession: string;
  job: string;
  coins: number;
  needs: Record<string, number>;
  personality: Record<string, number>;
  activity: string;
  goals: string[];
  memories: { t: number; text: string; conf: number; src: string }[];
  relations: { id: string; name: string; trust: number; affection: number; fear: number }[];
  location: string;
  family: string[];
  skills: Partial<Record<string, number>>;
  home: string;
}

export interface PlotInfo {
  id: string;
  stage: "empty" | "site" | "built";
  /** Construction progress 0..100 while a site. */
  progress: number | null;
  materials: string | null;
  kind: "house" | "mine" | "quarry";
  name: string;
  resource: "ore" | "stone" | null;
  /** Deposit units left (mines/quarries). */
  remaining: number | null;
  /** Price to commission (empty mine/quarry plots). */
  cost: number | null;
  /** Waiting in the builders' queue. */
  queued: boolean;
  by: string | null;
}

export interface ChronicleEntry {
  t: number;
  text: string;
  kind: string;
}

// ---- Client -> Server ----
export type C2S =
  | { t: "join"; name: string; token?: string; session?: string; look?: Partial<Look> & { gender?: string } }
  | { t: "input"; seq: number; dx: number; dy: number }
  | { t: "chat"; text: string }
  | { t: "act"; a: "gather" | "eat" | "rest" | "pray" | "cancel" | "plant" }
  | { t: "talk"; npcId: string; opt: string; arg?: string; wage?: number; bizId?: string; price?: number } // opt "keep" = dialog still open (keep-alive)
  | { t: "market"; op: "buy" | "sell"; item: ItemId; qty: number }
  | { t: "openMarket" }
  | { t: "biz"; op: "list" | "buy" | "setWage" | "deposit" | "withdraw" | "fire" | "commission"; bizId?: string; amount?: number; workerId?: string; plotId?: string }
  | { t: "inspect"; id: string }
  | { t: "chronicle" }
  | { t: "pickpocket"; npcId: string }
  | { t: "ping"; ts: number };

// ---- Server -> Client ----
export type S2C =
  | { t: "welcome"; you: string; token: string; time: number; minutesPerSecond: number }
  | { t: "snap"; time: number; ack: number; me: { x: number; y: number } | null; ents: EntSnap[] }
  | { t: "self"; s: SelfState }
  | { t: "chat"; from: string; name: string; text: string; local: boolean }
  | { t: "say"; id: string; text: string }
  | DialogMsg
  | { t: "dialogClose" }
  | { t: "market"; m: MarketInfo }
  | { t: "biz"; list: BusinessInfo[] }
  | { t: "inspect"; info: InspectInfo }
  | { t: "chronicle"; entries: ChronicleEntry[] }
  | { t: "toast"; text: string; kind?: "info" | "good" | "bad" }
  | { t: "teleport"; x: number; y: number }
  | { t: "pong"; ts: number }
  | { t: "plots"; plots: PlotInfo[] }
  /** Tile changes (resource depletion, planting): [x, y, ground, obj] */
  | { t: "tiles"; changes: [number, number, number, number][] }
  | { t: "error"; text: string }
  /** Login required / session expired — the client returns to the sign-in screen. */
  | { t: "authError"; text: string };
