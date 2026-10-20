// Equipment rules for players and NPCs alike: putting things on, wear and tear,
// tools that speed up work, scuffles when a guard tries to arrest an armed person,
// and NPCs who want proper clothes and the right tool for their trade.

import type { World } from "./world.ts";
import type { Agent, Being } from "./types.ts";
import { ITEMS, invAdd, type ItemId, type Slot } from "../../shared/items.ts";
import { JOB_TOOL, SLOTS, TOOL_FOR, WEAR, gearStats, repairCost, repairStation, wearPerUse, type CharStats, type Equipment } from "../../shared/gear.ts";
import { STATION_NAMES, STATION_OBJ, STATION_RANGE } from "../../shared/crafting.ts";
import { findObjNear } from "../../shared/map.ts";
import { marketBuy } from "./economy.ts";
import { workshopAt } from "./housing.ts";
import type { Business } from "./types.ts";
import { skillLevel, trainSkill } from "./skillsys.ts";
import { assignPlan, canTakePlan, materialCost } from "./crafting.ts";
import { isChild } from "./family.ts";
import { adjustRel, learnFact, newFact, witness } from "./social.ts";

export function statsOf(b: Being): CharStats {
  return gearStats(b.equip, skillLevel(b, "combat"));
}

export function equipItem(w: World, b: Being, item: ItemId): { ok: boolean; reason?: string } {
  const def = ITEMS[item];
  if (!def?.slot) return { ok: false, reason: "Це не можна вдягнути" };
  if ((b.inv[item] ?? 0) <= 0) return { ok: false, reason: `Немає в сумці: ${def.name.toLowerCase()}` };
  b.equip ??= {};
  // which copy: a new one if the bag has any, otherwise the best of the used ones
  const used = wornCopies(b, item);
  let dur = 100;
  if (used.length >= (b.inv[item] ?? 0)) { used.sort((x, y) => y - x); dur = used.shift()!; }
  if (b.equip[def.slot]) unequip(w, b, def.slot);
  invAdd(b.inv, item, -1);
  b.equip[def.slot] = { item, dur };
  w.selfChanged(b.id);
  return { ok: true };
}

/** Conditions of the used copies of an item in the bag (trimmed to what's actually there). */
export function wornCopies(b: Being, item: ItemId): number[] {
  const list = b.worn?.[item];
  if (!list) return [];
  const have = b.inv[item] ?? 0;
  // copies that left the bag (sold, given away) — assume the most worn went first
  if (list.length > have) { list.sort((x, y) => y - x); list.length = have; }
  if (!list.length) delete b.worn![item];
  return list;
}

export function unequip(w: World, b: Being, slot: Slot): { ok: boolean; reason?: string } {
  const cur = b.equip?.[slot];
  if (!cur) return { ok: false, reason: "Тут нічого немає" };
  delete b.equip![slot];
  wornCopies(b, cur.item);
  invAdd(b.inv, cur.item, 1);
  if (cur.dur < 100) { b.worn ??= {}; (b.worn[cur.item] ??= []).push(Math.round(cur.dur)); }
  w.selfChanged(b.id);
  return { ok: true };
}

/** The worn item loses condition; at 0 it falls apart. */
export function wearOut(w: World, b: Being, slot: Slot, amount: number) {
  const cur = b.equip?.[slot];
  if (!cur) return;
  cur.dur = Math.max(0, cur.dur - amount);
  if (cur.dur > 0) return;
  delete b.equip![slot];
  const name = ITEMS[cur.item].name;
  w.toast(b.id, `${name}: зношено вщент, довелося викинути. Потрібна нова річ.`, "bad");
  if (b.kind !== "player") w.log(`${b.name}: ${name.toLowerCase()} — зношено вщент.`, "craft");
  w.selfChanged(b.id);
}

/** Work/gather speed bonus from the tool in hand for this resource (0 = none). */
export function toolBonus(b: Being, resource: ItemId): number {
  const held = b.equip?.weapon;
  if (!held) return 0;
  const g = ITEMS[held.item].stats?.gather?.[resource] ?? 0;
  return held.dur < 25 ? g * 0.6 : g;
}

