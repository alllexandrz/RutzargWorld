// Crafting & placing things (concept: everything in the world is made by someone).
// Players craft through the craft panel; NPCs craft when they need something:
//   - a family short of beds makes a bed and puts it at home,
//   - builders make the crafted materials a project needs when the market has none,
//   - the town lights dark streets with new lamps,
//   - people without work make goods for the market when it pays.
// Everything an NPC does here goes through the same rules as for players (stations, inputs, placement).

import type { World } from "./world.ts";
import type { Agent, Being, CraftPlan } from "./types.ts";
import { ITEMS, invAdd, itemForObj, marketBuyPrice, marketPrice, type Inventory, type ItemId } from "../../shared/items.ts";
import { RECIPES, RECIPE_BY_OUT, STATION_NAMES, STATION_OBJ, STATION_RANGE, craftMinutes, missingInputs, nearStation, recipeById, type Recipe } from "../../shared/crafting.ts";
import { G, O, areaContains, canPlaceAt, findObjNear, idx, inBounds, isWalkable } from "../../shared/map.ts";
import { changeTile, nearestObj } from "./resources.ts";
import { skillLevel, trainSkill } from "./skillsys.ts";
import { marketBuy, marketSell } from "./economy.ts";
import { newFact, witness } from "./social.ts";
import { goTo, goToArea } from "./brain.ts";
import { isChild } from "./family.ts";
import { reeveId } from "./politics.ts";
import { equipItem, repairItem, repairQuote } from "./gear.ts";
import { repairStation } from "../../shared/gear.ts";
import type { Slot } from "../../shared/items.ts";
import { workshopAt, type Workshop } from "./housing.ts";
import { hourOf, dayOf } from "../../shared/time.ts";

const PLACE_RANGE = 2.6;

// ---------------------------------------------------------------------------
// Shared rules (players and NPCs)
// ---------------------------------------------------------------------------

/** Make one batch of a recipe. Inputs/station are validated here — the engine is authoritative. */
export function craftOnce(w: World, b: Being, rec: Recipe): { ok: boolean; reason?: string } {
  if (!nearStation(w.map, b.x, b.y, rec.station)) return { ok: false, reason: `Потрібно бути біля: ${STATION_NAMES[rec.station]}` };
  const lack = missingInputs(b.inv, rec);
  if (Object.keys(lack).length) return { ok: false, reason: `Бракує: ${fmtItems(lack)}` };
  // someone else's workshop: pay the owner's fee for using the station
  const ws = stationWorkshop(w, b, rec);
  if (ws && !ws.free && ws.fee > 0) {
    if (b.coins < ws.fee) return { ok: false, reason: `Плата за майстерню (${ws.label}): ${ws.fee} срібла — бракує грошей` };
    b.coins -= ws.fee;
    ws.pay(ws.fee);
    if (b.kind === "player") w.selfChanged(b.id);
  }
  for (const [item, n] of Object.entries(rec.inputs) as [ItemId, number][]) invAdd(b.inv, item, -n);
  invAdd(b.inv, rec.out, rec.qty);
  trainSkill(w, b, rec.skill, Math.max(0.3, rec.minutes / 30));
  return { ok: true };
}

/** The premises of the station used for a recipe (null: by hand or outdoors). */
export function stationWorkshop(w: World, b: Being, rec: Recipe): Workshop | null {
  if (rec.station === "hand") return null;
  const t = findObjNear(w.map, b.x, b.y, STATION_OBJ[rec.station], STATION_RANGE);
  return t ? workshopAt(w, b, t.x, t.y) : null;
}

export function fmtItems(m: Partial<Record<ItemId, number>>): string {
  return (Object.entries(m) as [ItemId, number][]).map(([i, n]) => `${ITEMS[i].name.toLowerCase()} ${n}`).join(", ");
}

/** The area (home / workplace) a building tile belongs to. */
function buildingArea(w: World, x: number, y: number): string | null {
  const bi = w.map.bld[idx(x, y)];
  if (bi < 0) return null;
  for (const a of Object.values(w.map.areas)) if (a.building === bi && areaContains(a, x + 0.5, y + 0.5)) return a.id;
  for (const a of Object.values(w.map.areas)) if (a.building === bi) return a.id;
  return null;
}

