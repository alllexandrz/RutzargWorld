// Equipment rules for players and NPCs alike: putting things on, wear and tear,
// tools that speed up work, scuffles when a guard tries to arrest an armed person,
// and NPCs who want proper clothes and the right tool for their trade.

import type { World } from "./world.ts";
import type { Agent, Being } from "./types.ts";
import { ITEMS, invAdd, type ItemId, type Slot } from "../../shared/items.ts";
import { SLOTS, WEAR, gearStats, type CharStats, type Equipment } from "../../shared/gear.ts";
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

/** Using the tool wears it (only when it actually helps with this resource). */
export function useTool(w: World, b: Being, resource: ItemId, amount: number) {
  if (toolBonus(b, resource) > 0) wearOut(w, b, "weapon", amount);
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
    case "lumberjack": eq.weapon = { item: "axe", dur: 30 }; break;
    case "farmer": eq.weapon = { item: "sickle", dur: dur() }; break;
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

const JOB_TOOL: Record<string, ItemId> = { lumber: "axe", mine: "pickaxe", quarry: "pickaxe", farm: "sickle" };

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
    const cost = materialCost(w, pick.item, 1, { ...a.inv });
    const reserve = pick.urgent ? 4 : 25;
    if (cost > a.coins - reserve) continue;
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
  for (const p of w.players.values()) p.equip ??= starterOutfit(p);
}