/** Using the tool wears it: `units` gathered / made with it. */
export function useTool(w: World, b: Being, resource: ItemId, units: number) {
  const held = b.equip?.weapon;
  if (held && TOOL_FOR[resource]?.includes(held.item)) wearOut(w, b, "weapon", wearPerUse(held.item) * units);
}

/** The tool in hand that can extract this resource. A suitable one from the bag is taken in hand automatically. */
export function toolFor(w: World, b: Being, resource: ItemId): ItemId | null {
  const ok = TOOL_FOR[resource];
  if (!ok) return null;
  const held = b.equip?.weapon?.item;
  if (held && ok.includes(held)) return held;
  const spare = ok.find((t) => (b.inv[t] ?? 0) > 0);
  if (spare && equipItem(w, b, spare).ok) return spare;
  return null;
}

/** The resource a tool is first of all for (axe → wood). */
export function resourceOf(tool: ItemId): ItemId {
  return (Object.entries(TOOL_FOR) as [ItemId, ItemId[]][]).find(([, t]) => t[0] === tool)?.[0] ?? "wood";
}

export function toolNames(resource: ItemId): string {
  return (TOOL_FOR[resource] ?? []).map((t) => ITEMS[t].name.toLowerCase()).join(" або ");
}

/**
 * A worker came without the tool for the job: the business hands one out (bought at the market from its till;
 * the town tops up its own). Returns false if it couldn't — then the worker can't work.
 */
export function supplyTool(w: World, biz: Business, worker: Being): boolean {
  const tool = JOB_TOOL[biz.kind];
  if (!tool) return true;
  if (toolFor(w, worker, resourceOf(tool))) return true;
  if (w.marketStock(tool) <= 0) return false;
  const price = Math.round(ITEMS[tool].basePrice * 2.5);
  if (biz.treasury < price && biz.ownerId === "town") {
    const top = Math.min(w.townTreasury, price - biz.treasury + 2);
    w.townTreasury -= top; biz.treasury += top;
  }
  // buy with the business' money through the worker (market rules apply)
  const before = worker.coins;
  worker.coins += biz.treasury;
  const r = marketBuy(w, worker, tool, 1);
  const spent = before + biz.treasury - worker.coins;
  worker.coins = before;
  if (!r.ok) return false;
  biz.treasury -= spent;
  equipItem(w, worker, tool);
  const owner = biz.ownerId ? w.players.get(biz.ownerId) : undefined;
  if (owner) w.toast(owner.id, `«${biz.name}»: ${worker.name} прийшов без знаряддя — справа купила йому ${ITEMS[tool].name.toLowerCase()} за ${spent} срібла з каси.`, "info");
  w.log(`«${biz.name}» видає ${worker.name} ${ITEMS[tool].name.toLowerCase()} (${spent} срібла з каси).`, "economy");
  return true;
}

// ---------------------------------------------------------------------------
// Repair and discarding
// ---------------------------------------------------------------------------

/** What fixing the item in this slot costs right here (null: no suitable station within reach). */
export function repairQuote(w: World, b: Being, slot: Slot): { cost: number; self: boolean; where: string; station: string } | null {
  const worn = b.equip?.[slot];
  if (!worn || worn.dur >= 100) return null;
  const st = repairStation(worn.item);
  const t = findObjNear(w.map, b.x, b.y, STATION_OBJ[st], STATION_RANGE);
  if (!t) return null;
  const ws = workshopAt(w, b, t.x, t.y);
  const self = !ws || ws.free;
  return { cost: repairCost(worn, self), self, where: ws ? ws.label : STATION_NAMES[st], station: st };
}

