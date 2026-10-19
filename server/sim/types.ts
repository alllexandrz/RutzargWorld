// Core simulation data types. Plain data (JSON-serialisable) so the world can be
// snapshotted to disk. Behaviour lives in the systems (brain, economy, social ...).

import type { Anim, EntityKind, Look } from "../../shared/protocol.ts";
import type { Inventory, ItemId } from "../../shared/items.ts";
import type { Skills } from "../../shared/skills.ts";

export type SocialClass =
  | "LABOR" | "CRAFT" | "SCHOLAR" | "MILITARY" | "MERCHANT" | "ADMINISTRATIVE" | "ARCANE" | "UNBOUND" | "KLUMNOGI";

export const CLASS_NAMES: Record<SocialClass, string> = {
  LABOR: "Праця", CRAFT: "Ремесло", SCHOLAR: "Вчені", MILITARY: "Військові", MERCHANT: "Купці",
  ADMINISTRATIVE: "Управління", ARCANE: "Магія", UNBOUND: "Вільні", KLUMNOGI: "Клумноги",
};

export type FactionId = "varon" | "sylthar" | "karzin" | "nemar" | "none";

export const FACTION_NAMES: Record<FactionId, string> = {
  varon: "Домініон Варон",
  sylthar: "Ліга Сілтар",
  karzin: "Клани Карзін",
  nemar: "Ковенант Немар",
  none: "—",
};

export interface Personality {
  greed: number;       // 0..1
  courage: number;
  loyalty: number;
  ambition: number;
  lawfulness: number;
  empathy: number;
  sociability: number;
}

/** Attitude of one character toward another. All values -100..100 except debt (coins). */
export interface Relation {
  trust: number;
  affection: number;
  respect: number;
  fear: number;
  /** Coins *I* owe to them (positive) — e.g. a loan from the moneylender. */
  debt: number;
}

export type FactType =
  | "theft" | "jailed" | "released" | "hired" | "quit" | "fired" | "unpaid" | "bought_business"
  | "debt_threat" | "debt_paid" | "gift" | "wage_raise" | "job_offer" | "blessing" | "met"
  | "courting" | "engaged" | "rejected" | "married" | "pregnant" | "birth" | "grew_up"
  | "moved" | "house_started" | "house_built" | "arrived";

/** Something that (supposedly) happened in the world. May be false in a character's head. */
export interface Fact {
  key: string;        // unique id of the real or imagined event
  type: FactType;
  actor?: string;     // who did it
  target?: string;    // to whom
  biz?: string;
  amount?: number;
  place?: string;     // area name
  t: number;          // game minute when it happened (as believed)
}

export interface Memory {
  id: number;
  t: number;              // when the character learned it
  text: string;           // human-readable (from the character's perspective)
  subjects: string[];
  importance: number;     // 0..1
  emotional: number;      // -1..1
  confidence: number;     // 0..1
  source: string;         // "self" (witnessed) or the id of whoever told them
  fact?: Fact;
}

export type ActivityType =
  | "idle" | "go" | "work" | "eat" | "sleep" | "socialize" | "wander" | "seek_job"
  | "steal" | "arrest" | "report" | "collect_debt" | "buy_business" | "jail" | "pray" | "give" | "talk_player" | "borrow"
  | "wedding" | "play" | "date";

export interface Activity {
  type: ActivityType;
  label: string;           // shown to observers ("йде на роботу")
  area?: string;           // destination area id
  target?: string;         // target character id
  biz?: string;
  until?: number;          // game minute when activity ends
  started: number;
  data?: Record<string, unknown>;
}

/** Fields shared by every living being — players and agents use the same systems. */
export interface Being {
  id: string;
  name: string;
  kind: EntityKind;
  gender: "m" | "f";
  x: number;
  y: number;
  facing: number;
  anim: Anim;
  look: Look;
  coins: number;
  inv: Inventory;
  hunger: number;   // 0..100, 100 = full
  energy: number;   // 0..100
  faction: FactionId;
  socialClass: SocialClass;
  jailedUntil: number | null;
  /** Skill levels 0..100 — any being can learn any skill by using it. */
  skills: Skills;
  /** Game minute of the last arrest — the guards' jail register (no double punishment). */
  lastJailedAt?: number;
  jobBiz: string | null;