/** Inside a building one may only furnish one's own home or one's own business. */
function mayUseBuilding(w: World, b: Being, areaId: string | null): boolean {
  if (!areaId) return true;
  const ag = w.agents.get(b.id);
  if (ag && ag.home === areaId) return true;
  if (w.players.get(b.id)?.lodging?.area === areaId && w.homes[areaId]?.tenant === b.id) return true;
  if (w.homes[areaId]?.owner === b.id) return true;
  for (const biz of w.businesses.values()) if (biz.area === areaId && biz.ownerId === b.id) return true;
  return false;
}

export function placeItem(w: World, b: Being, item: ItemId, x: number, y: number, owner = b.id): { ok: boolean; reason?: string } {
  const def = ITEMS[item];
  if (!def || def.obj === undefined) return { ok: false, reason: "Це не можна поставити" };
  if ((b.inv[item] ?? 0) < 1) return { ok: false, reason: `Немає: ${def.name}` };
  x = Math.floor(x); y = Math.floor(y);
  if (Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y) > PLACE_RANGE) return { ok: false, reason: "Задалеко — підійди ближче" };
  const can = canPlaceAt(w.map, x, y, def.obj);
  if (!can.ok) return can;
  if (!mayUseBuilding(w, b, buildingArea(w, x, y))) return { ok: false, reason: "Це чужий дім — тут ставити не можна" };
  // offline players count too: they reappear on the same tile when they come back
  for (const o of [...w.presentBeings(), ...w.players.values()]) if (Math.floor(o.x) === x && Math.floor(o.y) === y) return { ok: false, reason: "Тут хтось стоїть" };
  invAdd(b.inv, item, -1);
  changeTile(w, x, y, null, def.obj);
  w.res.placed[idx(x, y)] = { item, by: owner };
  return { ok: true };
}

/**
 * Dismantle the nearest placeable thing and take it. Taking what isn't yours is theft —
 * the same facts, witnesses and guards as pickpocketing.
 */
export function pickupNear(w: World, b: Being): { ok: boolean; reason?: string; item?: ItemId; stolenFrom?: string } {
  let best: { x: number; y: number; item: ItemId } | null = null, bd = Infinity;
  const tx = Math.floor(b.x), ty = Math.floor(b.y);
  for (let y = ty - 2; y <= ty + 2; y++)
    for (let x = tx - 2; x <= tx + 2; x++) {
      if (!inBounds(x, y)) continue;
      const item = itemForObj(w.map.obj[idx(x, y)]);
      if (!item) continue;
      const d = Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y);
      if (d < 1.7 && d < bd) { bd = d; best = { x, y, item }; }
    }
  if (!best) return { ok: false, reason: "Поруч немає нічого, що можна розібрати" };
  const i = idx(best.x, best.y);
  const placed = w.res.placed[i];
  const area = buildingArea(w, best.x, best.y);
  if (!placed && area) return { ok: false, reason: "Це частина будинку — так просто не винесеш" };
  const owner = placed?.by ?? "town";
  changeTile(w, best.x, best.y, null, O.NONE);
  delete w.res.placed[i];
  invAdd(b.inv, best.item, 1);
  const mine = owner === b.id || (b.spouse && owner === b.spouse) || (area && mayUseBuilding(w, b, area));
  if (mine) return { ok: true, item: best.item };
  const victim = owner === "town" ? reeveId(w) : owner;
  const f = newFact(w, "theft", { actor: b.id, target: victim, amount: ITEMS[best.item].basePrice, place: w.areaName(b.x, b.y) });
  w.log(`${b.name} розбирає й забирає чуже: ${ITEMS[best.item].name.toLowerCase()} (${w.areaName(b.x, b.y)}).`, "crime");
  witness(w, f, b.x, b.y, { exclude: [b.id] });
  return { ok: true, item: best.item, stolenFrom: w.nameOf(victim) };
}

// ---------------------------------------------------------------------------
// NPC crafting: executing a plan
// ---------------------------------------------------------------------------

