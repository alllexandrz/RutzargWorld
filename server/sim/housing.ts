// Lodging and rent (concept: everyone lives somewhere, and somebody owns every roof).
//  - Every home has an owner: a resident, the town, or a business (the tavern rents beds by the night).
//  - Living in someone else's home costs money every night: a bed (койкомісце) or a whole house.
//  - NPCs and players pay by the same rules; arrears turn into debt and, eventually, eviction.
//  - Crafting at a station in someone else's premises costs the fee the owner sets (workshopFee).

import type { World } from "./world.ts";
import type { Agent, Being, Business, Home, Player } from "./types.ts";
import { bedsIn, idx, areaContains } from "../../shared/map.ts";
import { homeAreas, residents } from "./construction.ts";
import { isChild } from "./family.ts";
import { adjustRel, learnFact, newFact } from "./social.ts";
import { ledgerToday } from "./economy.ts";
import { STATION_OBJ } from "../../shared/crafting.ts";

const SHARED = new Set(["tavern", "temple", "residence"]);
/** The town's houses: rent for a whole house and for one bed, per night. */
const TOWN_HOUSE_RENT = 8, TOWN_BED_RENT = 2;
/** Nights of unpaid rent a landlord tolerates. */
const PATIENCE_NIGHTS = 3;

// ---------------------------------------------------------------------------
// Who owns what
// ---------------------------------------------------------------------------

/** Create records for homes that don't have one yet (new world, old save, a newly built house). */
export function ensureHomes(w: World) {
  for (const id of homeAreas(w)) {
    const cur = w.homes[id];
    if (cur) {
      // an owner who moved out lets the empty house as a whole
      const owner = cur.owner ? w.agents.get(cur.owner) : undefined;
      if (owner && owner.home !== id && cur.houseRent === null && !residents(w, id).length) cur.houseRent = 5 + Math.round(owner.personality.greed * 4);
      continue;
    }
    if (id === "tavern") { w.homes[id] = { owner: null, biz: "tavern", bedRent: 0, houseRent: null, tenant: null, rentable: true }; continue; }
    if (SHARED.has(id)) { w.homes[id] = { owner: "town", bedRent: 0, houseRent: null, tenant: null, rentable: false }; continue; }
    const people = residents(w, id).filter((a) => !isChild(w, a));
    const builtByTown = w.map.plots.some((p) => p.id === id);
    if (builtByTown || !people.length) {
      w.homes[id] = { owner: "town", bedRent: TOWN_BED_RENT, houseRent: people.length ? null : TOWN_HOUSE_RENT, tenant: null, rentable: true };
      continue;
    }
    // the head of the household (richest adult) owns the house; others rent a bed from them
    const head = [...people].sort((a, b) => b.coins - a.coins)[0];
    w.homes[id] = { owner: head.id, bedRent: 2 + Math.round(head.personality.greed * 2), houseRent: null, tenant: null, rentable: true };
  }
  const tavern = w.businesses.get("tavern");
  if (tavern && tavern.bedRent === undefined) tavern.bedRent = defaultBedRent(w, tavern);
}

function defaultBedRent(w: World, b: Business): number {
  const owner = b.ownerId ? w.agents.get(b.ownerId) : undefined;
  return owner ? 2 + Math.round(owner.personality.greed * 2) : 3;
}

export function bedPrice(w: World, area: string): number {
  const h = w.homes[area];
  if (!h) return 0;
  if (h.biz) return w.businesses.get(h.biz)?.bedRent ?? 3;
  return h.bedRent;
}

/** Who gets the rent: a business (its till), the town, or a person. */
function landlord(w: World, h: Home): { kind: "biz"; biz: Business } | { kind: "town" } | { kind: "person"; b: Being } | null {
  if (h.biz) { const biz = w.businesses.get(h.biz); return biz ? { kind: "biz", biz } : null; }
  if (h.owner === "town") return { kind: "town" };
  const b = h.owner ? w.being(h.owner) : undefined;
  return b ? { kind: "person", b } : null;
}

export function landlordName(w: World, area: string): string {
  const h = w.homes[area];
  if (!h) return "—";
  const l = landlord(w, h);
  if (!l) return "—";
  return l.kind === "biz" ? `${l.biz.name} (${w.nameOf(l.biz.ownerId ?? "town")})` : l.kind === "town" ? "громада" : l.b.name;
}

