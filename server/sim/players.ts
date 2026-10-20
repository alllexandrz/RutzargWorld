// Player actions. Every action is validated by the engine (distance, money, location...).
// Players use the same systems as NPCs: market, needs, theft/witnesses, employment.

import type { World } from "./world.ts";
import type { Player } from "./types.ts";
import { INPUT_DT, PLAYER_SPEED, INTERACT_RANGE, START_COINS } from "../../shared/constants.ts";
import { stepMove, facingFromDir } from "../../shared/move.ts";
import { G, O, areaContains, canPlant, findObjNear, groundAt, buildingAt, getMap, idx, isWalkable, randomSpotIn } from "../../shared/map.ts";
import { ITEMS, invAdd, type ItemId } from "../../shared/items.ts";
import { buyBusiness, buyMeal, leaveJob, marketBuy, marketSell, mealPrice, sellFromStock } from "./economy.ts";
import { adjustRel, learnFact, newFact, witness } from "./social.ts";
import { releaseIfDue } from "./brain.ts";
import type { Look } from "../../shared/protocol.ts";
import type { SkillId } from "../../shared/skills.ts";
import { trainSkill } from "./skillsys.ts";
import { dayOf } from "../../shared/time.ts";
import type { C2S } from "../../shared/protocol.ts";
import { atResidence, castVote, donate, embezzle, isPrivatisable, pardon, registerCandidate, setTax, signPetition } from "./politics.ts";
import { harvestTile, plantSapling, remaining } from "./resources.ts";
import { STATION_NAMES, craftMinutes, missingInputs, nearStation, recipeById } from "../../shared/crafting.ts";
import { craftOnce, fmtItems, pickupNear, placeItem } from "./crafting.ts";
import { skillLevel } from "./skillsys.ts";
import { starterOutfit, toolBonus, toolFor, toolNames, useTool } from "./gear.ts";
import { atLodging, bedPrice } from "./housing.ts";

const lastMoveAt = new Map<string, number>();

export function createPlayer(w: World, id: string, name: string, token: string, look: Look, gender: "m" | "f"): Player {
  const spot = randomSpotIn(getMap(), w.map.areas.gate);
  const p: Player = {
    id, name, kind: "player", gender, x: spot.x, y: spot.y, facing: 4, anim: "idle", look,
    coins: START_COINS, inv: {}, hunger: 80, energy: 90, faction: "varon", socialClass: "UNBOUND",
    jailedUntil: null, jobBiz: null, skills: {}, token, online: true, lastInputSeq: 0, moveDir: { x: 0, y: 0 },
    inputBudget: 0, busy: null, ownedBusinesses: [], blessing: false, lastTalkReward: {},
    joinedAt: w.time,
  };
  p.equip = starterOutfit(p);
  w.players.set(id, p);
  w.log(`До Каргата через східну браму приходить ${p.gender === "f" ? "мандрівниця" : "мандрівник"} ${name}.`, "player");
  return p;
}

export function tickPlayers(w: World, dt: number) {
  const now = Date.now();
  for (const p of w.players.values()) {
    if (!p.online) continue;
    releaseIfDue(w, p);
    p.inputBudget = Math.min(0.5, p.inputBudget + dt);
    if (w.isJailed(p)) { p.anim = "jail"; continue; }
    if (p.busy) {
      const progress = (now - p.busy.start) / p.busy.dur;
      if (p.busy.kind === "rest") {
        p.energy = Math.min(100, p.energy + 2.2 * dt * (p.busy.rate ?? 1));
        if (p.energy >= 100) { p.busy = null; w.toast(p.id, "Ти добре відпочив.", "good"); w.selfChanged(p.id); }
      } else if (progress >= 1) completeBusy(w, p);
    }
    const moving = now - (lastMoveAt.get(p.id) ?? 0) < 160;
    p.anim = moving ? "walk" : p.busy ? (p.busy.kind === "rest" ? "sleep" : p.busy.kind === "eat" ? "eat" : p.busy.kind === "pray" ? "pray" : "work") : "idle";
  }
}

