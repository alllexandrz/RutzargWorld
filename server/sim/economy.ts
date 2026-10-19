// Economy: market with price feedback, businesses, production, payroll, labour market.
// Same rules for NPC owners and player owners (concept §2.4, §10, §11, §21A.8).

import type { World } from "./world.ts";
import type { Being, Business } from "./types.ts";
import { ITEMS, ITEM_IDS, type ItemId, invAdd, marketBuyPrice, marketPrice } from "../../shared/items.ts";
import { areaContains } from "../../shared/map.ts";
import { addGoal, adjustRel, learnFact, newFact, witness } from "./social.ts";
import { requestJobDecision } from "./brain.ts";
import { isOwnerWorker } from "./seed.ts";
import { canWorkAt, SKILL_OF, skillLevel, trainSkill } from "./skillsys.ts";
import { skillMult } from "../../shared/skills.ts";
import { buildHour } from "./construction.ts";
import { digDeposit, fellTrees } from "./resources.ts";

// ---------------------------------------------------------------------------
// Market (municipal; money comes from / goes to the town treasury)
// ---------------------------------------------------------------------------

export type TxResult = { ok: true; total: number } | { ok: false; reason: string };

/** The market stops buying when its stock is this many times the normal level. */
const MARKET_FULL = 4;

export function marketSell(w: World, seller: Being, item: ItemId, qty: number): TxResult {
  const have = seller.inv[item] ?? 0;
  if (qty <= 0 || have < qty) return { ok: false, reason: "Немає стільки товару" };
  if (w.marketStock(item) + qty > ITEMS[item].targetStock * MARKET_FULL) return { ok: false, reason: `Ринок переповнений: ${ITEMS[item].name.toLowerCase()} зараз ніхто не купує` };
  let total = 0;
  for (let i = 0; i < qty; i++) total += marketBuyPrice(item, w.marketStock(item) + i);
  if (w.townTreasury < total) return { ok: false, reason: "У міській скарбниці немає грошей на закупівлю" };
  invAdd(seller.inv, item, -qty);
  w.market.stock[item] = w.marketStock(item) + qty;
  w.townTreasury -= total;
  seller.coins += total;
  return { ok: true, total };
}

export function marketBuy(w: World, buyer: Being, item: ItemId, qty: number): TxResult {
  if (qty <= 0 || w.marketStock(item) < qty) return { ok: false, reason: "На ринку немає стільки товару" };
  let total = 0;
  for (let i = 0; i < qty; i++) total += marketPrice(item, w.marketStock(item) - i);
  if (buyer.coins < total) return { ok: false, reason: `Потрібно ${total} срібла` };
  buyer.coins -= total;
  w.townTreasury += total;
  w.market.stock[item] = w.marketStock(item) - qty;
  invAdd(buyer.inv, item, qty);
  return { ok: true, total };
}

/** Business buys inputs from the market with its treasury. */
function bizBuy(w: World, b: Business, item: ItemId, qty: number): boolean {
  if (w.marketStock(item) < qty) return false;
  let total = 0;
  for (let i = 0; i < qty; i++) total += marketPrice(item, w.marketStock(item) - i);
  if (b.treasury < total) return false;
  b.treasury -= total;
  w.townTreasury += total;
  w.market.stock[item] = w.marketStock(item) - qty;
  b.stock[item] = (b.stock[item] ?? 0) + qty;
  return true;
}

function bizSell(w: World, b: Business, item: ItemId, qty: number): number {
  let total = 0;
  for (let i = 0; i < qty; i++) total += marketBuyPrice(item, w.marketStock(item) + i);
  total = Math.min(total, w.townTreasury);
  w.townTreasury -= total;
  w.market.stock[item] = w.marketStock(item) + qty;
  b.stock[item] = (b.stock[item] ?? 0) - qty;
  b.treasury += total;
  return total;
}

// ---------------------------------------------------------------------------
// Tavern meals
// ---------------------------------------------------------------------------

export function mealPrice(w: World): number {
  const t = w.businesses.get("tavern")!;
  return marketPrice("meal", Math.floor(t.stock.meal ?? 0));
}