type Step =
  | { kind: "buy"; item: ItemId; qty: number }
  | { kind: "craft"; rec: Recipe }
  | { kind: "fail"; why: string };

/** Next concrete thing to do to have `need` × item: buy it, or craft it (recursively craft/buy inputs first). */
function nextStep(w: World, a: Agent, item: ItemId, need: number, plan: CraftPlan, depth = 0): Step {
  const rec = RECIPE_BY_OUT[item];
  const forSale = plan.use.kind === "sell" && item === plan.item;
  // Needs-driven crafters buy a finished thing if the market has it — it's what people do.
  if (!forSale && w.marketStock(item) >= need && (!rec || depth > 0 || plan.payer === "guild")) return { kind: "buy", item, qty: need };
  if (!rec) return w.marketStock(item) > 0 ? { kind: "buy", item, qty: Math.min(need, w.marketStock(item)) } : { kind: "fail", why: `на ринку немає: ${ITEMS[item].name.toLowerCase()}` };
  if (depth > 4) return { kind: "fail", why: "надто складно" };
  const lack = missingInputs(a.inv, rec);
  const first = (Object.entries(lack) as [ItemId, number][])[0];
  if (!first) return { kind: "craft", rec };
  return nextStep(w, a, first[0], first[1], plan, depth + 1);
}

function stationNear(w: World, a: Agent, rec: Recipe): { x: number; y: number } | null {
  if (rec.station === "hand") return { x: a.x, y: a.y };
  // A station in someone else's home is private; workshops and public places are fine.
  const allowed = (x: number, y: number) => {
    const area = buildingArea(w, x, y);
    return !area || area === a.home || !isHome(w, area);
  };
  // prefer one that costs nothing (own workplace, outdoors), then any — the fee is paid on use
  const free = nearestObj(w, a.x, a.y, STATION_OBJ[rec.station], 60, (x, y) => {
    if (!allowed(x, y)) return false;
    const ws = workshopAt(w, a, x, y);
    return !ws || ws.free || ws.fee === 0;
  });
  return free ?? nearestObj(w, a.x, a.y, STATION_OBJ[rec.station], 60, allowed);
}

function walkNextTo(w: World, a: Agent, t: { x: number; y: number }): boolean {
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const x = t.x + dx, y = t.y + dy;
    if (isWalkable(w.map, x, y) && goTo(w, a, x + 0.5, y + 0.5)) return true;
  }
  return false;
}

function dropPlan(w: World, a: Agent, why: string) {
  const pl = a.craftPlan;
  if (!pl) return;
  a.flags[`craftFail_${pl.item}`] = w.time;
  w.log(`${a.name} кидає задум (${ITEMS[pl.item].name.toLowerCase()}): ${why}.`, "craft");
  a.craftPlan = null;
  a.nextThinkAt = w.time;
}

function fail(w: World, a: Agent, why: string) {
  const pl = a.craftPlan!;
  pl.fails = (pl.fails ?? 0) + 1;
  if (pl.fails >= 4) return dropPlan(w, a, why);
  // try again a bit later
  a.nextThinkAt = w.time + 30;
  a.activity = { type: "idle", label: `чекає (${why})`, started: w.time };
}

/** Pay for market goods: the guild advances the money to its builder for project materials. */
function fund(w: World, a: Agent, plan: CraftPlan, cost: number): boolean {
  if (plan.payer === "self") return a.coins >= cost;
  const guild = w.businesses.get("builders");
  if (!guild) return false;
  if (guild.treasury < cost) {
    const top = Math.min(w.townTreasury, cost - guild.treasury + 5);
    w.townTreasury -= top; guild.treasury += top;
  }
  if (guild.treasury < cost) return false;
  guild.treasury -= cost;
  a.coins += cost;
  return true;
}

function priceOf(w: World, item: ItemId, qty: number): number {
  let c = 0;
  for (let i = 0; i < qty; i++) c += marketPrice(item, w.marketStock(item) - i);
  return c;
}