/** Apply one fixed-step movement input from the client (prediction-friendly). */
export function applyInput(w: World, p: Player, seq: number, dx: number, dy: number) {
  if (seq <= p.lastInputSeq) return;
  p.lastInputSeq = seq;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return;
  if (p.inputBudget < INPUT_DT * 0.5) return; // anti speed-hack: never faster than real time
  p.inputBudget -= INPUT_DT;
  if (p.busy) { p.busy = null; w.selfChanged(p.id); }
  const speed = PLAYER_SPEED * (p.hunger < 5 || p.energy < 5 ? 0.6 : 1);
  stepMove(w.map, p, dx, dy, speed, INPUT_DT);
  p.facing = facingFromDir(dx, dy, p.facing);
  lastMoveAt.set(p.id, Date.now());
}

// ---------------------------------------------------------------------------
// Long actions
// ---------------------------------------------------------------------------

function startBusy(w: World, p: Player, kind: NonNullable<Player["busy"]>["kind"], label: string, durMs: number, item?: ItemId, tile?: { x: number; y: number }, extra: Partial<NonNullable<Player["busy"]>> = {}) {
  p.busy = { kind, label, start: Date.now(), dur: durMs, item, tile, ...extra };
  w.selfChanged(p.id);
}

function completeBusy(w: World, p: Player) {
  const b = p.busy!;
  p.busy = null;
  switch (b.kind) {
    case "gather": {
      const item = b.item!;
      // no tool in hand any more (broke, taken off) — nothing to dig with
      if (!toolFor(w, p, item)) { w.toast(p.id, `Нема чим працювати: потрібна ${toolNames(item)}.`, "bad"); break; }
      // The resource itself is finite: take one unit from the actual tree / rock / bush.
      if (b.tile && !harvestTile(w, b.tile.x, b.tile.y)) { w.toast(p.id, "Тут уже нічого не лишилося.", "bad"); break; }
      invAdd(p.inv, item, 1);
      p.energy = Math.max(0, p.energy - 1.5);
      useTool(w, p, item, 1);
      trainSkill(w, p, GATHER_SKILL[item], 0.35);
      let msg = `+1 ${ITEMS[item].name}`;
      if (item === "wood" && Math.random() < 0.25) { invAdd(p.inv, "sapling", 1); msg += ", +1 Саджанець"; }
      if (b.tile && remaining(w, b.tile.x, b.tile.y) <= 0) msg += item === "wood" ? " — дерево зрубано" : item === "herbs" ? " — кущ обібрано" : " — скелю вибрано";
      w.toast(p.id, msg, "good");
      // keep gathering automatically while a resource remains in reach
      const next = resourceNear(w, p);
      if (p.energy > 3 && next && next.item === item && toolFor(w, p, item)) startBusy(w, p, "gather", b.label, gatherTime(p, item), item, next.tile);
      break;
    }
    case "craft": {
      const rec = recipeById(b.recipe ?? "");
      if (!rec) break;
      const r = craftOnce(w, p, rec);
      if (!r.ok) { w.toast(p.id, r.reason ?? "Не вийшло", "bad"); break; }
      w.toast(p.id, `Зроблено: ${ITEMS[rec.out].name}${rec.qty > 1 ? ` ×${rec.qty}` : ""}`, "good");
      const left = (b.left ?? 1) - 1;
      if (left > 0 && !Object.keys(missingInputs(p.inv, rec)).length) startCraft(w, p, rec.id, left);
      break;
    }
    case "eat":
      if ((p.inv.meal ?? 0) > 0) { invAdd(p.inv, "meal", -1); p.hunger = Math.min(100, p.hunger + 65); w.toast(p.id, "Смачно! Ситість відновлено.", "good"); }
      break;
    case "pray": {
      const vael = w.agents.get("vael");
      if (vael && areaContains(w.map.areas.grove, p.x, p.y) && Math.hypot(vael.x - p.x, vael.y - p.y) < 6) {
        const last = p.lastTalkReward["vael_pray"] ?? 0;
        if (Date.now() - last > 60_000) {
          p.lastTalkReward["vael_pray"] = Date.now();
          adjustRel(vael, p.id, { respect: 4, trust: 2 });
          w.toast(p.id, "Ваель відчуває твою присутність. Ефір довкола тремтить.", "info");
        } else w.toast(p.id, "Тиша гаю огортає тебе.", "info");
      } else {
        p.energy = Math.min(100, p.energy + 5);
        w.toast(p.id, "Молитва заспокоює душу. (+5 енергії)", "info");
      }
      break;
    }
    default: break;
  }
  w.selfChanged(p.id);
}

