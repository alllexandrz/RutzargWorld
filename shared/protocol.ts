// Network protocol between the Phaser client and the authoritative server.
// JSON over WebSocket. Keep messages small and explicit.

import type { Inventory, ItemId, Slot } from "./items.ts";
import type { Equipment } from "./gear.ts";
import type { GameData } from "./gamedata.ts";

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
  /** Visible gear: head, body, weapon, offhand item ids. */
  g?: { h?: ItemId; b?: ItemId; w?: ItemId; o?: ItemId };
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
  /** Worn clothes, weapon/tool and their condition. */
  equip: Equipment;
  stats: { attack: number; armor: number; presence: number; power: number };
  /** Where the player lives (null = nowhere: dozing wherever). */
  home: { area: string; name: string; kind: LodgingKind; price: number; debt: number } | null;
  /** Money owed to townsfolk. */
  debts: { lender: string; lenderId: string; owe: number; due: number; overdueDays: number }[];
  /** Repairs possible right here (next to an anvil / workbench), per worn slot. */
  repairs: { slot: Slot; cost: number; where: string; self: boolean }[];
  /** Stations in reach and what using them costs (someone else's workshop). */
  workshops: { station: string; label: string; owner: string; fee: number; free: boolean }[];
}

/** bed — a rented bed; bench — a place on a bench in a full tavern; house — a whole rented house; own — one's own house. */
export type LodgingKind = "bed" | "bench" | "house" | "own";

export interface LodgingOfferInfo { area: string; name: string; kind: LodgingKind; price: number; landlord: string; free: number; here: boolean }

export interface LodgingInfo {
  current: { area: string; name: string; kind: LodgingKind; price: number; landlord: string; debt: number; since: number; here: boolean } | null;
  offers: LodgingOfferInfo[];
  /** Houses the player owns (commissioned at the residence). */
  owned: { area: string; name: string; letting: boolean; price: number; beds: number; lodgers: string[] }[];
  houseCost: number;
  atResidence: boolean;
}

/** Character sheet (panel I) — the heavier part, sent on request. */
export interface CharInfo {
  name: string;
  gender: "m" | "f";
  socialClass: string;
  faction: string;
  job: string | null;
  businesses: string[];
  roles: string[];
  daysInWorld: number | null;
  location: string;
  /** Speed bonuses from the tool in hand, e.g. { "Деревина": 60 } (%). */
  gather: Record<string, number>;
  reputation: { known: number; friends: number; foes: number; trust: number; respect: number; fear: number; adults: number };
  /** People who think best / worst of you. */
  friends: { name: string; v: number }[];
  foes: { name: string; v: number }[];
  /** What people tell about you: event text + how many believe it. */
  rumors: { text: string; n: number }[];
  lastJailed: number | null;
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
  /** Owner only: books for the last days and the purse top-up setting. */
  ledger?: { day: number; made: number; sold: number; revenue: number; wages: number; unpaid: number; rent?: number; fees?: number }[];
  autoPay?: boolean;
  /** Owner only: where each warehouse item could be sold right now. */
  outlets?: { item: ItemId; name: string; qty: number; marketPrice: number; marketRoom: number; wholesalePrice: number; wholesaleLeft: number }[];
  /** Lumber: currently sawing planks. null = can't process. */
  process?: string | null;
  /** Fee per craft for outsiders using the stations here (null = no workshop). */
  craftFee: number | null;
  /** The tavern: a bed per night. */
  bedRent?: number;
  /** The viewer may set the fees (owner; the reeve for the town's). */
  canSetFees?: boolean;
}

export interface DialogOption {
  id: string;
  label: string;
  /** Option needs an extra argument (target person, wage...) chosen by the client. */
  arg?: "person" | "wage" | "text" | "buy" | "amount";
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
  gear?: string[];
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
  /** Built house with a private owner. */
  owner?: string | null;
}

export interface PoliticsInfo {
  reeve: { id: string; name: string };
  how: "founding" | "elected" | "coup";
  since: number;
  legitimacy: number;      // 0..100
  approval: number;        // -100..100
  taxRate: number;         // 0..0.3
  taxSteps: number[];
  treasury: number;
  nextElection: number;
  youAreReeve: boolean;
  atResidence: boolean;
  election: { reason: "term" | "recall"; endsAt: number; candidates: { id: string; name: string; votes: number }[]; yourVote: string | null; youRun: boolean } | null;
  petition: { count: number; needed: number; signed: boolean };
  /** Guards sworn to you / all guards. */
  plot: { sworn: number; guards: number };
  history: { t: number; text: string }[];
  /** Reeve only. */
  prisoners?: { id: string; name: string; until: number }[];
  townBiz?: { id: string; name: string; wage: number; forSale: number | null; workers: number; maxWorkers: number; privatisable: boolean; value: number }[];
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
  | { t: "biz"; op: "list" | "buy" | "setWage" | "deposit" | "withdraw" | "fire" | "commission" | "autoPay" | "sellStock" | "takeStock" | "process" | "craftFee" | "bedRent";
      bizId?: string; amount?: number; workerId?: string; plotId?: string; item?: ItemId; to?: "market" | "caravan" }
  | { t: "inspect"; id: string }
  | { t: "chronicle" }
  | { t: "pickpocket"; npcId: string }
  /** Craft `n` batches of a recipe (shared/crafting.ts). */
  | { t: "craft"; recipe: string; n?: number }
  /** Put a placeable item from the inventory on a tile. */
  | { t: "place"; item: ItemId; x: number; y: number }
  /** Dismantle the nearest placed thing and take it. */
  | { t: "pickup" }
  /** Put on / take off clothes, weapons, tools. */
  | { t: "equip"; item: ItemId }
  | { t: "unequip"; slot: Slot }
  /** Have the worn thing in a slot fixed at the workshop you stand in. */
  | { t: "repair"; slot: Slot }
  /** Throw away: the thing in a slot, or one copy of an item from the bag. */
  | { t: "discard"; slot?: Slot; item?: ItemId }
  /** Lodging: see offers, rent a bed / a whole house where you stand, move out. */
  | { t: "lodging"; op: "info" | "rent" | "leave" | "letting"; area?: string; kind?: LodgingKind; amount?: number; on?: boolean }
  /** Request the character sheet (S2C "char"). */
  | { t: "charinfo" }
  /** Town politics (panel G). Paperwork needs presence at the residence. */
  | { t: "politics"; op: "info" | "candidate" | "vote" | "sign" | "donate" | "setTax" | "setWage" | "forSale" | "pardon" | "embezzle"; target?: string; amount?: number; bizId?: string }
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
  | { t: "politics"; info: PoliticsInfo }
  | { t: "char"; info: CharInfo }
  | { t: "lodging"; info: LodgingInfo }
  /** Items / recipes / tool rules the server runs with (sent on join and after an editor import). */
  | { t: "gamedata"; data: GameData }
  /** What happened while the player was offline (summary lines first). */
  | { t: "inbox"; items: { t: number; text: string; kind: string }[] }
  | { t: "teleport"; x: number; y: number }
  | { t: "pong"; ts: number }
  | { t: "plots"; plots: PlotInfo[] }
  /** Tile changes (resource depletion, planting): [x, y, ground, obj] */
  | { t: "tiles"; changes: [number, number, number, number][] }
  | { t: "error"; text: string }
  /** Login required / session expired — the client returns to the sign-in screen. */
  | { t: "authError"; text: string };