export function repairItem(w: World, b: Being, slot: Slot): { ok: boolean; reason: string } {
  const worn = b.equip?.[slot];
  if (!worn) return { ok: false, reason: "Тут нічого немає." };
  if (worn.dur >= 100) return { ok: false, reason: "Річ і так ціла." };
  const q = repairQuote(w, b, slot);
  if (!q) return { ok: false, reason: `Лагодять ${repairStation(worn.item) === "anvil" ? "на ковадлі (кузня)" : "на верстаку"} — підійди до нього.` };
  if (b.coins < q.cost) return { ok: false, reason: `Ремонт коштує ${q.cost} срібла.` };
  b.coins -= q.cost;
  const t = findObjNear(w.map, b.x, b.y, STATION_OBJ[q.station as "anvil" | "workbench"], STATION_RANGE)!;
  const ws = workshopAt(w, b, t.x, t.y);
  if (!q.self && ws) ws.pay(q.cost); // the craftsman's work and materials
  else trainSkill(w, b, q.station === "anvil" ? "smithing" : ITEMS[worn.item].stats?.attack ? "carpentry" : "tailoring", 0.5);
  worn.dur = 100;
  w.selfChanged(b.id);
  const name = ITEMS[worn.item].name.toLowerCase();
  if (b.kind !== "player") w.log(`${b.name} лагодить ${name} (${q.where}, ${q.cost} срібла).`, "craft");
  return { ok: true, reason: `Полагоджено: ${ITEMS[worn.item].name.toLowerCase()}${q.self ? ` (власноруч, матеріали — ${q.cost} срібла)` : ` — ${q.where}, ${q.cost} срібла`}.` };
}

/** Throw a thing away: the worn one from a slot, or one copy from the bag (the most worn first). */
export function discard(w: World, b: Being, what: { slot?: Slot; item?: ItemId }): { ok: boolean; reason: string } {
  if (what.slot) {
    const cur = b.equip?.[what.slot];
    if (!cur) return { ok: false, reason: "Тут нічого немає." };
    delete b.equip![what.slot];
    w.selfChanged(b.id);
    return { ok: true, reason: `Викинуто: ${ITEMS[cur.item].name.toLowerCase()}.` };
  }
  const item = what.item;
  if (!item || !ITEMS[item] || (b.inv[item] ?? 0) <= 0) return { ok: false, reason: "Немає такого в сумці." };
  const used = wornCopies(b, item);
  if (used.length) { used.sort((x, y) => x - y); used.shift(); }
  invAdd(b.inv, item, -1);
  wornCopies(b, item);
  w.selfChanged(b.id);
  return { ok: true, reason: `Викинуто: ${ITEMS[item].name.toLowerCase()}.` };
}

/** Starting clothes; the role decides the rest (what a lumberjack or a guard would own). */
export function starterOutfit(b: Being, profession?: string): Equipment {
  const dur = () => 45 + Math.floor(Math.random() * 50);
  const eq: Equipment = { body: { item: "shirt", dur: dur() } };
  if (profession === "child") return eq;
  eq.legs = { item: "trousers", dur: dur() };
  eq.feet = { item: "lychaky", dur: dur() };
  switch (profession) {
    case "guard_captain": eq.weapon = { item: "sword", dur: dur() }; eq.head = { item: "helmet", dur: dur() }; break;
    case "guard": eq.weapon = { item: "spear", dur: dur() }; break;
    case "lumberjack": eq.weapon = { item: "axe", dur: dur() }; break;
    case "farmer": case "farmhand": eq.weapon = { item: "sickle", dur: dur() }; break;
    case "miner": eq.weapon = { item: "pickaxe", dur: dur() }; break;
    case "merchant": case "innkeeper": case "reeve": case "moneylender":
      eq.body = { item: "svyta", dur: dur() }; eq.feet = { item: "boots", dur: dur() }; eq.head = { item: "cap", dur: dur() }; break;
    case "blacksmith": eq.weapon = { item: "knife", dur: dur() }; break;
    case "drifter": eq.weapon = { item: "knife", dur: dur() }; delete eq.feet; break;
  }
  return eq;
}

// ---------------------------------------------------------------------------
// Scuffles
// ---------------------------------------------------------------------------

/**
 * A suspect may fight off a guard if clearly stronger (armed, armoured, trained).
 * Returns true when the arrest failed. Both sides' gear takes damage.
 */