function receive(w: World, h: Home, amount: number, kind: "rent" | "fee") {
  const l = landlord(w, h);
  if (!l || amount <= 0) return;
  if (l.kind === "biz") {
    l.biz.treasury += amount;
    const d = ledgerToday(w, l.biz);
    if (kind === "rent") d.rent = (d.rent ?? 0) + amount; else d.fees = (d.fees ?? 0) + amount;
  } else if (l.kind === "town") w.townTreasury += amount;
  else { l.b.coins += amount; w.selfChanged(l.b.id); }
}

function family(a: Being, other: string): boolean {
  return a.id === other || a.spouse === other || !!a.parents?.includes(other) || !!a.children?.includes(other);
}

/** Lives there for free: the owner, the whole-house tenant, their families; staff of the business that runs it. */
export function livesFree(w: World, b: Being, area: string): boolean {
  const h = w.homes[area];
  if (!h || (!h.rentable && !h.biz)) return true;
  if (h.owner && h.owner !== "town" && family(b, h.owner)) return true;
  if (h.tenant && family(b, h.tenant)) return true;
  if (h.biz) { const biz = w.businesses.get(h.biz); if (biz && (biz.ownerId === b.id || biz.workers.includes(b.id))) return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Beds: NPC residents + players who rent there
// ---------------------------------------------------------------------------

export function playerLodgers(w: World, area: string): Player[] {
  return [...w.players.values()].filter((p) => p.lodging?.area === area);
}

/** A house rented whole by a player is closed to newcomers. */
export function closedToNewcomers(w: World, area: string): boolean {
  const t = w.homes[area]?.tenant;
  return !!t && w.players.has(t);
}

// ---------------------------------------------------------------------------
// Offers and renting (players)
// ---------------------------------------------------------------------------

export interface LodgingOffer { area: string; name: string; kind: "bed" | "house"; price: number; landlord: string; free: number; here: boolean }

export function freeBedsFor(w: World, area: string, bedsUsedNpc: number): number {
  return bedsIn(w.map, area) - bedsUsedNpc - playerLodgers(w, area).filter((p) => p.lodging!.kind === "bed").length;
}

export function lodgingOffers(w: World, p: Player, bedsUsedNpc: (area: string) => number): LodgingOffer[] {
  const out: LodgingOffer[] = [];
  for (const [area, h] of Object.entries(w.homes)) {
    if (!h.rentable || !w.map.areas[area]) continue;
    const here = areaContains(w.map.areas[area], p.x, p.y);
    const name = w.map.areas[area].name;
    const npcs = residents(w, area).filter((a) => !isChild(w, a)).length;
    if (h.houseRent !== null && !h.tenant && npcs === 0 && !playerLodgers(w, area).length)
      out.push({ area, name, kind: "house", price: h.houseRent, landlord: landlordName(w, area), free: bedsIn(w.map, area), here });
    if (closedToNewcomers(w, area)) continue;
    const free = freeBedsFor(w, area, bedsUsedNpc(area));
    const price = bedPrice(w, area);
    if (free > 0 && price > 0) out.push({ area, name, kind: "bed", price, landlord: landlordName(w, area), free, here });
  }
  return out.sort((a, b) => a.price - b.price);
}

export function rentLodging(w: World, p: Player, area: string, kind: "bed" | "house", bedsUsedNpc: (area: string) => number): { ok: boolean; reason: string } {
  const offer = lodgingOffers(w, p, bedsUsedNpc).find((o) => o.area === area && o.kind === kind);
  if (!offer) return { ok: false, reason: "Тут немає такого житла в оренду." };
  if (!offer.here) return { ok: false, reason: `Прийди на місце, щоб домовитися: ${offer.name}.` };
  if (p.lodging?.area === area && p.lodging.kind === kind) return { ok: false, reason: "Ти вже тут мешкаєш." };
  if (p.coins < offer.price) return { ok: false, reason: `Перша ніч наперед — ${offer.price} срібла.` };
  if (p.lodging) leaveLodging(w, p, true);
  const h = w.homes[area];
  p.coins -= offer.price;
  receive(w, h, offer.price, "rent");
  p.lodging = { area, kind, since: w.time, debt: 0, paidNight: w.time };
  if (kind === "house") h.tenant = p.id;
  w.log(`${p.name} ${kind === "house" ? "винаймає будинок" : "винаймає ліжко"}: ${offer.name} (${offer.price} срібла за ніч, господар — ${offer.landlord}).`, "housing");
  const host = landlord(w, h);
  const hostAgent = host?.kind === "person" ? w.agents.get(host.b.id) : host?.kind === "biz" ? w.agents.get(host.biz.ownerId ?? "") : undefined;
  if (hostAgent) {
    const f = newFact(w, "moved", { actor: p.id, place: offer.name });
    learnFact(w, hostAgent, f, "self", 1);
    adjustRel(hostAgent, p.id, { trust: 2 });
  }
  w.selfChanged(p.id);
  return { ok: true, reason: `Тепер ти мешкаєш тут: ${offer.name}. ${offer.price} срібла за ніч, плата щовечора о 21:00.` };
}

export function leaveLodging(w: World, p: Player, quiet = false): { ok: boolean; reason: string } {
  const l = p.lodging;
  if (!l) return { ok: false, reason: "Ти ніде не мешкаєш." };
  const h = w.homes[l.area];
  if (h?.tenant === p.id) h.tenant = null;
  if (l.debt > 0) {
    // leaving with debts: the landlord remembers
    const host = h ? landlord(w, h) : null;
    const ag = host?.kind === "person" ? w.agents.get(host.b.id) : host?.kind === "biz" ? w.agents.get(host.biz.ownerId ?? "") : undefined;
    if (ag) { adjustRel(ag, p.id, { trust: -15 }); const r = ag.relations[p.id]; if (r) r.debt -= l.debt; }
  }
  p.lodging = null;
  w.selfChanged(p.id);
  if (!quiet) w.log(`${p.name} з'їжджає: ${w.map.areas[l.area]?.name ?? l.area}${l.debt ? ` (лишився винен ${l.debt} срібла)` : ""}.`, "housing");
  return { ok: true, reason: "Ти з'їхав. Тепер треба шукати, де ночувати." };
}

/** Is the player at home (rented bed or house)? Full rest there. */
export function atLodging(w: World, p: Player): boolean {
  const l = p.lodging;
  return !!l && !!w.map.areas[l.area] && areaContains(w.map.areas[l.area], p.x, p.y);
}

// ---------------------------------------------------------------------------
// Nightly rent
// ---------------------------------------------------------------------------

/** Pay what's due (old debt first). Returns the amount left unpaid. */
function charge(w: World, payer: Being, amount: number, h: Home): number {
  const paid = Math.min(payer.coins, amount);
  payer.coins -= paid;
  receive(w, h, paid, "rent");
  if (payer.kind === "player") w.selfChanged(payer.id);
  return amount - paid;
}

export function nightlyRent(w: World) {
  // NPC lodgers
  for (const a of w.agents.values()) {
    if (a.kind !== "npc" || isChild(w, a) || w.isJailed(a)) continue;
    const h = w.homes[a.home];
    if (!h || livesFree(w, a, a.home)) { a.flags.rentDebt = 0; continue; }
    const due = (a.flags.rentDebt ?? 0) + bedPrice(w, a.home);
    const left = charge(w, a, due, h);
    a.flags.rentDebt = left;
    if (left > 0) evictIfOverdue(w, a, h, left);
  }
  // whole-house tenants (players; NPC families live in houses they own or the town's beds)
  for (const p of w.players.values()) {
    const l = p.lodging;
    if (!l) continue;
    const h = w.homes[l.area];
    if (!h) { p.lodging = null; continue; }
    const price = l.kind === "house" ? h.houseRent ?? 0 : bedPrice(w, l.area);
    const left = charge(w, p, l.debt + price, h);
    l.paidNight = w.time;
    if (left <= 0) { l.debt = 0; if (price > 0) w.toast(p.id, `Плата за житло: ${price} срібла (${w.map.areas[l.area]?.name}).`, "info"); continue; }
    l.debt = left;
    if (left > price * (PATIENCE_NIGHTS - 1)) {
      const name = w.map.areas[l.area]?.name ?? l.area;
      leaveLodging(w, p, true);
      w.log(`${p.name} виселено за борги з житла: ${name} (борг ${left} срібла).`, "housing");
      w.toast(p.id, `Тебе виселили за несплату: ${name}. Борг ${left} срібла господар запам'ятав.`, "bad");
    } else w.toast(p.id, `Нема чим заплатити за житло! Борг ${left} срібла. Не заплатиш — виселять.`, "bad");
  }
}

function evictIfOverdue(w: World, a: Agent, h: Home, debt: number) {
  const host = landlord(w, h);
  const hostAgent = host?.kind === "person" ? w.agents.get(host.b.id) : host?.kind === "biz" ? w.agents.get(host.biz.ownerId ?? "") : undefined;
  if (hostAgent) adjustRel(hostAgent, a.id, { trust: -3 });
  const patience = PATIENCE_NIGHTS + (hostAgent ? Math.round(hostAgent.personality.empathy * 3) : 1);
  if (debt <= bedPrice(w, a.home) * patience || a.home === "tavern") return;
  // out — to the cheapest roof in town: the tavern
  const from = w.map.areas[a.home]?.name ?? a.home;
  for (const m of [a, ...[...w.agents.values()].filter((k) => k.home === a.home && isChild(w, k) && k.parents?.includes(a.id))]) m.home = "tavern";
  a.flags.movedAt = w.time;
  if (hostAgent) { const r = hostAgent.relations[a.id]; if (r) r.debt -= debt; }
  a.flags.rentDebt = 0;
  const f = newFact(w, "moved", { actor: a.id, place: "Таверна «Іржавий кухоль»" });
  learnFact(w, a, f, "self", 1);
  w.log(`${a.name} не платить за ліжко — ${hostAgent?.name ?? "господар"} виселяє (${from}). Тепер ночує в таверні.`, "housing");
}

export function onHourLodging(w: World, hour: number) {
  if (hour === 21) nightlyRent(w);
  if (hour === 6) ensureHomes(w);
}

// ---------------------------------------------------------------------------
// Workshops: crafting at someone else's station costs a fee
// ---------------------------------------------------------------------------

/** Business premises by area (a business's area can move — builders follow their site — so the home base is fixed here). */
const PREMISES: Record<string, string> = { tavern: "tavern", smithy: "smithy", warehouse: "builders", temple: "temple", residence: "admin", mine: "mine" };

function buildingAreaAt(w: World, x: number, y: number): string | null {
  const bi = w.map.bld[idx(x, y)];
  if (bi < 0) return null;
  for (const a of Object.values(w.map.areas)) if (a.building === bi && areaContains(a, x + 0.5, y + 0.5)) return a.id;
  for (const a of Object.values(w.map.areas)) if (a.building === bi) return a.id;
  return null;
}

export function defaultCraftFee(w: World, b: Business): number {
  if (b.ownerId === "town") return 1;
  const owner = b.ownerId ? w.agents.get(b.ownerId) : undefined;
  return owner ? 1 + Math.round(owner.personality.greed * 3) : 2;
}

export interface Workshop { label: string; owner: string; fee: number; free: boolean; pay: (amount: number) => void }

/** Whose premises the tile (a station) is in, what using it costs this being. null = outdoors, free. */
export function workshopAt(w: World, user: Being, x: number, y: number): Workshop | null {
  const area = buildingAreaAt(w, x, y);
  if (!area) return null;
  const bizId = PREMISES[area] ?? [...w.businesses.values()].find((b) => b.area === area && b.kind !== "construction")?.id;
  const biz = bizId ? w.businesses.get(bizId) : undefined;
  if (biz) {
    const free = biz.ownerId === user.id || biz.workers.includes(user.id);
    const fee = biz.craftFee ?? defaultCraftFee(w, biz);
    return {
      label: biz.name, owner: biz.ownerId === "town" ? "громада" : w.nameOf(biz.ownerId ?? "town"), fee, free,
      pay: (n) => { biz.treasury += n; const d = ledgerToday(w, biz); d.fees = (d.fees ?? 0) + n; },
    };
  }
  const h = w.homes[area];
  if (!h) return null;
  const ag = w.agents.get(user.id);
  const resident = ag?.home === area || (user.kind === "player" && (user as Player).lodging?.area === area);
  const free = resident || livesFree(w, user, area);
  const ownerAgent = h.owner ? w.agents.get(h.owner) : undefined;
  const fee = h.craftFee ?? (ownerAgent ? 1 + Math.round(ownerAgent.personality.greed * 3) : 1);
  return { label: w.map.areas[area]?.name ?? area, owner: landlordName(w, area), fee, free, pay: (n) => receive(w, h, n, "fee") };
}

/** Businesses whose premises have a station others can use (the fee applies there). */
export function hasWorkshop(w: World, b: Business): boolean {
  const areaId = Object.keys(PREMISES).find((k) => PREMISES[k] === b.id) ?? b.area;
  const ar = w.map.areas[areaId];
  if (ar?.building === undefined) return false;
  const bl = w.map.buildings[ar.building];
  const stations = new Set(Object.values(STATION_OBJ));
  for (let y = bl.y; y < bl.y + bl.h; y++)
    for (let x = bl.x; x < bl.x + bl.w; x++) if (stations.has(w.map.obj[idx(x, y)])) return true;
  return false;
}