  // ---- Family (concept §21) ----
  /** Romantic partner before the wedding. */
  partner?: string | null;
  partnerStage?: "dating" | "engaged";
  spouse?: string | null;
  children?: string[];
  parents?: string[];
  /** Set for characters born in the simulation (game minute). */
  bornAt?: number;
  pregnancy?: { father: string; dueAt: number; since: number } | null;
}

export interface Goal {
  id: string;
  text: string;
  priority: number; // 0..1
}

export interface Agent extends Being {
  kind: "npc" | "klumnog";
  title: string;          // profession label
  profession: string;
  home: string;           // area id
  personality: Personality;
  social: number;         // 0..100 social need satisfaction
  relations: Record<string, Relation>;
  memories: Memory[];
  knownFacts: Record<string, number>; // fact key -> memory id
  lastSeen: Record<string, { area: string; t: number }>;
  goals: Goal[];
  activity: Activity;
  /** Current waypoints (runtime only, not persisted). */
  path: { x: number; y: number }[] | null;
  nextThinkAt: number;
  nextGossipAt: number;
  /** A reasoning request is in-flight (LLM or deferred) — don't stack decisions. */
  thinking: boolean;
  importance: "major" | "minor";
  /** Misc. per-agent counters/timestamps (last debt collection day, charity, ...). */
  flags: Record<string, number>;
  /** Klumnogi only: whom they have blessed. */
  blessed?: string[];
}

export interface Player extends Being {
  kind: "player";
  token: string;
  /** Owning account (null/undefined for guest characters). */
  accountId?: string | null;
  online: boolean;
  lastInputSeq: number;
  moveDir: { x: number; y: number };
  inputBudget: number;
  busy: { kind: "gather" | "eat" | "rest" | "pray"; label: string; start: number; dur: number; item?: ItemId; tile?: { x: number; y: number } } | null;
  ownedBusinesses: string[];
  blessing: boolean;
  /** Real-time ms of the last dialogue reward (anti-spam). */
  lastTalkReward: Record<string, number>;
}

export type BusinessKind = "lumber" | "mine" | "quarry" | "farm" | "smithy" | "tavern" | "guard" | "temple" | "admin" | "trade" | "construction";

export interface Business {
  id: string;
  name: string;
  kind: BusinessKind;
  /** Character id, "town" (municipal), or null (nobody / for sale). */
  ownerId: string | null;
  forSale: number | null;
  wage: number;          // coins per worked day
  maxWorkers: number;
  workers: string[];     // includes working owners
  area: string;          // workplace area id
  product: ItemId | null;
  /** Inputs consumed per produced unit. */
  inputs: Partial<Record<ItemId, number>>;
  /** Units produced per worker-hour. */
  rate: number;
  treasury: number;
  stock: Partial<Record<ItemId, number>>;
  allowedClasses: SocialClass[];
  workHours: [number, number];
  unpaidDays: Record<string, number>;
  hoursWorked: Record<string, number>;
  /** Days in a row with an open vacancy (drives wage raises). */
  vacancyDays: number;
  jobTitle: string;
  /** Mines/quarries: id of the finite deposit they dig from. */
  deposit?: string;
  /** Fractional production carried over between hours. */
  carry?: number;
  lastShortageDay?: number;
}

/** A house under construction (world state; the map is updated via shared applyPlot). */
export interface ConstructionProject {
  plotId: string;
  kind?: "house" | "mine" | "quarry";
  startedAt: number;
  /** Materials still required / already delivered to the site. */
  required: Partial<Record<ItemId, number>>;
  delivered: Partial<Record<ItemId, number>>;
  /** 0..1 */
  progress: number;
  /** Total builder-hours needed at skill multiplier 1.0 */
  work: number;
  /** Who requested it ("town" for municipal housing). */
  commissionedBy: string;
}

export interface MarketState {
  stock: Partial<Record<ItemId, number>>;
}

export interface ChronicleRecord {
  t: number;
  text: string;
  kind: string;
}

export function emptyRelation(): Relation {
  return { trust: 0, affection: 0, respect: 0, fear: 0, debt: 0 };
}