/** Called every tick while an NPC's activity is "craft" and it isn't walking. */
export function doCraft(w: World, a: Agent) {
  const pl = a.craftPlan;
  if (!pl) { a.activity = { type: "idle", label: "стоїть", started: w.time }; a.nextThinkAt = w.time; return; }
  if (w.time - pl.started > 3 * 1440) return dropPlan(w, a, "минуло надто багато часу");
  if (pl.use.kind === "repair") return doRepair(w, a, pl, pl.use.slot);

  // 1) a craft in progress
  if (pl.busyUntil !== undefined) {
    if (w.time < pl.busyUntil) { a.anim = "work"; return; }
    const rec = recipeById(pl.busyRecipe ?? "");
    pl.busyUntil = undefined; pl.busyRecipe = undefined;
    if (rec) {
      const r = craftOnce(w, a, rec);
      if (!r.ok) return fail(w, a, r.reason ?? "не вийшло");
    }
  }

  // 2) done making → use it
  if ((a.inv[pl.item] ?? 0) >= pl.qty) return useResult(w, a, pl);

  // 3) next step
  let step = nextStep(w, a, pl.item, pl.qty - (a.inv[pl.item] ?? 0), pl);
  // can't make it (no raw materials anywhere) — buy the finished thing if the market has one
  if (step.kind === "fail" && pl.use.kind !== "sell" && w.marketStock(pl.item) > 0)
    step = { kind: "buy", item: pl.item, qty: Math.min(pl.qty - (a.inv[pl.item] ?? 0), w.marketStock(pl.item)) };
  if (step.kind === "fail") return fail(w, a, step.why);
  if (step.kind === "buy") {
    if (!areaContains(w.map.areas.market, a.x, a.y)) {
      a.activity.label = `іде на ринок по ${ITEMS[step.item].name.toLowerCase()}`;
      if (!goToArea(w, a, "market")) fail(w, a, "не дійти до ринку");
      return;
    }
    const qty = Math.min(step.qty, w.marketStock(step.item));
    const cost = priceOf(w, step.item, qty);
    if (qty <= 0 || !fund(w, a, pl, cost)) return fail(w, a, "бракує грошей на матеріали");
    const r = marketBuy(w, a, step.item, qty);
    if (!r.ok) return fail(w, a, r.reason);
    return;
  }
  // craft: get to a station
  const rec = step.rec;
  if (!nearStation(w.map, a.x, a.y, rec.station)) {
    const st = stationNear(w, a, rec);
    if (!st) return fail(w, a, `ніде немає: ${STATION_NAMES[rec.station]}`);
    a.activity.label = `іде до: ${STATION_NAMES[rec.station]}`;
    if (!walkNextTo(w, a, st)) fail(w, a, `не дійти до: ${STATION_NAMES[rec.station]}`);
    return;
  }
  pl.busyRecipe = rec.id;
  pl.busyUntil = w.time + craftMinutes(rec, skillLevel(a, rec.skill));
  a.activity.label = `майструє: ${ITEMS[rec.out].name.toLowerCase()}`;
  a.anim = "work";
}

/** Take a worn thing to a workshop and have it fixed. */
function doRepair(w: World, a: Agent, pl: CraftPlan, slot: Slot) {
  const worn = a.equip?.[slot];
  if (!worn || worn.item !== pl.item || worn.dur >= 100) { a.craftPlan = null; a.nextThinkAt = w.time; return; }
  if (repairQuote(w, a, slot)) {
    const r = repairItem(w, a, slot);
    if (!r.ok) return dropPlan(w, a, r.reason);
    a.craftPlan = null;
    a.nextThinkAt = w.time;
    return;
  }
  const st = stationNear(w, a, { station: repairStation(worn.item) } as Recipe);
  if (!st) return fail(w, a, "ніде полагодити");
  a.activity.label = `несе лагодити: ${ITEMS[worn.item].name.toLowerCase()}`;
  if (!walkNextTo(w, a, st)) fail(w, a, "не дійти до майстерні");
}