const GATHER_SKILL: Record<string, SkillId> = { wood: "woodcutting", ore: "mining", stone: "mining", grain: "farming", herbs: "herbalism" };

function gatherTime(p: Player, item: ItemId): number {
  const base = (p.inv.tools ?? 0) > 0 ? 1600 : 2400;
  // Novice ~3 s, master ~2 s per item (players shouldn't feel crippled at start).
  const level = p.skills?.[GATHER_SKILL[item]] ?? 0;
  // the right tool in hand (axe for trees, pickaxe for rocks, sickle for fields)
  return Math.round(base / (0.8 + level / 250) / (1 + toolBonus(p, item)));
}

/** The nearest gatherable resource and its tile (fields are endless; trees/rocks/herbs deplete). */
function resourceNear(w: World, p: Player): { item: ItemId; tile?: { x: number; y: number } } | null {
  for (const [obj, item] of [[O.TREE, "wood"], [O.ORE_ROCK, "ore"], [O.ROCK, "stone"], [O.HERB, "herbs"]] as const) {
    const t = findObjNear(w.map, p.x, p.y, obj, 1.2);
    if (t) return { item, tile: t };
  }
  if (groundAt(w.map, p.x, p.y) === G.FIELD) return { item: "grain" };
  return null;
}

// ---------------------------------------------------------------------------
// Crafting & building
// ---------------------------------------------------------------------------

/** Real ms per game minute of crafting for players (a bed ≈ 16 s for a novice). */
const CRAFT_MS_PER_MIN = 400;

function startCraft(w: World, p: Player, recipe: string, n: number) {
  const rec = recipeById(recipe)!;
  const ms = craftMinutes(rec, skillLevel(p, rec.skill)) * CRAFT_MS_PER_MIN;
  startBusy(w, p, "craft", `Майструє: ${ITEMS[rec.out].name}${n > 1 ? ` (ще ${n})` : ""}`, ms, rec.out, undefined, { recipe, left: n });
}

export function playerCraft(w: World, p: Player, recipe: string, n: number) {
  if (w.isJailed(p)) return w.toast(p.id, "За ґратами не помайструєш.", "bad");
  const rec = recipeById(recipe);
  if (!rec) return;
  if (!nearStation(w.map, p.x, p.y, rec.station)) return w.toast(p.id, `Для цього потрібно бути біля: ${STATION_NAMES[rec.station]}.`, "bad");
  const lack = missingInputs(p.inv, rec);
  if (Object.keys(lack).length) return w.toast(p.id, `Бракує: ${fmtItems(lack)}.`, "bad");
  if (p.energy < 2) return w.toast(p.id, "Ти надто втомлений. Відпочинь.", "bad");
  startCraft(w, p, rec.id, Math.max(1, Math.min(20, Math.floor(n) || 1)));
}