export function resistArrest(w: World, suspect: Being, guard: Agent): boolean {
  const ps = statsOf(suspect).power, pg = statsOf(guard).power;
  const sa = w.agents.get(suspect.id);
  const will = sa ? 0.3 + sa.personality.courage * 0.7 : 1; // players always resist when stronger
  const chance = Math.max(0, Math.min(0.7, (ps - pg) / 12)) * will;
  if (chance <= 0) return false;
  for (const s of ["weapon", "body", "head", "offhand"] as Slot[]) { wearOut(w, suspect, s, WEAR.fight); wearOut(w, guard, s, WEAR.fight); }
  trainSkill(w, suspect, "combat", 1);
  trainSkill(w, guard, "combat", 1);
  if (Math.random() >= chance) return false;
  guard.energy = Math.max(0, guard.energy - 20);
  const f = newFact(w, "resisted", { actor: suspect.id, target: guard.id, place: w.areaName(suspect.x, suspect.y) });
  learnFact(w, guard, f, "self", 1);
  if (sa) learnFact(w, sa, f, "self", 1);
  witness(w, f, suspect.x, suspect.y, { exclude: [guard.id, suspect.id] });
  adjustRel(guard, suspect.id, { fear: 10, trust: -10 });
  const held = suspect.equip?.weapon ? ITEMS[suspect.equip.weapon.item].name.toLowerCase() : "кулаки";
  w.say(guard.id, `Ах ти ж! ${suspect.name} відбивається!`);
  w.log(`${suspect.name} відбивається від вартового ${guard.name} (${held}) і не дається в руки.`, "crime");
  w.toast(suspect.id, `Ти відбився від вартового ${guard.name}! Але тепер варта тебе пам'ятає.`, "info");
  return true;
}

// ---------------------------------------------------------------------------
// NPCs: what to wear and what tool to carry
// ---------------------------------------------------------------------------


/** What this NPC would like in each slot (best that suits their life). */
export function wantedGear(w: World, a: Agent): Partial<Record<Slot, ItemId>> {
  if (isChild(w, a)) return { body: "shirt" };
  const out: Partial<Record<Slot, ItemId>> = { body: "shirt", legs: "trousers", feet: "lychaky" };
  const job = a.jobBiz ? w.businesses.get(a.jobBiz) : undefined;
  if (job?.kind === "guard") {
    out.weapon = a.profession === "guard_captain" ? "sword" : "spear";
    out.head = "helmet";
  } else if (job && JOB_TOOL[job.kind]) out.weapon = JOB_TOOL[job.kind];
  // the well-off and the ambitious dress up
  if (a.coins > 60 || a.personality.ambition > 0.7 || w.politics.reeve === a.id) {
    out.body = "svyta"; out.feet = "boots"; out.head ??= "cap";
  }
  // the bold and lawless carry something to defend themselves
  if (!out.weapon && a.personality.courage > 0.6 && a.personality.lawfulness < 0.4) out.weapon = "knife";
  return out;
}

function better(cur: ItemId | undefined, want: ItemId): boolean {
  if (!cur) return true;
  if (cur === want) return false;
  // a tool for one's trade beats a better-priced weapon of another kind; otherwise go by value
  const tool = Object.values(JOB_TOOL).includes(want);
  return tool || ITEMS[want].basePrice > ITEMS[cur].basePrice;
}