function useResult(w: World, a: Agent, pl: CraftPlan) {
  const name = ITEMS[pl.item].name.toLowerCase();
  switch (pl.use.kind) {
    case "keep":
      w.log(`${a.name} змайстрував(ла) собі: ${name}.`, "craft");
      a.craftPlan = null;
      return;
    case "equip":
      equipItem(w, a, pl.item);
      w.log(`${a.name} має обнову: ${name}.`, "craft");
      a.craftPlan = null;
      return;
    case "sell": {
      if (!areaContains(w.map.areas.market, a.x, a.y)) { a.activity.label = `несе на ринок: ${name}`; if (!goToArea(w, a, "market")) fail(w, a, "не дійти до ринку"); return; }
      const r = marketSell(w, a, pl.item, pl.qty);
      if (r.ok) w.log(`${a.name} продає на ринку власноруч зроблене: ${name} ×${pl.qty} за ${r.total} срібла.`, "craft");
      a.craftPlan = null;
      return;
    }
    case "deliver": {
      const p = w.projects.find((x) => x.plotId === (pl.use as { project: string }).project);
      if (!p) { a.craftPlan = null; return; } // project gone: keep the thing
      if (!areaContains(w.map.areas[p.plotId] ?? w.map.areas.market, a.x, a.y)) { a.activity.label = `несе на будову: ${name}`; if (!goToArea(w, a, p.plotId)) fail(w, a, "не дійти до будови"); return; }
      invAdd(a.inv, pl.item, -pl.qty);
      p.delivered[pl.item] = (p.delivered[pl.item] ?? 0) + pl.qty;
      w.log(`${a.name} приносить на будову власноруч зроблене: ${name} ×${pl.qty}.`, "craft");
      a.craftPlan = null;
      return;
    }
    case "place": {
      const u = pl.use;
      let spot: { x: number; y: number } | null = { x: u.x, y: u.y };
      if (!canPlaceAt(w.map, spot.x, spot.y, ITEMS[pl.item].obj!).ok) spot = u.area ? freeSpotIn(w, u.area, ITEMS[pl.item].obj!) : null;
      if (!spot) return dropPlan(w, a, "немає де поставити");
      u.x = spot.x; u.y = spot.y;
      if (Math.hypot(spot.x + 0.5 - a.x, spot.y + 0.5 - a.y) > 1.8) {
        a.activity.label = `несе ${name} на місце`;
        if (!walkNextTo(w, a, spot)) fail(w, a, "не підійти до місця");
        return;
      }
      const owner = pl.payer === "guild" ? "town" : a.id;
      const r = placeItem(w, a, pl.item, spot.x, spot.y, owner);
      if (!r.ok) return fail(w, a, r.reason ?? "не вдалося поставити");
      const where = u.area ? w.map.areas[u.area]?.name ?? "" : w.areaName(spot.x, spot.y);
      w.log(`${a.name} ставить ${name}${where ? ` (${where})` : ""}.`, "craft");
      if (pl.item === "bed") w.say(a.id, "Ось і ще одне ліжко. Тепер усім вистачить місця.");
      a.craftPlan = null;
      return;
    }
  }
}

/** A free tile inside an area where the object can stand (keeps the room walkable). */
export function freeSpotIn(w: World, areaId: string, obj: number): { x: number; y: number } | null {
  const ar = w.map.areas[areaId];
  if (!ar) return null;
  const spots: { x: number; y: number }[] = [];
  for (let y = ar.y; y < ar.y + ar.h; y++)
    for (let x = ar.x; x < ar.x + ar.w; x++) if (canPlaceAt(w.map, x, y, obj).ok) spots.push({ x, y });
  // prefer corners/walls: tiles with the most blocked neighbours
  const blocked = (x: number, y: number) => [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => !isWalkable(w.map, x + dx, y + dy)).length;
  spots.sort((p, q) => blocked(q.x, q.y) - blocked(p.x, p.y));
  return spots[0] ?? null;
}

// ---------------------------------------------------------------------------
// NPC crafting: deciding what to make
// ---------------------------------------------------------------------------

/** Private homes (not the tavern, temple, residence...). */
function isHome(w: World, areaId: string): boolean {
  return !!w.map.areas[areaId]?.building && !["tavern", "temple", "residence", "grove", "jail", "smithy", "warehouse"].includes(areaId) &&
    [...w.agents.values()].some((a) => a.home === areaId);
}