/** Buy and eat a meal at the tavern (falls back to the market). Returns price paid or null. */
export function buyMeal(w: World, being: Being): number | null {
  const t = w.businesses.get("tavern")!;
  const price = mealPrice(w);
  if ((t.stock.meal ?? 0) >= 1 && being.coins >= price) {
    being.coins -= price;
    t.treasury += price;
    t.stock.meal = (t.stock.meal ?? 0) - 1;
    being.hunger = Math.min(100, being.hunger + 65);
    return price;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Employment
// ---------------------------------------------------------------------------

export function ownerName(w: World, b: Business): string {
  if (b.ownerId === "town") return "Громада Каргата";
  return b.ownerId ? w.nameOf(b.ownerId) : "—";
}

/** The person who represents the business in social terms. */
export function ownerPerson(b: Business): string | null {
  return b.ownerId === "town" ? "aldric" : b.ownerId;
}

export { bizBuy };

export function hasVacancy(b: Business): boolean {
  return b.workers.length < b.maxWorkers && b.ownerId !== null;
}

/** An NPC owner only takes on a worker they can pay (cash + purse for a few days, or steady income). */
export function canAffordHire(w: World, b: Business): boolean {
  const owner = b.ownerId && b.ownerId !== "town" ? w.agents.get(b.ownerId) : undefined;
  if (!owner) return true;
  const paid = b.workers.filter((id) => id !== b.ownerId).length;
  const reserves = b.treasury + Math.max(0, owner.coins - OWNER_RESERVE);
  return reserves >= b.wage * (paid + 1) * 3 || (b.income ?? 0) >= b.wage * (paid + 1);
}

export function hire(w: World, b: Business, worker: Being) {
  if (worker.jobBiz && worker.jobBiz !== b.id) leaveJob(w, worker, "quit");
  if (!b.workers.includes(worker.id)) b.workers.push(worker.id);
  worker.jobBiz = b.id;
  b.unpaidDays[worker.id] = 0;
  const f = newFact(w, "hired", { actor: ownerPerson(b) ?? undefined, target: worker.id, biz: b.id, amount: b.wage, place: b.name });
  const wa = w.agents.get(worker.id);
  if (wa) {
    learnFact(w, wa, f, "self", 1);
    wa.title = b.jobTitle;
  }
  const owner = ownerPerson(b);
  const oa = owner ? w.agents.get(owner) : undefined;
  if (oa) learnFact(w, oa, f, "self", 1);
  witness(w, f, worker.x, worker.y, { exclude: [worker.id, owner ?? ""] });
  w.log(`${worker.name} тепер працює в «${b.name}» за ${b.wage} срібла/день.`, "economy");
  if (b.ownerId && w.players.has(b.ownerId)) w.toast(b.ownerId, `${worker.name} погодився працювати в «${b.name}».`, "good");
}

export function leaveJob(w: World, worker: Being, how: "quit" | "fired" | "jailed") {
  const b = worker.jobBiz ? w.businesses.get(worker.jobBiz) : undefined;
  worker.jobBiz = null;
  if (!b) return;
  b.workers = b.workers.filter((x) => x !== worker.id);
  delete b.unpaidDays[worker.id];
  delete b.hoursWorked[worker.id];
  const owner = ownerPerson(b);
  const f = how === "fired"
    ? newFact(w, "fired", { actor: owner ?? undefined, target: worker.id, biz: b.id })
    : newFact(w, "quit", { actor: worker.id, biz: b.id });
  const wa = w.agents.get(worker.id);
  if (wa) { learnFact(w, wa, f, "self", 1); wa.title = how === "jailed" ? "В'язень" : "Безробітний"; }
  const oa = owner ? w.agents.get(owner) : undefined;
  if (oa) learnFact(w, oa, f, "self", 1);
  if (how !== "jailed") witness(w, f, worker.x, worker.y, { exclude: [worker.id] });
  w.log(how === "fired" ? `${ownerName(w, b)} звільняє ${worker.name} з «${b.name}».`
    : `${worker.name} залишає роботу в «${b.name}».`, "economy");
  if (b.ownerId && w.players.has(b.ownerId) && b.ownerId !== worker.id)
    w.toast(b.ownerId, `${worker.name} більше не працює в «${b.name}».`, "bad");
}

export function buyBusiness(w: World, buyer: Being, b: Business): TxResult {
  if (b.forSale === null) return { ok: false, reason: "Ця справа не продається" };
  if (buyer.coins < b.forSale) return { ok: false, reason: `Потрібно ${b.forSale} срібла` };
  const price = b.forSale;
  buyer.coins -= price;
  w.townTreasury += price;
  b.ownerId = buyer.id;
  b.forSale = null;
  b.treasury = 0;
  b.vacancyDays = 0;
  const f = newFact(w, "bought_business", { actor: buyer.id, biz: b.id, amount: price, place: "Резиденція старости" });
  const ald = w.agents.get("aldric");
  if (ald) learnFact(w, ald, f, "self", 1);
  const ba = w.agents.get(buyer.id);
  if (ba) learnFact(w, ba, f, "self", 1);
  witness(w, f, buyer.x, buyer.y, { exclude: [buyer.id, "aldric"] });
  w.log(`${buyer.name} купує «${b.name}» за ${price} срібла!`, "economy");
  const p = w.players.get(buyer.id);
  if (p) { p.ownedBusinesses.push(b.id); w.selfChanged(p.id); }
  return { ok: true, total: price };
}

// ---------------------------------------------------------------------------
// Private sale of a business (owner → buyer). Prices come from the engine, never from the LLM.
// ---------------------------------------------------------------------------

const BASE_VALUE: Partial<Record<Business["kind"], number>> = {
  lumber: 120, mine: 200, quarry: 150, farm: 160, smithy: 180, tavern: 220, trade: 90, construction: 150,
};

/** Market value: base value of the enterprise + cash in the till + goods in stock. */
export function businessValue(w: World, b: Business): number {
  let v = BASE_VALUE[b.kind] ?? 100;
  v += Math.max(0, b.treasury);
  for (const [item, n] of Object.entries(b.stock) as [ItemId, number][]) v += Math.floor(n ?? 0) * marketBuyPrice(item, w.marketStock(item));
  return Math.round(v);
}

export interface AskResult { price: number | null; reason: string }

/** The price an NPC owner would sell for to this buyer (null = not for sale). */
export function askPrice(w: World, b: Business, buyerId: string): AskResult {
  if (b.ownerId === "town") return { price: null, reason: "Це майно громади — його не продають." };
  const owner = b.ownerId ? w.agents.get(b.ownerId) : undefined;
  if (!owner) return { price: null, reason: "Тут немає з ким домовлятися." };
  if (owner.memories.some((m) => m.fact?.type === "theft" && m.fact.actor === buyerId)) return { price: null, reason: "Злодієві я нічого не продам." };
  const p = owner.personality;
  const works = b.workers.includes(owner.id) ? 1.25 : 1; // it's their life's work
  const debt = Object.values(owner.relations).reduce((n, r) => n + r.debt, 0);
  const needsMoney = owner.coins < 20 || debt > 0 ? 0.85 : 1;
  const r = owner.relations[buyerId];
  const att = r ? r.trust * 0.5 + r.affection * 0.35 : 0;
  const mult = (1 + p.greed * 0.3 + p.ambition * 0.3) * works * needsMoney * (1 - att / 300);
  const price = Math.round(businessValue(w, b) * Math.max(0.9, mult));
  return { price, reason: "" };
}

/** Transfer a business from its current owner to a buyer for a price. */
export function sellBusiness(w: World, b: Business, buyer: Being, price: number): TxResult {
  const owner = b.ownerId ? w.being(b.ownerId) : undefined;
  if (!owner) return { ok: false, reason: "Немає власника" };
  if (buyer.coins < price) return { ok: false, reason: `Потрібно ${price} срібла` };
  buyer.coins -= price;
  owner.coins += price;
  const op = w.players.get(owner.id);
  if (op) op.ownedBusinesses = op.ownedBusinesses.filter((x) => x !== b.id);
  b.ownerId = buyer.id;
  b.forSale = null;
  b.vacancyDays = 0;
  // the former owner no longer works there
  if (b.workers.includes(owner.id)) {
    b.workers = b.workers.filter((x) => x !== owner.id);
    owner.jobBiz = null;
    const oa = w.agents.get(owner.id);
    if (oa) { oa.title = "Колишній власник"; addGoal(oa, `${oa.id}_newbiz`, "Знайти нову справу для своїх грошей", 0.7); }
  }
  const f = newFact(w, "bought_business", { actor: buyer.id, target: owner.id, biz: b.id, amount: price, place: w.areaName(buyer.x, buyer.y) });
  for (const id of [owner.id, buyer.id]) { const ag = w.agents.get(id); if (ag) learnFact(w, ag, f, "self", 1); }
  witness(w, f, buyer.x, buyer.y, { exclude: [owner.id, buyer.id] });
  w.log(`${owner.name} продає «${b.name}» — новий власник ${buyer.name} (${price} срібла).`, "economy");
  const bp = w.players.get(buyer.id);
  if (bp) { bp.ownedBusinesses.push(b.id); w.selfChanged(bp.id); }
  if (op) w.selfChanged(op.id);
  return { ok: true, total: price };
}

// ---------------------------------------------------------------------------
// Hourly / daily cycles
// ---------------------------------------------------------------------------

function isWorking(w: World, b: Business, id: string): boolean {
  const a = w.agents.get(id);
  if (!a || w.isJailed(a)) return false;
  if (a.activity.type !== "work" || a.activity.biz !== b.id) return false;
  if (b.kind === "guard") return true; // patrol anywhere
  const area = w.map.areas[b.area];
  return !!area && areaContains(area, a.x, a.y);
}

export function onHour(w: World, hour: number) {
  for (const b of w.businesses.values()) {
    const [h0, h1] = b.workHours;
    if (hour < h0 || hour > h1) continue;
    for (const id of b.workers) {
      if (!isWorking(w, b, id)) continue;
      b.hoursWorked[id] = (b.hoursWorked[id] ?? 0) + 1;
      produce(w, b, id);
    }
  }

  if (hour === 18) {
    for (const b of w.businesses.values()) sellOutput(w, b);
    for (const b of w.businesses.values()) measureIncome(b);
    for (const b of w.businesses.values()) payroll(w, b);
  }
  if (hour === 19) {
    for (const b of w.businesses.values()) ownerProfit(w, b);
    for (const b of w.businesses.values()) b.treasuryMark = b.treasury;
  }
  if (hour === 9) {
    // tavern restocks grain in the morning
    const t = w.businesses.get("tavern")!;
    if ((t.stock.grain ?? 0) < 6) bizBuy(w, t, "grain", 6);
  }
}

function produce(w: World, b: Business, workerId: string) {
  const worker = w.being(workerId);
  const skill = SKILL_OF[b.kind];
  // Every worked hour trains the job's skill — learning by doing.
  if (worker && skill && b.kind !== "construction") trainSkill(w, worker, skill, 1);
  if (b.kind === "construction") { buildHour(w, workerId); return; }
  if (b.kind === "trade") {
    const a = w.agents.get(workerId);
    const mult = worker ? skillMult(skillLevel(worker, "trading")) : 1;
    b.treasury += Math.round((1 + Math.random() * (a ? 1 + a.personality.ambition * 2 : 2)) * mult + 0.5);
    return;
  }
  if (!b.product) return;
  const toolBonus = worker && (worker.inv.tools ?? 0) > 0 ? 1.3 : 1;
  const tiredPenalty = worker && worker.energy < 15 ? 0.5 : 1;
  const amount = b.rate * toolBonus * tiredPenalty * (worker && skill ? skillMult(skillLevel(worker, skill)) : 1);
  for (const [item, per] of Object.entries(b.inputs) as [ItemId, number][]) {
    const need = per * amount;
    if ((b.stock[item] ?? 0) < need) {
      if (!bizBuy(w, b, item, Math.ceil(need * 3))) return; // no inputs, no production
    }
  }
  for (const [item, per] of Object.entries(b.inputs) as [ItemId, number][]) b.stock[item] = (b.stock[item] ?? 0) - per * amount;
  let made = amount;
  // Extraction is limited by nature: real trees around a lumber camp, a finite deposit for mines.
  if (b.kind === "lumber" || b.kind === "mine" || b.kind === "quarry") {
    const want = (b.carry ?? 0) + amount;
    const units = Math.floor(want);
    const got = b.kind === "lumber" ? fellTrees(w, b, units) : digDeposit(w, b, units);
    b.carry = got < units ? 0 : Math.min(2, want - units);
    made = got;
  }
  b.stock[b.product] = (b.stock[b.product] ?? 0) + made;
}

function sellOutput(w: World, b: Business) {
  if (!b.product) return;
  const have = Math.floor(b.stock[b.product] ?? 0);
  const keep = b.kind === "tavern" ? 14 : 0;
  // the market only takes what it has room for; the rest stays in the warehouse
  const room = Math.max(0, ITEMS[b.product].targetStock * MARKET_FULL - w.marketStock(b.product));
  const qty = Math.min(have - keep, room);
  if (qty > 0) {
    const got = bizSell(w, b, b.product, qty);
    if (got > 0 && b.ownerId && w.players.has(b.ownerId))
      w.toast(b.ownerId, `«${b.name}» продала ${qty} × ${ITEMS[b.product].name} за ${got} срібла.`, "good");
  }
}

function measureIncome(b: Business) {
  if (b.treasuryMark === undefined) return;
  const today = b.treasury - b.treasuryMark;
  b.income = b.income === undefined ? today : Math.round(b.income * 0.6 + today * 0.4);
}

/** Coins an NPC owner keeps for themselves before putting private money into the business. */
const OWNER_RESERVE = 15;
const WAGE_FLOOR = 6;

function payroll(w: World, b: Business) {
  const payees = b.workers.filter((id) => !isOwnerWorker(b, id) && (b.hoursWorked[id] ?? 0) >= 3);
  const need = payees.length * b.wage - b.treasury;
  if (b.ownerId === "town" && need > 0) {
    const give = Math.min(need, w.townTreasury);
    w.townTreasury -= give;
    b.treasury += give;
  }
  // An NPC owner covers a shortfall from their own purse rather than stiffing the workers.
  const oa = b.ownerId && b.ownerId !== "town" ? w.agents.get(b.ownerId) : undefined;
  if (oa && need > 0) {
    const give = Math.min(need, Math.max(0, oa.coins - OWNER_RESERVE));
    if (give > 0) {
      oa.coins -= give;
      b.treasury += give;
      w.log(`${oa.name} докладає ${give} срібла власних грошей на платню в «${b.name}».`, "economy");
    }
  }
  for (const id of payees) {
    const worker = w.being(id);
    if (!worker) continue;
    const owner = ownerPerson(b);
    if (b.treasury >= b.wage) {
      b.treasury -= b.wage;
      worker.coins += b.wage;
      b.unpaidDays[id] = 0;
      const wa = w.agents.get(id);
      if (wa && owner) adjustRel(wa, owner, { trust: 1.5 });
    } else {
      b.unpaidDays[id] = (b.unpaidDays[id] ?? 0) + 1;
      const f = newFact(w, "unpaid", { target: id, biz: b.id, actor: owner ?? undefined });
      const wa = w.agents.get(id);
      if (wa) learnFact(w, wa, f, "self", 1);
      w.log(`«${b.name}» не змогла заплатити ${worker.name} (${b.unpaidDays[id]} дн. поспіль).`, "economy");
      if (b.ownerId && w.players.has(b.ownerId))
        w.toast(b.ownerId, `У «${b.name}» не вистачило грошей на платню для ${worker.name}!`, "bad");
      if (wa) addGoal(wa, "unpaid", `Отримати платню від «${b.name}»`, 0.6 + 0.15 * b.unpaidDays[id]);
    }
  }
  for (const id of Object.keys(b.hoursWorked)) b.hoursWorked[id] = 0;
}

function ownerProfit(w: World, b: Business) {
  if (!b.ownerId || b.ownerId === "town") {
    if (b.ownerId === "town" && b.treasury > b.wage * b.maxWorkers * 2) {
      const surplus = b.treasury - b.wage * b.maxWorkers * 2;
      b.treasury -= surplus;
      w.townTreasury += surplus;
    }
    return;
  }
  const owner = w.agents.get(b.ownerId);
  if (!owner) return; // players withdraw manually
  const paidWorkers = b.workers.filter((id) => id !== b.ownerId).length;
  const reserve = b.wage * paidWorkers * 2 + 10;
  if (b.treasury > reserve) {
    const take = Math.floor((b.treasury - reserve) * (0.5 + owner.personality.greed * 0.5));
    b.treasury -= take;
    owner.coins += take;
  }
}

/**
 * NPC owners look at the books once a day: if wages eat more than the business earns and
 * the reserves (cash + owner's purse) won't last, they cut wages, and at the floor lay someone off.
 */
function manageStaff(w: World, b: Business) {
  const owner = b.ownerId ? w.agents.get(b.ownerId) : undefined;
  if (!owner || b.income === undefined) return;
  const paid = b.workers.filter((id) => id !== b.ownerId);
  if (!paid.length) return;
  const cost = paid.length * b.wage;
  const reserves = b.treasury + Math.max(0, owner.coins - OWNER_RESERVE);
  const longUnpaid = paid.some((id) => (b.unpaidDays[id] ?? 0) >= 2);
  const losing = cost > b.income + 2;
  if (!longUnpaid && !losing) return;
  // Losing money: trim wages a step a day; lay off only when reserves won't carry the payroll.
  if (b.wage > WAGE_FLOOR && !longUnpaid) {
    b.wage = Math.max(WAGE_FLOOR, b.wage - 2);
    w.log(`${owner.name} не витягує платню в «${b.name}» і знижує її до ${b.wage} срібла/день.`, "economy");
    for (const id of paid) {
      const wa = w.agents.get(id);
      if (wa) adjustRel(wa, owner.id, { trust: -1 });
    }
    return;
  }
  if (!longUnpaid && reserves >= cost * 3) return;
  // Last hired goes first.
  const worker = w.being(paid[paid.length - 1]);
  if (worker) leaveJob(w, worker, "fired");
}

export function onDay(w: World, day: number) {
  // Caravans export goods → money flows into town (keeps prices from collapsing)
  for (const id of ITEM_IDS) {
    const def = ITEMS[id];
    // Caravans only take the surplus — the town keeps half of the normal stock for itself.
    // The bigger the glut, the more caravans take (but never below half of the normal stock).
    const stock = w.marketStock(id);
    const want = Math.max(def.dailyExport, Math.round((stock - def.targetStock) * 0.2));
    const qty = Math.min(want, Math.max(0, stock - Math.floor(def.targetStock / 2)));
    if (qty > 0) {
      w.market.stock[id] = w.marketStock(id) - qty;
      w.townTreasury += Math.round(qty * def.basePrice * 0.9);
    }
  }
  // Labour market feedback: unfilled vacancies raise wages; overstaffing doesn't.
  for (const b of w.businesses.values()) {
    if (!b.ownerId || w.players.has(b.ownerId)) continue;
    if (!b.product && b.kind !== "trade") continue;
    // Only a real labour shortage (no hired hands at all) pushes wages up.
    const hired = b.workers.filter((id) => id !== b.ownerId).length;
    if (hasVacancy(b) && hired === 0) {
      b.vacancyDays++;
      if (b.vacancyDays >= 2 && b.wage < 16) {
        b.wage++;
        b.vacancyDays = 0;
        const f = newFact(w, "wage_raise", { biz: b.id, amount: b.wage, actor: ownerPerson(b) ?? undefined });
        const oa = w.agents.get(ownerPerson(b) ?? "");
        if (oa) learnFact(w, oa, f, "self", 1);
        w.log(`«${b.name}» шукає робітників і піднімає платню до ${b.wage}.`, "economy");
      }
    } else b.vacancyDays = 0;
  }
  for (const b of w.businesses.values()) manageStaff(w, b);
  // Ambitious NPC owners try to poach workers from competitors (concept §11).
  for (const b of w.businesses.values()) {
    const owner = b.ownerId ? w.agents.get(b.ownerId) : undefined;
    if (!owner || !hasVacancy(b) || owner.personality.ambition < 0.7) continue;
    const candidates = [...w.agents.values()].filter((a) =>
      a.kind === "npc" && a.jobBiz && a.jobBiz !== b.id && canWorkAt(b, a) &&
      w.businesses.get(a.jobBiz)?.ownerId !== a.id && !w.isJailed(a));
    if (!candidates.length) continue;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const cur = w.businesses.get(target.jobBiz!)!;
    const offer = Math.max(b.wage, cur.wage + 2);
    if (b.treasury + owner.coins < offer * 3) continue;
    // Don't poach into a payroll the business can't earn back.
    const paid = b.workers.filter((id) => id !== b.ownerId).length;
    if (b.income !== undefined && (paid + 1) * offer > b.income * 1.3 + 5) continue;
    b.wage = offer;
    w.log(`${owner.name} переманює ${target.name}: пропонує ${offer} срібла/день у «${b.name}».`, "economy");
    requestJobDecision(w, target, { bizId: b.id, wage: offer, from: owner.id }, (d) => {
      // Owner accepts a modest counter-offer if they can afford it.
      if (d.action === "NEGOTIATE" && d.counterWage && d.counterWage <= offer + 3 && hasVacancy(b) && b.treasury + owner.coins >= d.counterWage * 3) {
        b.wage = d.counterWage;
        w.log(`${owner.name} погоджується на ${d.counterWage} срібла для ${target.name}.`, "economy");
        hire(w, b, target);
      }
    });
  }
  w.log(`Настав день ${day}. Скарбниця Каргата: ${Math.round(w.townTreasury)} срібла.`, "world");
}