/** Twice a day: put on what's in the bag, otherwise buy or make the most needed piece. */
function npcDress(w: World) {
  for (const a of w.agents.values()) {
    if (a.kind !== "npc") continue;
    a.equip ??= starterOutfit(a, isChild(w, a) ? "child" : undefined);
    const want = wantedGear(w, a);
    // 1) the bag first
    for (const slot of SLOTS) {
      const it = want[slot];
      const cur = a.equip[slot];
      if (it && (a.inv[it] ?? 0) > 0 && (better(cur?.item, it) || (cur && cur.dur < 15))) equipItem(w, a, it);
      else if (!a.equip[slot]) {
        const spare = (Object.keys(a.inv) as ItemId[]).find((i) => ITEMS[i].slot === slot && (a.inv[i] ?? 0) > 0);
        if (spare) equipItem(w, a, spare);
      }
    }
    // rags left in the bag after a replacement go out with the rubbish
    for (const [it, list] of Object.entries(a.worn ?? {}) as [ItemId, number[]][]) {
      const rags = list.filter((d) => d < 15).length;
      if (rags) { invAdd(a.inv, it, -rags); a.worn![it] = list.filter((d) => d >= 15); }
    }
    if (!canTakePlan(w, a)) continue;
    // 1b) a worn job tool: repair is cheaper than a new one
    const jobTool = JOB_TOOL[w.businesses.get(a.jobBiz ?? "")?.kind ?? ""];
    const held = a.equip.weapon;
    if (held && held.item === jobTool && held.dur < 35) {
      const cost = repairCost(held);
      if (cost <= a.coins - 2) {
        assignPlan(w, a, { item: held.item, qty: 1, use: { kind: "repair", slot: "weapon" }, payer: "self", label: `несе лагодити: ${ITEMS[held.item].name.toLowerCase()}`, priority: 0.6 },
          `${a.name} несе лагодити ${ITEMS[held.item].name.toLowerCase()} (${cost} срібла).`);
        continue;
      }
    }
    // 2) the most pressing missing piece: work tool, then a missing garment, then replacing worn-out things and upgrades
    const order: Slot[] = ["weapon", "body", "legs", "feet", "head", "offhand"];
    let pick: { slot: Slot; item: ItemId; urgent: boolean } | null = null;
    for (const slot of order) {
      const it = want[slot];
      if (!it) continue;
      const cur = a.equip[slot];
      const urgent = !cur || cur.dur < 15 || (slot === "weapon" && better(cur.item, it) && it === JOB_TOOL[w.businesses.get(a.jobBiz ?? "")?.kind ?? ""]);
      if (urgent || better(cur?.item, it)) { pick = { slot, item: it, urgent }; if (urgent) break; }
    }
    if (!pick) continue;
    if ((a.flags[`craftFail_${pick.item}`] ?? -1e9) > w.time - 1440) continue;
    const cost = Math.min(materialCost(w, pick.item, 1, { ...a.inv }), w.marketStock(pick.item) > 0 ? Math.round(ITEMS[pick.item].basePrice * 1.6) : Infinity);
    const reserve = pick.urgent ? 4 : 25;
    if (cost > a.coins - reserve) {
      // no money for the tool without which one can't work → go and borrow
      if (pick.slot === "weapon" && pick.item === jobTool) { a.flags.toolLoan = Math.ceil(cost - a.coins + 4); a.flags.toolLoanAt = w.time; }
      continue;
    }
    const name = ITEMS[pick.item].name.toLowerCase();
    assignPlan(w, a, { item: pick.item, qty: 1, use: { kind: "equip" }, payer: "self", label: `дбає про обнову: ${name}`, priority: pick.urgent ? 0.65 : 0.35 },
      `${a.name} ${pick.urgent ? "потребує" : "хоче"}: ${name}${a.equip[pick.slot] ? ` (зараз — ${ITEMS[a.equip[pick.slot]!.item].name.toLowerCase()})` : ""}.`);
  }
}

/** Clothes and armour wear out day by day (only on people who are actually around). */
function dailyWear(w: World) {
  for (const b of w.presentBeings()) {
    if (!b.equip) continue;
    for (const slot of ["head", "body", "legs", "feet", "offhand"] as Slot[]) wearOut(w, b, slot, WEAR.daily * (0.7 + Math.random() * 0.6));
  }
}

export function onHourGear(w: World, hour: number) {
  if (hour === 7 || hour === 17) npcDress(w);
}

export function onDayGear(w: World) {
  dailyWear(w);
}

/** Make sure everybody has an outfit (new worlds, old saves, newcomers). */
export function ensureOutfits(w: World) {
  for (const a of w.agents.values()) if (a.kind === "npc") a.equip ??= starterOutfit(a, isChild(w, a) ? "child" : a.profession);
  // once: workers of the town's first businesses own the tool of their trade
  for (const a of w.agents.values()) {
    if (a.kind !== "npc" || a.flags.jobToolGiven) continue;
    a.flags.jobToolGiven = 1;
    const tool = JOB_TOOL[w.businesses.get(a.jobBiz ?? "")?.kind ?? ""];
    if (tool && a.equip && !TOOL_FOR[resourceOf(tool)]?.includes(a.equip.weapon?.item ?? "wood")) a.equip.weapon = { item: tool, dur: 40 + Math.floor(Math.random() * 50) };
  }
  for (const p of w.players.values()) p.equip ??= starterOutfit(p);
}
