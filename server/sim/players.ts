// Player actions. Every action is validated by the engine (distance, money, location...).
// Players use the same systems as NPCs: market, needs, theft/witnesses, employment.

import type { World } from "./world.ts";
import type { Player } from "./types.ts";
import { INPUT_DT, PLAYER_SPEED, INTERACT_RANGE, START_COINS } from "../../shared/constants.ts";
import { stepMove, facingFromDir } from "../../shared/move.ts";
import { G, O, areaContains, canPlant, findObjNear, groundAt, buildingAt, getMap, randomSpotIn } from "../../shared/map.ts";
import { ITEMS, invAdd, type ItemId } from "../../shared/items.ts";
import { buyBusiness, buyMeal, leaveJob, marketBuy, marketSell, mealPrice } from "./economy.ts";
import { adjustRel, learnFact, newFact, witness } from "./social.ts";
import { releaseIfDue } from "./brain.ts";
import type { Look } from "../../shared/protocol.ts";
import type { SkillId } from "../../shared/skills.ts";
import { trainSkill } from "./skillsys.ts";
import { harvestTile, plantSapling, remaining } from "./resources.ts";

const lastMoveAt = new Map<string, number>();

export function createPlayer(w: World, id: string, name: string, token: string, look: Look, gender: "m" | "f"): Player {
  const spot = randomSpotIn(getMap(), w.map.areas.gate);
  const p: Player = {
    id, name, kind: "player", gender, x: spot.x, y: spot.y, facing: 4, anim: "idle", look,
    coins: START_COINS, inv: {}, hunger: 80, energy: 90, faction: "varon", socialClass: "UNBOUND",
    jailedUntil: null, jobBiz: null, skills: {}, token, online: true, lastInputSeq: 0, moveDir: { x: 0, y: 0 },
    inputBudget: 0, busy: null, ownedBusinesses: [], blessing: false, lastTalkReward: {},
  };
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
        p.energy = Math.min(100, p.energy + 2.2 * dt);
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

function startBusy(w: World, p: Player, kind: NonNullable<Player["busy"]>["kind"], label: string, durMs: number, item?: ItemId, tile?: { x: number; y: number }) {
  p.busy = { kind, label, start: Date.now(), dur: durMs, item, tile };
  w.selfChanged(p.id);
}

function completeBusy(w: World, p: Player) {
  const b = p.busy!;
  p.busy = null;
  switch (b.kind) {
    case "gather": {
      const item = b.item!;
      // The resource itself is finite: take one unit from the actual tree / rock / bush.
      if (b.tile && !harvestTile(w, b.tile.x, b.tile.y)) { w.toast(p.id, "Тут уже нічого не лишилося.", "bad"); break; }
      invAdd(p.inv, item, 1);
      p.energy = Math.max(0, p.energy - 1.5);
      trainSkill(w, p, GATHER_SKILL[item], 0.35);
      let msg = `+1 ${ITEMS[item].name}`;
      if (item === "wood" && Math.random() < 0.25) { invAdd(p.inv, "sapling", 1); msg += ", +1 Саджанець"; }
      if (b.tile && remaining(w, b.tile.x, b.tile.y) <= 0) msg += item === "wood" ? " — дерево зрубано" : item === "herbs" ? " — кущ обібрано" : " — скелю вибрано";
      w.toast(p.id, msg, "good");
      // keep gathering automatically while a resource remains in reach
      const next = resourceNear(w, p);
      if (p.energy > 3 && next && next.item === item) startBusy(w, p, "gather", b.label, gatherTime(p, item), item, next.tile);
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
  return Math.round(base / (0.8 + level / 250));
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

export function playerAct(w: World, p: Player, a: "gather" | "eat" | "rest" | "pray" | "cancel" | "plant") {
  if (w.isJailed(p) && a !== "rest") return w.toast(p.id, "За ґратами не дуже розгуляєшся.", "bad");
  switch (a) {
    case "cancel": p.busy = null; w.selfChanged(p.id); return;
    case "plant": {
      if ((p.inv.sapling ?? 0) < 1) return w.toast(p.id, "Немає саджанців. Їх дає рубка дерев, або купи на ринку.", "bad");
      // prefer a stump nearby, else any free spot next to the player
      let spot: { x: number; y: number } | null = findObjNear(w.map, p.x, p.y, O.STUMP, 1.6);
      if (!spot) {
        const tx = Math.floor(p.x), ty = Math.floor(p.y);
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]])
          if (canPlant(w.map, tx + dx, ty + dy)) { spot = { x: tx + dx, y: ty + dy }; break; }
      }
      if (!spot || !plantSapling(w, spot.x, spot.y)) return w.toast(p.id, "Тут не можна садити (лише поза містом, на траві, землі чи пні).", "bad");
      invAdd(p.inv, "sapling", -1);
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
      if (!buildingAt(w.map, p.x, p.y) && !w.isJailed(p)) return w.toast(p.id, "Відпочивати безпечно лише в будівлі (таверна, храм, будинок).", "bad");
      startBusy(w, p, "rest", "Відпочиває", 1e9);
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

export function playerBiz(w: World, p: Player, op: string, bizId?: string, amount?: number, workerId?: string) {
  const b = bizId ? w.businesses.get(bizId) : undefined;
  if (!b) return;
  const owner = b.ownerId === p.id;
  switch (op) {
    case "buy": {
      if (!areaContains(w.map.areas.residence, p.x, p.y)) return w.toast(p.id, "Купівля справ оформлюється в резиденції старости.", "bad");
      const r = buyBusiness(w, p, b);
      if (!r.ok) return w.toast(p.id, r.reason, "bad");
      w.say("aldric", `Вітаю, ${p.name}. Тепер «${b.name}» належить тобі. Не забувай платити людям.`);
      w.toast(p.id, `Ти власник «${b.name}»! Наймай людей через розмову з ними.`, "good");
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