export function canTakePlan(w: World, a: Agent): boolean {
  return a.kind === "npc" && !a.craftPlan && !w.isJailed(a) && !isChild(w, a);
}

export function assignPlan(w: World, a: Agent, plan: Omit<CraftPlan, "started">, announce?: string) {
  a.craftPlan = { ...plan, started: w.time };
  a.nextThinkAt = w.time;
  if (announce) w.log(announce, "craft");
}

/**
 * Coins needed to make `qty` × item from what's in the bag plus market goods (recursive).
 * Uses the bag first; market prices include the rise as stock is bought out. `inv` is consumed (pass a copy).
 */
export function materialCost(w: World, item: ItemId, qty = 1, inv: Inventory = {}, depth = 0): number {
  const have = Math.min(qty, inv[item] ?? 0);
  if (have) { inv[item] = (inv[item] ?? 0) - have; qty -= have; }
  if (qty <= 0) return 0;
  const rec = RECIPE_BY_OUT[item];
  if (!rec || depth > 4) {
    let c = 0;
    for (let i = 0; i < qty; i++) c += marketPrice(item, w.marketStock(item) - i);
    return c;
  }
  const batches = Math.ceil(qty / rec.qty);
  let c = 0;
  for (const [i, n] of Object.entries(rec.inputs) as [ItemId, number][]) c += materialCost(w, i, n * batches, inv, depth + 1);
  return c;
}

/** Families short of beds make one themselves (cheaper and faster than waiting for a new house). */
function householdBeds(w: World, bedsShort: (areaId: string) => number) {
  for (const home of new Set([...w.agents.values()].map((a) => a.home))) {
    if (!isHome(w, home) || bedsShort(home) <= 0) continue;
    const people = [...w.agents.values()].filter((a) => a.home === home);
    if (people.some((a) => a.craftPlan?.item === "bed")) continue;
    const spot = freeSpotIn(w, home, O.BED);
    if (!spot) continue;
    const cost = materialCost(w, "bed");
    const maker = people
      .filter((a) => canTakePlan(w, a) && a.coins >= cost + 3)
      .sort((x, y) => skillLevel(y, "carpentry") - skillLevel(x, "carpentry") || y.coins - x.coins)[0];
    if (!maker) continue;
    assignPlan(w, maker, { item: "bed", qty: 1, use: { kind: "place", x: spot.x, y: spot.y, area: home }, payer: "self", label: "майструє ліжко для дому", priority: 0.75 },
      `${maker.name}: у домі тісно — вирішує сам змайструвати ліжко (${w.map.areas[home]?.name ?? home}).`);
  }
}

/** Is someone in this home already making a bed for it? (housing waits for them) */
export function bedPlanned(w: World, home: string): boolean {
  for (const a of w.agents.values()) if (a.home === home && a.craftPlan?.item === "bed" && a.craftPlan.use.kind === "place") return true;
  return false;
}

/** Builders make crafted materials a project needs when the market can't supply them. */
export function builderCrafts(w: World, item: ItemId, missing: number, projectId: string): boolean {
  if (!RECIPE_BY_OUT[item] || w.marketStock(item) >= missing) return false;
  const guild = w.businesses.get("builders");
  if (!guild) return false;
  const already = [...w.agents.values()].filter((a) => a.craftPlan?.use.kind === "deliver" && a.craftPlan.item === item)
    .reduce((n, a) => n + a.craftPlan!.qty, 0);
  if (already >= missing) return true;
  const who = guild.workers.map((id) => w.agents.get(id)).find((a): a is Agent => !!a && canTakePlan(w, a));
  if (!who) return true;
  const batch = ITEMS[item].group === "placeable" ? 2 : RECIPE_BY_OUT[item]!.qty * 3;
  const qty = Math.min(batch, missing - already);
  assignPlan(w, who, { item, qty, use: { kind: "deliver", project: projectId }, payer: "guild", label: `майструє для будови: ${ITEMS[item].name.toLowerCase()}`, priority: 0.9 },
    `${who.name} (будівельна артіль): на ринку немає «${ITEMS[item].name}», тож робить сам ×${qty}.`);
  return true;
}