export function playerPlace(w: World, p: Player, item: ItemId, x: number, y: number) {
  if (w.isJailed(p) || !ITEMS[item] || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const r = placeItem(w, p, item, x, y);
  if (!r.ok) return w.toast(p.id, r.reason ?? "Не можна", "bad");
  trainSkill(w, p, "building", 0.15);
  w.selfChanged(p.id);
}

export function playerPickup(w: World, p: Player) {
  if (w.isJailed(p)) return;
  const r = pickupNear(w, p);
  if (!r.ok) return w.toast(p.id, r.reason ?? "Нічого", "bad");
  w.toast(p.id, r.stolenFrom ? `Ти забрав ${ITEMS[r.item!].name.toLowerCase()} — це належало: ${r.stolenFrom}!` : `Розібрано: ${ITEMS[r.item!].name}`, r.stolenFrom ? "bad" : "good");
  w.selfChanged(p.id);
}

export function playerAct(w: World, p: Player, a: "gather" | "eat" | "rest" | "pray" | "cancel" | "plant") {
  if (w.isJailed(p) && a !== "rest") return w.toast(p.id, "За ґратами не дуже розгуляєшся.", "bad");
  switch (a) {
    case "cancel": p.busy = null; w.selfChanged(p.id); return;
    case "plant": {
      if ((p.inv.sapling ?? 0) < 1) return w.toast(p.id, "Немає саджанців. Їх дає рубка дерев, або купи на ринку.", "bad");
      if (!toolFor(w, p, "sapling")) return w.toast(p.id, "Щоб посадити дерево, потрібна лопата.", "bad");
      // prefer a stump nearby, else any free spot next to the player
      let spot: { x: number; y: number } | null = findObjNear(w.map, p.x, p.y, O.STUMP, 1.6);
      if (!spot) {
        const tx = Math.floor(p.x), ty = Math.floor(p.y);
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]])
          if (canPlant(w.map, tx + dx, ty + dy)) { spot = { x: tx + dx, y: ty + dy }; break; }
      }
      if (!spot || !plantSapling(w, spot.x, spot.y)) return w.toast(p.id, "Тут не можна садити (лише поза містом, на траві, землі чи пні).", "bad");
      invAdd(p.inv, "sapling", -1);
      useTool(w, p, "sapling", 1);
      trainSkill(w, p, "woodcutting", 0.2);
      w.toast(p.id, "Саджанець посаджено. За 3 дні виросте дерево.", "good");
      w.selfChanged(p.id);
      return;
    }
    case "gather": {
      const found = resourceNear(w, p);
      if (!found) return w.toast(p.id, "Поруч немає ресурсів. Підійди до дерева, скелі (камінь/руда), трав або поля.", "bad");
      const item = found.item;
      if (p.energy < 3) return w.toast(p.id, "Ти надто втомлений. Відпочинь.", "bad");
      // resources are extracted with tools: axe, pickaxe, sickle...
      const tool = toolFor(w, p, item);
      if (!tool) return w.toast(p.id, `Голими руками не вийде: для «${ITEMS[item].name}» потрібна ${toolNames(item)}. Купи на ринку (M), викуй у кузні або позич грошей у лихваря Горста.`, "bad");
      if (item === "grain" && !p.lastTalkReward["farm_warned"]) {
        p.lastTalkReward["farm_warned"] = 1;
        const irma = w.agents.get("irma");
        if (irma && Math.hypot(irma.x - p.x, irma.y - p.y) < 8) {
          w.say(irma.id, "Гей! Це моє поле. Збирай, але пам'ятай — я все бачу.");
          adjustRel(irma, p.id, { trust: -5 });
        }
      }
      startBusy(w, p, "gather", `Збирає: ${ITEMS[item].name}`, gatherTime(p, item), item, found.tile);
      return;
    }
    case "eat": {
      if ((p.inv.meal ?? 0) > 0) return startBusy(w, p, "eat", "Їсть", 1500);
      if (areaContains(w.map.areas.tavern, p.x, p.y)) {
        const price = buyMeal(w, p);
        if (price === null) return w.toast(p.id, `Миска юшки коштує ${mealPrice(w)} срібла.`, "bad");
        w.say("brana", "Смачного! Заходь ще.");
        w.toast(p.id, `Ти поїв у таверні за ${price} срібла.`, "good");
        w.selfChanged(p.id);
        return;
      }
      return w.toast(p.id, "Немає їжі. Купи на ринку або поїж у таверні.", "bad");
    }
    case "rest": {
      // proper sleep only at home (a rented bed / house) or next to one's own bed; elsewhere you doze where you can
      const ownBed = findObjNear(w.map, p.x, p.y, O.BED, 1.6, (x, y) => w.res.placed[idx(x, y)]?.by === p.id);
      if (w.isJailed(p) || atLodging(w, p) || ownBed) { startBusy(w, p, "rest", "Відпочиває", 1e9, undefined, undefined, { rate: 1 }); return; }
      if (areaContains(w.map.areas.tavern, p.x, p.y) && !atLodging(w, p))
        w.toast(p.id, `Ліжка в таверні — для тих, хто заплатив (${bedPrice(w, "tavern")} срібла за ніч, вікно «Персонаж» → «Житло»). Поки дрімаєш на лаві.`, "info");
      else w.toast(p.id, buildingAt(w.map, p.x, p.y)
        ? "Ти тут не мешкаєш — дрімаєш абияк, сон неглибокий. Орендуй житло: «Персонаж» (I) → «Житло»."
        : "Ночуєш просто неба — сон тривожний і неглибокий. Орендуй житло: «Персонаж» (I) → «Житло».", "info");
      startBusy(w, p, "rest", p.lodging ? "Дрімає (не вдома)" : "Дрімає де доведеться", 1e9, undefined, undefined, { rate: 0.4 });
      return;
    }
    case "pray": {
      const inTemple = areaContains(w.map.areas.temple, p.x, p.y), inGrove = areaContains(w.map.areas.grove, p.x, p.y);
      if (!inTemple && !inGrove) return w.toast(p.id, "Молитися можна в храмі або в гаю Клумногів.", "bad");
      startBusy(w, p, "pray", "Молиться", 3000);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Market / business
// ---------------------------------------------------------------------------

export function inMarket(w: World, p: Player): boolean {
  const m = w.map.areas.market;
  return areaContains({ ...m, x: m.x - 2, y: m.y - 2, w: m.w + 4, h: m.h + 4 }, p.x, p.y);
}

export function playerMarket(w: World, p: Player, op: "buy" | "sell", item: ItemId, qty: number) {
  if (!ITEMS[item]) return;
  qty = Math.max(1, Math.min(50, Math.floor(qty)));
  if (!inMarket(w, p)) return w.toast(p.id, "Торгувати можна лише на ринковій площі.", "bad");
  if (w.isJailed(p)) return;
  const r = op === "buy" ? marketBuy(w, p, item, qty) : marketSell(w, p, item, qty);
  if (!r.ok) return w.toast(p.id, r.reason, "bad");
  w.toast(p.id, op === "buy" ? `Куплено ${qty} × ${ITEMS[item].name} за ${r.total} срібла` : `Продано ${qty} × ${ITEMS[item].name} за ${r.total} срібла`, "good");
  w.selfChanged(p.id);
}

export function playerBiz(w: World, p: Player, op: string, bizId?: string, amount?: number, workerId?: string, item?: ItemId, to?: "market" | "caravan") {
  const b = bizId ? w.businesses.get(bizId) : undefined;
  if (!b) return;
  const owner = b.ownerId === p.id;
  switch (op) {
    case "buy": {
      if (!areaContains(w.map.areas.residence, p.x, p.y)) return w.toast(p.id, "Купівля справ оформлюється в резиденції старости.", "bad");
      const r = buyBusiness(w, p, b);
      if (!r.ok) return w.toast(p.id, r.reason, "bad");
      w.say(w.politics.reeve, `Вітаю, ${p.name}. Тепер «${b.name}» належить тобі. Не забувай платити людям.`);
      w.toast(p.id, `Ти власник «${b.name}»! Наймай людей через розмову з ними.`, "good");
      return;
    }
    case "craftFee":
    case "bedRent": {
      const may = owner || (b.ownerId === "town" && w.politics.reeve === p.id);
      if (!may) return w.toast(p.id, "Ціни тут встановлює власник (для справ громади — староста).", "bad");
      const v = Math.max(0, Math.min(30, Math.floor(amount ?? 0)));
      if (op === "craftFee") { b.craftFee = v; w.toast(p.id, `«${b.name}»: плата за користування майстернею — ${v} срібла за виріб.`, "info"); }
      else if (b.id === "tavern") { b.bedRent = Math.max(1, v); w.toast(p.id, `«${b.name}»: ліжко — ${b.bedRent} срібла за ніч.`, "info"); }
      return;
    }
    case "setWage":
      if (!owner) return;
      b.wage = Math.max(1, Math.min(50, Math.floor(amount ?? b.wage)));
      w.toast(p.id, `Платня в «${b.name}»: ${b.wage} срібла/день`, "info");
      return;
    case "deposit": {
      if (!owner) return;
      const v = Math.max(0, Math.min(p.coins, Math.floor(amount ?? 0)));
      p.coins -= v; b.treasury += v;
      w.selfChanged(p.id);
      return;
    }
    case "withdraw": {
      if (!owner) return;
      const v = Math.max(0, Math.min(b.treasury, Math.floor(amount ?? 0)));
      b.treasury -= v; p.coins += v;
      w.selfChanged(p.id);
      return;
    }
    case "sellStock": {
      if (!owner || !item || !ITEMS[item]) return;
      const r = sellFromStock(w, b, item, Math.max(1, Math.floor(amount ?? 0)), to === "caravan" ? "caravan" : "market");
      if (!r.ok) return w.toast(p.id, r.reason, "bad");
      w.toast(p.id, `«${b.name}»: продано ${to === "caravan" ? "оптовикам" : "на ринок"} за ${r.total} срібла (гроші — у касі справи).`, "good");
      return;
    }
    case "takeStock": {
      if (!owner || !item || !ITEMS[item]) return;
      const area = w.map.areas[b.area];
      if (!area || !areaContains({ ...area, x: area.x - 2, y: area.y - 2, w: area.w + 4, h: area.h + 4 }, p.x, p.y))
        return w.toast(p.id, `Щоб забрати товар, прийди до «${b.name}».`, "bad");
      const n = Math.min(Math.floor(amount ?? 0), Math.floor(b.stock[item] ?? 0));
      if (n <= 0) return;
      b.stock[item] = (b.stock[item] ?? 0) - n;
      invAdd(p.inv, item, n);
      w.toast(p.id, `Забрав зі складу: ${ITEMS[item].name} ×${n}.`, "good");
      w.selfChanged(p.id);
      return;
    }
    case "process":
      if (!owner || b.kind !== "lumber") return;
      b.process = (amount ?? 0) > 0 ? "plank" : undefined;
      w.toast(p.id, b.process ? `«${b.name}»: робітники різатимуть деревину на дошки (по 3 колоди за годину роботи) — продаватимуться дошки.` : `«${b.name}»: продаємо кругляк.`, "info");
      return;
    case "autoPay":
      if (!owner) return;
      b.autoPay = (amount ?? 1) > 0;
      w.toast(p.id, b.autoPay ? `«${b.name}»: якщо в касі забракне на платню, доплачу зі свого гаманця.` : `«${b.name}»: платня лише з каси.`, "info");
      return;
    case "fire": {
      if (!owner || !workerId || !b.workers.includes(workerId)) return;
      const wk = w.being(workerId);
      if (!wk) return;
      leaveJob(w, wk, "fired");
      const a = w.agents.get(workerId);
      if (a) { adjustRel(a, p.id, { trust: -25, affection: -15 }); w.say(a.id, "Отак, значить? Я це запам'ятаю."); }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Crime
// ---------------------------------------------------------------------------

export function playerPickpocket(w: World, p: Player, npcId: string) {
  const v = w.agents.get(npcId);
  if (!v || v.kind === "klumnog") return w.toast(p.id, "Ефірну істоту неможливо обікрасти.", "bad");
  if (v.bornAt !== undefined && v.profession === "child") return w.toast(p.id, "Обкрадати дітей? Навіть у Каргаті є межі.", "bad");
  if (w.isJailed(p)) return;
  if (Math.hypot(v.x - p.x, v.y - p.y) > INTERACT_RANGE * 0.7) return w.toast(p.id, "Підійди ближче.", "bad");
  const now = Date.now();
  if (now - (p.lastTalkReward["pickpocket"] ?? 0) < 8000) return w.toast(p.id, "Руки ще тремтять. Зачекай трохи.", "bad");
  p.lastTalkReward["pickpocket"] = now;
  const success = Math.random() < (v.anim === "sleep" ? 0.9 : 0.6);
  const amount = success ? Math.min(v.coins, 4 + Math.floor(Math.random() * 14)) : 0;
  const place = w.areaName(p.x, p.y);
  if (amount > 0) { v.coins -= amount; p.coins += amount; }
  const f = newFact(w, "theft", { actor: p.id, target: v.id, amount, place });
  w.log(`${p.name} ${success ? `краде ${amount} срібла в` : "намагається обікрасти"} ${v.name} (${place}).`, "crime");
  const victimNoticed = !success || (v.anim !== "sleep" && Math.random() < 0.3);
  if (victimNoticed) { learnFact(w, v, f, "self", 0.95); w.say(v.id, success ? `Ей! ${p.name} поцупив мій гаманець! Варта!` : `Руки геть, ${p.name}! Злодій!`); }
  const wit = witness(w, f, p.x, p.y, { exclude: [p.id, v.id] });
  w.toast(p.id, success ? `Ти поцупив ${amount} срібла.${victimNoticed ? " Але тебе помітили!" : ""}` : "Невдача! Тебе помітили.", success && !victimNoticed ? "good" : "bad");
  if (wit.length) w.log(`Свідки: ${wit.map((x) => x.name).join(", ")}.`, "crime");
  w.selfChanged(p.id);
}

/** "While you were away": books of the player's businesses + notifications kept offline. */
export function awaySummary(world: World, p: Player): { t: number; text: string; kind: string }[] {
  const out: { t: number; text: string; kind: string }[] = [];
  const since = p.offlineSince;
  if (since !== undefined) {
    const fromDay = dayOf(since);
    for (const id of p.ownedBusinesses) {
      const b = world.businesses.get(id);
      if (!b) continue;
      const days = (b.ledger ?? []).filter((d) => d.day >= fromDay);
      if (!days.length) continue;
      const sum = days.reduce((a, d) => ({ made: a.made + d.made, sold: a.sold + d.sold, revenue: a.revenue + d.revenue, wages: a.wages + d.wages, unpaid: a.unpaid + d.unpaid }),
        { made: 0, sold: 0, revenue: 0, wages: 0, unpaid: 0 });
      const prod = b.product ? ITEMS[b.product].name.toLowerCase() : "товару";
      out.push({
        t: world.time, kind: sum.unpaid ? "bad" : "good",
        text: `«${b.name}» за ${days.length} дн.: вироблено ${Math.floor(sum.made)}, продано ${sum.sold} (${prod}) за ${sum.revenue} срібла, платня ${sum.wages}` +
          `${sum.unpaid ? `, невиплат: ${sum.unpaid}` : ""}. Каса: ${Math.floor(b.treasury)}, на складі: ${Math.floor(b.product ? b.stock[b.product] ?? 0 : 0)}.`,
      });
    }
  }
  out.push(...(p.inbox ?? []));
  p.inbox = [];
  p.offlineSince = undefined;
  return out;
}

// ---------------------------------------------------------------------------
// Politics (panel G)
// ---------------------------------------------------------------------------

export function playerPolitics(w: World, p: Player, m: Extract<C2S, { t: "politics" }>): { ok: boolean; reason: string } | null {
  const P = w.politics;
  if (m.op === "info") return null;
  if (w.isJailed(p) && m.op !== "embezzle") return { ok: false, reason: "З в'язниці не до політики." };
  if (!atResidence(w, p)) return { ok: false, reason: "Це оформлюється в резиденції старости." };
  const reeve = P.reeve === p.id;
  switch (m.op) {
    case "candidate": return registerCandidate(w, p);
    case "vote": return castVote(w, p, String(m.target ?? ""));
    case "sign": return signPetition(w, p);
    case "donate": return donate(w, p, Number(m.amount ?? 0));
  }
  if (!reeve) return { ok: false, reason: "Це може лише староста." };
  switch (m.op) {
    case "setTax": setTax(w, Number(m.amount ?? 0)); return { ok: true, reason: `Податок: ${Math.round(P.taxRate * 100)}% виручки справ.` };
    case "setWage": {
      const b = w.businesses.get(m.bizId ?? "");
      if (!b || b.ownerId !== "town") return { ok: false, reason: "Це не справа громади." };
      b.wage = Math.max(1, Math.min(50, Math.floor(Number(m.amount ?? b.wage))));
      return { ok: true, reason: `«${b.name}»: платня ${b.wage}/день (з міської скарбниці).` };
    }
    case "forSale": {
      const b = w.businesses.get(m.bizId ?? "");
      if (!b || !isPrivatisable(b)) return { ok: false, reason: "Це майно громади не продається." };
      const price = Math.floor(Number(m.amount ?? 0));
      b.forSale = price > 0 ? price : null;
      return { ok: true, reason: b.forSale ? `«${b.name}» виставлено на продаж за ${b.forSale}. Купити можна тут, у резиденції (гроші — у скарбницю).` : `«${b.name}» знято з продажу.` };
    }
    case "pardon": return pardon(w, String(m.target ?? ""));
    case "embezzle": return embezzle(w, p, Number(m.amount ?? 0));
  }
  return null;
}

export function resetPlayerOnJoin(w: World, p: Player) {
  // Offline policy (prototype): the character leaves the world while offline and
  // re-appears at the same spot; jail time keeps running on the server clock.
  if (p.jailedUntil !== null && p.jailedUntil <= w.time) {
    p.jailedUntil = null;
    const s = randomSpotIn(w.map, w.map.areas.residence);
    p.x = s.x; p.y = s.y;
  }
  p.busy = null;
}

/**
 * Every new connection starts a fresh input stream (the client counts `seq` from 0 again):
 * forget the old counter, or the server would drop all movement until the new seq caught up.
 * Also step out of anything that appeared on our tile while we were away (a placed bed, a new house...).
 */
export function resetConnection(w: World, p: Player) {
  p.lastInputSeq = 0;
  p.inputBudget = 0;
  p.moveDir = { x: 0, y: 0 };
  if (isWalkable(w.map, Math.floor(p.x), Math.floor(p.y))) return;
  const tx = Math.floor(p.x), ty = Math.floor(p.y);
  for (let r = 1; r <= 12; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !isWalkable(w.map, tx + dx, ty + dy)) continue;
        p.x = tx + dx + 0.5; p.y = ty + dy + 0.5;
        return;
      }
  const s = randomSpotIn(w.map, w.map.areas.gate);
  p.x = s.x; p.y = s.y;
}