/** The town lights dark streets near houses (one lamp a day while the treasury allows). */
function townLamps(w: World) {
  if (w.townTreasury < 350) return;
  const townLampsCount = Object.values(w.res.placed).filter((p) => p.by === "town" && p.item === "lamp").length;
  if (townLampsCount >= 24) return;
  if ([...w.agents.values()].some((a) => a.craftPlan?.item === "lamp" && a.craftPlan.payer === "guild")) return;
  // darkest street tile next to a building door
  let best: { x: number; y: number } | null = null, bestD = 0;
  for (const b of w.map.buildings) {
    if (w.map.plots.some((p) => p.buildingId === b.id && w.map.plotStage[p.id] !== "built")) continue;
    for (let y = b.door.y - 4; y <= b.door.y + 4; y++)
      for (let x = b.door.x - 4; x <= b.door.x + 4; x++) {
        if (!inBounds(x, y) || w.map.bld[idx(x, y)] >= 0) continue;
        const g = w.map.ground[idx(x, y)];
        if (g !== G.COBBLE && g !== G.DIRT) continue;
        if (!canPlaceAt(w.map, x, y, O.LAMP).ok) continue;
        let d = Infinity;
        for (const l of w.map.lights) d = Math.min(d, Math.hypot(l.x - x - 0.5, l.y - y - 0.5));
        if (d > bestD) { bestD = d; best = { x, y }; }
      }
  }
  if (!best || bestD < 7) return;
  const guild = w.businesses.get("builders");
  const who = (guild?.workers ?? []).map((id) => w.agents.get(id)).find((a): a is Agent => !!a && canTakePlan(w, a));
  if (!who) return;
  assignPlan(w, who, { item: "lamp", qty: 1, use: { kind: "place", x: best.x, y: best.y }, payer: "guild", label: "робить вуличний ліхтар для міста", priority: 0.85 },
    `${w.nameOf(reeveId(w))} доручає ${who.name} поставити новий ліхтар: вулиця тоне в темряві (${w.areaName(best.x, best.y)}).`);
}

/** People without work make things the market lacks, if it pays. */
function artisans(w: World) {
  const h = hourOf(w.time);
  if (h < 8 || h > 15) return;
  for (const a of w.agents.values()) {
    if (!canTakePlan(w, a) || a.jobBiz || a.profession === "moneylender" || a.coins < 8) continue;
    if ((a.flags.craftCheckDay ?? -1) === dayOf(w.time) * 24 + h) continue;
    a.flags.craftCheckDay = dayOf(w.time) * 24 + h;
    if (Math.random() < 0.5) continue;
    let best: { item: ItemId; gain: number } | null = null;
    for (const rec of RECIPES) {
      const def = ITEMS[rec.out];
      if (rec.out === "meal" || w.marketStock(rec.out) >= def.targetStock) continue;
      if ((a.flags[`craftFail_${rec.out}`] ?? -1e9) > w.time - 1440) continue; // tried and failed recently
      const cost = materialCost(w, rec.out, rec.qty, { ...a.inv });
      if (cost * 1.2 > a.coins - 3) continue;
      const sell = marketBuyPrice(rec.out, w.marketStock(rec.out)) * rec.qty;
      const hours = rec.minutes / 60 + 0.5;
      const gain = (sell - cost) / hours * (0.6 + skillLevel(a, rec.skill) / 100);
      if (gain > 2 && (!best || gain > best.gain)) best = { item: rec.out, gain };
    }
    if (!best) continue;
    const rec = RECIPE_BY_OUT[best.item]!;
    assignPlan(w, a, { item: best.item, qty: rec.qty, use: { kind: "sell" }, payer: "self", label: `майструє на продаж: ${ITEMS[best.item].name.toLowerCase()}`, priority: 0.6 },
      `${a.name} без роботи — береться майструвати на продаж: ${ITEMS[best.item].name.toLowerCase()}.`);
  }
}

export function onHourCrafting(w: World, hour: number, bedsShort: (areaId: string) => number) {
  if (hour === 7) householdBeds(w, bedsShort);
  if (hour === 10) townLamps(w);
  artisans(w);
}
