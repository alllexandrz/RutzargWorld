// Rutzarg authoritative game server.
// - serves the Phaser client (client/dist) over HTTP
// - runs the persistent world simulation at SERVER_TICK_HZ
// - talks to clients over WebSocket (/ws)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import { World } from "./sim/world.ts";
import { restore, snapshot } from "./persist.ts";
import { createStorage } from "./storage.ts";
import { computeStats } from "./stats.ts";
import { accountFromSession, authConfig, handleAuth } from "./auth.ts";
import type { C2S, S2C, EntSnap, SelfState, BusinessInfo, InspectInfo, LodgingInfo, Look, PoliticsInfo } from "../shared/protocol.ts";
import { GAME_MINUTES_PER_SECOND, SERVER_TICK_HZ, SNAPSHOT_HZ } from "../shared/constants.ts";
import { ITEM_IDS, ITEMS, marketBuyPrice, marketPrice, type ItemId } from "../shared/items.ts";
import { applyInput, awaySummary, createPlayer, playerPolitics, playerAct, playerBiz, playerCraft, playerMarket, playerPickpocket, playerPickup, playerPlace, resetConnection, resetPlayerOnJoin } from "./sim/players.ts";
import { playerTalk } from "./sim/dialogue.ts";
import { businessValue, marketRoom, ownerName, wholesaleLeft, wholesalePrice } from "./sim/economy.ts";
import { atResidence, guards, isPrivatisable, petitionNeeded, tally, TAX_STEPS } from "./sim/politics.ts";
import { CLASS_NAMES, FACTION_NAMES, type Player } from "./sim/types.ts";
import { llmDescription, llmProbe, llmStatus } from "./ai/llm.ts";
import { familySummary, isChild } from "./sim/family.ts";
import { bedsUsed, commissionPlot, plotStates } from "./sim/construction.ts";
import { MAP_W, areaContains, findObjNear } from "../shared/map.ts";
import { discard, equipItem, repairItem, repairQuote, statsOf, unequip } from "./sim/gear.ts";
import { charInfo } from "./sim/charsheet.ts";
import { atLodging, bedPrice, livesFree, defaultCraftFee, hasWorkshop, landlordName, leaveLodging, lodgingOffers, rentLodging, workshopAt } from "./sim/housing.ts";
import { STATION_OBJ, STATION_RANGE } from "../shared/crafting.ts";
import { SLOTS, SLOT_NAMES, condLabel } from "../shared/gear.ts";
import type { Being } from "./sim/types.ts";

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "client", "dist");
const SAVE_FILE = process.env.SAVE_FILE ?? join(ROOT, "data", "world.json");

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

const world = new World();
const storage = createStorage(SAVE_FILE);
await storage.init();
{
  const saved = process.env.FRESH_WORLD === "1" ? null : await storage.loadSnapshot();
  if (saved && restore(world, saved)) console.log(`[world] loaded snapshot from ${storage.kind}`);
  else console.log("[world] new world created");
}

interface Session { ws: WebSocket; playerId: string | null; selfDirty: boolean; lastSelf: string }
const sessions = new Set<Session>();

function send(s: Session, m: S2C) {
  if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(m));
}
function broadcast(m: S2C) {
  const txt = JSON.stringify(m);
  for (const s of sessions) if (s.ws.readyState === s.ws.OPEN && s.playerId) s.ws.send(txt);
}
function sessionOf(playerId: string): Session | undefined {
  for (const s of sessions) if (s.playerId === playerId) return s;
  return undefined;
}

world.listener = {
  say: (id, text) => broadcast({ t: "say", id, text }),
  toast: (pid, text, kind) => { const s = sessionOf(pid); if (s) send(s, { t: "toast", text, kind }); },
  teleport: (pid, x, y) => { const s = sessionOf(pid); if (s) send(s, { t: "teleport", x, y }); },
  selfChanged: (pid) => { const s = sessionOf(pid); if (s) s.selfDirty = true; },
  dialog: () => {},
  plotsChanged: () => broadcast({ t: "plots", plots: plotStates(world) }),
};

// ---------------------------------------------------------------------------
// Views (world → protocol)
// ---------------------------------------------------------------------------

function entSnaps(): EntSnap[] {
  const out: EntSnap[] = [];
  for (const a of world.agents.values()) {
    out.push({
      id: a.id, k: a.kind, n: a.name, x: round2(a.x), y: round2(a.y), f: a.facing, a: a.anim, l: a.look,
      s: world.isJailed(a) ? "у в'язниці" : a.pregnancy ? `${a.title} · вагітна` : a.title,
      ...(isChild(world, a) ? { c: 1 as const } : {}),
      g: visibleGear(a),
    });
  }
  for (const p of world.players.values()) {
    if (!p.online) continue;
    out.push({
      id: p.id, k: "player", n: p.name, x: round2(p.x), y: round2(p.y), f: p.facing, a: p.anim, l: p.look,
      s: world.isJailed(p) ? "у в'язниці" : world.politics.reeve === p.id ? (p.gender === "f" ? "старостиня" : "староста") : p.blessing ? "✦ благословенний" : p.ownedBusinesses.length ? "власник" : "мандрівник",
      g: visibleGear(p),
    });
  }
  return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Gear others can see on the sprite. */
function visibleGear(b: Being): EntSnap["g"] {
  const e = b.equip;
  if (!e) return undefined;
  const g: NonNullable<EntSnap["g"]> = {};
  if (e.head) g.h = e.head.item;
  if (e.body) g.b = e.body.item;
  if (e.weapon) g.w = e.weapon.item;
  if (e.offhand) g.o = e.offhand.item;
  return Object.keys(g).length ? g : undefined;
}
const roundSkills = (sk: Record<string, number | undefined> | undefined) =>
  Object.fromEntries(Object.entries(sk ?? {}).map(([k, v]) => [k, Math.floor(v ?? 0)]));

function selfState(p: Player): SelfState {
  return {
    id: p.id, name: p.name, coins: p.coins, inv: p.inv, hunger: Math.round(p.hunger), energy: Math.round(p.energy),
    jailedUntil: world.isJailed(p) ? p.jailedUntil : null,
    ownedBusinesses: p.ownedBusinesses, job: p.jobBiz,
    busy: p.busy ? { label: p.busy.label, progress: p.busy.kind === "rest" ? p.energy / 100 : Math.min(1, (Date.now() - p.busy.start) / p.busy.dur) } : null,
    blessing: p.blessing,
    family: familySummary(world, p),
    skills: roundSkills(p.skills),
    equip: Object.fromEntries(Object.entries(p.equip ?? {}).map(([k, v]) => [k, { item: v.item, dur: Math.round(v.dur) }])),
    stats: (({ attack, armor, presence, power }) => ({ attack, armor, presence, power }))(statsOf(p)),
    home: p.lodging ? {
      area: p.lodging.area, name: world.map.areas[p.lodging.area]?.name ?? p.lodging.area, kind: p.lodging.kind, debt: p.lodging.debt,
      price: p.lodging.kind === "house" ? world.homes[p.lodging.area]?.houseRent ?? 0 : bedPrice(world, p.lodging.area),
    } : null,
    workshops: nearWorkshops(p),
    debts: (p.loans ?? []).map((l) => ({ lender: world.nameOf(l.lender), lenderId: l.lender, owe: l.owe, due: l.due, overdueDays: l.overdueDays })),
    repairs: SLOTS.map((slot) => ({ slot, q: repairQuote(world, p, slot) })).filter((x) => x.q).map(({ slot, q }) => ({ slot, cost: q!.cost, where: q!.where, self: q!.self })),
  };
}

function nearWorkshops(p: Player): SelfState["workshops"] {
  const out: SelfState["workshops"] = [];
  for (const [st, obj] of Object.entries(STATION_OBJ)) {
    const t = findObjNear(world.map, p.x, p.y, obj, STATION_RANGE);
    const ws = t ? workshopAt(world, p, t.x, t.y) : null;
    if (ws) out.push({ station: st, label: ws.label, owner: ws.owner, fee: ws.fee, free: ws.free });
  }
  return out;
}

function lodgingInfo(p: Player): LodgingInfo {
  const l = p.lodging;
  return {
    current: l ? {
      area: l.area, name: world.map.areas[l.area]?.name ?? l.area, kind: l.kind, debt: l.debt, since: l.since,
      price: l.kind === "house" ? world.homes[l.area]?.houseRent ?? 0 : bedPrice(world, l.area),
      landlord: landlordName(world, l.area), here: atLodging(world, p),
    } : null,
    offers: lodgingOffers(world, p, (a) => bedsUsed(world, a)),
  };
}

function gearLines(b: Being): string[] {
  return SLOTS.filter((s) => b.equip?.[s]).map((s) => {
    const w = b.equip![s]!;
    return `${SLOT_NAMES[s]}: ${ITEMS[w.item].name} (${condLabel(w.dur)}, ${Math.round(w.dur)}%)`;
  });
}

function marketInfo() {
  return {
    items: ITEM_IDS.map((id) => ({
      id, name: ITEMS[id].name, stock: world.marketStock(id),
      buy: marketPrice(id, world.marketStock(id)), sell: marketBuyPrice(id, world.marketStock(id)),
    })),
  };
}

function bizList(viewer?: string): BusinessInfo[] {
  return [...world.businesses.values()].map((b) => ({
    ...(viewer && b.ownerId === viewer ? {
      ledger: b.ledger ?? [], autoPay: b.autoPay !== false,
      process: b.kind === "lumber" ? b.process ?? "" : null,
      outlets: (Object.entries(b.stock) as [ItemId, number][]).filter(([, n]) => n >= 1).map(([item, n]) => ({
        item, name: ITEMS[item].name, qty: Math.floor(n), marketPrice: marketBuyPrice(item, world.marketStock(item)), marketRoom: marketRoom(world, item),
        wholesalePrice: wholesalePrice(item), wholesaleLeft: wholesaleLeft(world, item),
      })),
    } : {}),
    id: b.id, name: b.name, kind: b.kind, ownerId: b.ownerId, ownerName: ownerName(world, b),
    forSale: b.forSale, wage: b.wage, maxWorkers: b.maxWorkers,
    workers: b.workers.map((id) => ({ id, name: world.nameOf(id), unpaidDays: b.unpaidDays[id] ?? 0 })),
    treasury: Math.floor(b.treasury), stock: Object.fromEntries(Object.entries(b.stock).map(([k, v]) => [k, Math.floor(v ?? 0)])),
    product: b.product, workHours: b.workHours, areaId: b.area, allowedClasses: b.allowedClasses.map((c) => CLASS_NAMES[c]),
    craftFee: hasWorkshop(world, b) ? b.craftFee ?? defaultCraftFee(world, b) : null,
    ...(b.id === "tavern" ? { bedRent: bedPrice(world, "tavern") } : {}),
    canSetFees: !!viewer && (b.ownerId === viewer || (b.ownerId === "town" && world.politics.reeve === viewer)),
  }));
}

function politicsInfo(p: Player): PoliticsInfo {
  const P = world.politics;
  const mine = P.reeve === p.id;
  const votes = tally(world);
  return {
    reeve: { id: P.reeve, name: world.nameOf(P.reeve) }, how: P.how, since: P.since,
    legitimacy: Math.round(P.legitimacy), approval: Math.round(P.approval * 100), taxRate: P.taxRate, taxSteps: TAX_STEPS,
    treasury: Math.round(world.townTreasury), nextElection: P.nextElection, youAreReeve: mine, atResidence: atResidence(world, p),
    election: P.election ? {
      reason: P.election.reason, endsAt: P.election.endsAt,
      candidates: P.election.candidates.map((id) => ({ id, name: world.nameOf(id), votes: votes[id] ?? 0 })),
      yourVote: P.election.playerVotes[p.id] ?? null, youRun: P.election.candidates.includes(p.id),
    } : null,
    petition: { count: P.petition.length, needed: petitionNeeded(world), signed: P.petition.includes(p.id) },
    plot: { sworn: (P.conspiracy[p.id] ?? []).filter((id) => guards(world).some((g) => g.id === id)).length, guards: guards(world).length },
    history: P.history.slice(-15).reverse(),
    ...(mine ? {
      prisoners: [...world.agents.values(), ...world.players.values()].filter((b) => world.isJailed(b)).map((b) => ({ id: b.id, name: b.name, until: b.jailedUntil ?? 0 })),
      townBiz: [...world.businesses.values()].filter((b) => b.ownerId === "town").map((b) => ({
        id: b.id, name: b.name, wage: b.wage, forSale: b.forSale, workers: b.workers.length, maxWorkers: b.maxWorkers,
        privatisable: isPrivatisable(b), value: businessValue(world, b),
      })),
    } : {}),
  };
}

function inspect(id: string): InspectInfo | null {
  const a = world.agents.get(id);
  if (a) {
    const job = a.jobBiz ? world.businesses.get(a.jobBiz) : undefined;
    return {
      id: a.id, name: a.name, kind: a.kind, faction: FACTION_NAMES[a.faction], socialClass: CLASS_NAMES[a.socialClass],
      profession: a.title, job: job ? `${job.name} (${job.wage}/день)` : "—", coins: a.coins,
      needs: { "Ситість": Math.round(a.hunger), "Енергія": Math.round(a.energy), "Спілкування": Math.round(a.social) },
      personality: a.personality as unknown as Record<string, number>,
      activity: a.activity.label, goals: a.goals.map((g) => g.text),
      memories: [...a.memories].reverse().slice(0, 14).map((m) => ({ t: m.t, text: m.text, conf: Math.round(m.confidence * 100) / 100, src: m.source === "self" ? "бачив сам" : world.nameOf(m.source) })),
      relations: Object.entries(a.relations)
        .map(([oid, r]) => ({ id: oid, name: world.nameOf(oid), trust: Math.round(r.trust), affection: Math.round(r.affection), fear: Math.round(r.fear) }))
        .sort((x, y) => Math.abs(y.trust) + Math.abs(y.affection) - Math.abs(x.trust) - Math.abs(x.affection)).slice(0, 10),
      location: world.areaName(a.x, a.y),
      family: familySummary(world, a),
      skills: roundSkills(a.skills),
      home: `${world.map.areas[a.home]?.name ?? a.home}${livesFree(world, a, a.home) ? "" : ` — ліжко за ${bedPrice(world, a.home)}/ніч (${landlordName(world, a.home)})`}${a.flags.rentDebt ? `, борг ${a.flags.rentDebt}` : ""}`,
      gear: gearLines(a),
    };
  }
  const p = world.players.get(id);
  if (p) {
    return {
      id: p.id, name: p.name, kind: "player", faction: FACTION_NAMES[p.faction], socialClass: CLASS_NAMES[p.socialClass],
      profession: "Гравець", job: p.ownedBusinesses.map((b) => world.businesses.get(b)?.name).join(", ") || "—", coins: p.coins,
      needs: { "Ситість": Math.round(p.hunger), "Енергія": Math.round(p.energy) }, personality: {}, activity: p.busy?.label ?? "—",
      goals: [], memories: [], relations: [], location: world.areaName(p.x, p.y), family: familySummary(world, p), skills: roundSkills(p.skills), home: "—",
      gear: gearLines(p),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function sanitizeName(n: string): string {
  return n.replace(/[^\p{L}\p{N} _'-]/gu, "").trim().slice(0, 18) || "Мандрівник";
}

function sanitizeLook(l: Partial<Look> | undefined): Look {
  const ok = (c: unknown, d: string) => (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : d);
  return { body: ok(l?.body, "#5a6a8a"), hair: ok(l?.hair, "#2a1a10"), skin: ok(l?.skin, "#d8a880") };
}

/** Enter the world: with an account session (preferred) or as a guest (if allowed). */
async function joinWorld(s: Session, m: Extract<C2S, { t: "join" }>) {
  let p: Player | undefined;
  let awayReport: { t: number; text: string; kind: string }[] = [];
  const look = sanitizeLook(m.look);
  const gender = m.look?.gender === "f" ? "f" : "m";
  if (m.session) {
    const acc = await accountFromSession(storage, m.session);
    if (!acc) { send(s, { t: "authError", text: "Сесія завершилась. Увійди знову." }); return; }
    p = acc.playerId ? world.players.get(acc.playerId) : undefined;
    if (!p) {
      p = createPlayer(world, `p_${randomBytes(4).toString("hex")}`, sanitizeName(m.name || acc.displayName), randomBytes(16).toString("hex"), look, gender);
      acc.playerId = p.id;
      await storage.saveAccount(acc);
    }
    p.accountId = acc.id;
  } else {
    if (!authConfig.allowGuests) { send(s, { t: "authError", text: "Щоб грати, увійди в акаунт." }); return; }
    p = m.token ? [...world.players.values()].find((x) => x.token === m.token && !x.accountId) : undefined;
    if (!p) p = createPlayer(world, `p_${randomBytes(4).toString("hex")}`, sanitizeName(m.name), randomBytes(16).toString("hex"), look, gender);
  }
  const old = sessionOf(p.id);
  if (old && old !== s) { send(old, { t: "error", text: "Ти увійшов з іншого вікна чи пристрою." }); old.playerId = null; old.ws.close(); }
  if (!p.online) {
    // returning character (a freshly created one is already online and announced)
    p.online = true;
    resetPlayerOnJoin(world, p);
    awayReport = awaySummary(world, p);
    world.log(`${p.name} повертається до Каргата.`, "player");
  }
  resetConnection(world, p);
  s.playerId = p.id;
  s.selfDirty = true;
  storage.upsertPlayers([{ id: p.id, name: p.name, online: true }]).catch((e) => console.warn("[db] players:", e.message));
  send(s, { t: "welcome", you: p.id, token: p.accountId ? "" : p.token, time: world.time, minutesPerSecond: GAME_MINUTES_PER_SECOND });
  send(s, { t: "chronicle", entries: world.chronicle.slice(-80) });
  send(s, { t: "plots", plots: plotStates(world) });
  if (awayReport.length) send(s, { t: "inbox", items: awayReport });
  if (!p.lodging) send(s, { t: "toast", text: "Тобі ніде ночувати. Ліжко в таверні чи будинок можна винайняти: «Персонаж» (I) → «Житло».", kind: "info" });
  // all tiles that differ from the generated map (felled trees, planted saplings, mined rocks)
  send(s, { t: "tiles", changes: Object.entries(world.res.overrides).map(([k, [g, o]]) => [Number(k) % MAP_W, Math.floor(Number(k) / MAP_W), g, o] as [number, number, number, number]) });
}

function handle(s: Session, m: C2S) {
  if (m.t === "join") {
    joinWorld(s, m).catch((e) => { console.error("[join]", e); send(s, { t: "error", text: "Помилка входу" }); });
    return;
  }
  if (m.t === "ping") return send(s, { t: "pong", ts: m.ts });
  const p = s.playerId ? world.players.get(s.playerId) : undefined;
  if (!p) return;
  switch (m.t) {
    case "input": applyInput(world, p, m.seq, m.dx, m.dy); break;
    case "chat": {
      const text = String(m.text ?? "").slice(0, 240).trim();
      if (!text) return;
      broadcast({ t: "chat", from: p.id, name: p.name, text, local: false });
      broadcast({ t: "say", id: p.id, text });
      break;
    }
    case "act": playerAct(world, p, m.a); break;
    case "talk": playerTalk(world, p, m.npcId, m.opt, { arg: m.arg, wage: m.wage, bizId: m.bizId, price: m.price }, (d) => send(s, d)); break;
    case "openMarket": send(s, { t: "market", m: marketInfo() }); break;
    case "market": playerMarket(world, p, m.op, m.item, m.qty); send(s, { t: "market", m: marketInfo() }); break;
    case "biz":
      if (m.op === "commission") {
        if (!areaContains(world.map.areas.residence, p.x, p.y)) { send(s, { t: "toast", text: "Замовлення оформлюються в резиденції старости.", kind: "bad" }); break; }
        const r = commissionPlot(world, p, m.plotId ?? "");
        send(s, { t: "toast", text: r.reason, kind: r.ok ? "good" : "bad" });
        if (r.ok) { s.selfDirty = true; broadcast({ t: "plots", plots: plotStates(world) }); }
      } else if (m.op !== "list") playerBiz(world, p, m.op, m.bizId, m.amount, m.workerId, m.item, m.to);
      send(s, { t: "biz", list: bizList(p.id) });
      break;
    case "inspect": { const info = inspect(m.id); if (info) send(s, { t: "inspect", info }); break; }
    case "chronicle": send(s, { t: "chronicle", entries: world.chronicle.slice(-120) }); break;
    case "pickpocket": playerPickpocket(world, p, m.npcId); break;
    case "craft": playerCraft(world, p, String(m.recipe), Number(m.n ?? 1)); break;
    case "place": playerPlace(world, p, m.item, Number(m.x), Number(m.y)); break;
    case "pickup": playerPickup(world, p); break;
    case "equip":
    case "unequip": {
      if (world.isJailed(p)) { send(s, { t: "toast", text: "У в'язниці не до перевдягань.", kind: "bad" }); break; }
      const r = m.t === "equip" ? equipItem(world, p, m.item) : SLOTS.includes(m.slot) ? unequip(world, p, m.slot) : { ok: false, reason: "Немає такого місця" };
      if (!r.ok) send(s, { t: "toast", text: r.reason ?? "Не вийшло", kind: "bad" });
      s.selfDirty = true;
      break;
    }
    case "repair":
    case "discard": {
      if (world.isJailed(p)) { send(s, { t: "toast", text: "У в'язниці не до того.", kind: "bad" }); break; }
      const r = m.t === "repair" ? (SLOTS.includes(m.slot) ? repairItem(world, p, m.slot) : { ok: false, reason: "Немає такого місця" })
        : discard(world, p, { slot: m.slot && SLOTS.includes(m.slot) ? m.slot : undefined, item: m.item });
      send(s, { t: "toast", text: r.reason, kind: r.ok ? "good" : "bad" });
      s.selfDirty = true;
      break;
    }
    case "charinfo": send(s, { t: "char", info: charInfo(world, p) }); break;
    case "lodging": {
      if (m.op === "rent") {
        const r = rentLodging(world, p, String(m.area ?? ""), m.kind === "house" ? "house" : "bed", (a) => bedsUsed(world, a));
        send(s, { t: "toast", text: r.reason, kind: r.ok ? "good" : "bad" });
      } else if (m.op === "leave") {
        const r = leaveLodging(world, p);
        send(s, { t: "toast", text: r.reason, kind: r.ok ? "info" : "bad" });
      }
      send(s, { t: "lodging", info: lodgingInfo(p) });
      s.selfDirty = true;
      break;
    }
    case "politics": {
      const r = playerPolitics(world, p, m);
      if (r) send(s, { t: "toast", text: r.reason, kind: r.ok ? "good" : "bad" });
      send(s, { t: "politics", info: politicsInfo(p) });
      s.selfDirty = true;
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml", ".map": "application/json", ".ico": "image/x-icon",
};

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/health") { res.writeHead(200).end("ok"); return; }
  if (url.pathname === "/api/ai") {
    const probe = await llmProbe();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ ...llmStatus(), reachable: probe.ok, detail: probe.detail }, null, 2));
    return;
  }
  if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/auth/")) {
    try {
      if (await handleAuth(req, res, url, {
        storage,
        characterName: (id) => (id ? world.players.get(id)?.name ?? null : null),
        guestPlayerByToken: (t) => { const g = [...world.players.values()].find((x) => x.token === t && !x.accountId); return g ? { id: g.id, name: g.name } : null; },
        linkPlayer: (pid, aid) => { const pl = world.players.get(pid); if (pl) pl.accountId = aid; },
      })) return;
    } catch (e) {
      console.error("[auth]", e);
      res.writeHead(500).end("auth error");
      return;
    }
  }
  if (url.pathname === "/api/stats") {
    const limit = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 30)));
    const rows = await storage.recentStats(limit).catch(() => []);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ now: computeStats(world), history: rows }));
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  if (!path || path.endsWith("/")) path += "index.html";
  const file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file)) { res.writeHead(404).end("not found"); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(500).end("error");
  }
});

const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 64 * 1024 });
wss.on("connection", (ws) => {
  const s: Session = { ws, playerId: null, selfDirty: false, lastSelf: "" };
  sessions.add(s);
  let msgCount = 0, windowStart = Date.now();
  ws.on("message", (raw) => {
    // crude flood protection
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; msgCount = 0; }
    if (++msgCount > 120) return;
    try {
      handle(s, JSON.parse(String(raw)) as C2S);
    } catch (e) {
      console.warn("[net] bad message:", (e as Error).message);
    }
  });
  ws.on("close", () => {
    sessions.delete(s);
    const p = s.playerId ? world.players.get(s.playerId) : undefined;
    if (p && !sessionOf(p.id)) {
      p.online = false;
      p.busy = null;
      p.offlineSince = world.time;
      world.log(`${p.name} покидає Каргат (офлайн).`, "player");
      storage.upsertPlayers([{ id: p.id, name: p.name, online: false }]).catch((e) => console.warn("[db] players:", e.message));
    }
  });
});

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  try {
    world.tick(dt);
  } catch (e) {
    console.error("[world] tick error:", e);
  }
}, 1000 / SERVER_TICK_HZ);

let lastChronicleTotal = world.chronicleTotal;
setInterval(() => {
  const ents = entSnaps();
  for (const s of sessions) {
    if (!s.playerId) continue;
    const p = world.players.get(s.playerId);
    if (!p) continue;
    send(s, { t: "snap", time: world.time, ack: p.lastInputSeq, me: { x: p.x, y: p.y }, ents });
  }
}, 1000 / SNAPSHOT_HZ);

setInterval(() => {
  for (const s of sessions) {
    if (!s.playerId) continue;
    const p = world.players.get(s.playerId);
    if (!p) continue;
    const st = selfState(p);
    const txt = JSON.stringify(st);
    if (s.selfDirty || txt !== s.lastSelf) { s.lastSelf = txt; s.selfDirty = false; send(s, { t: "self", s: st }); }
  }
  // push new chronicle entries (the "world truth" log is a developer/observer tool in the prototype)
  if (world.pendingTiles.length) {
    broadcast({ t: "tiles", changes: world.pendingTiles });
    world.pendingTiles = [];
  }
  if (world.chronicleTotal !== lastChronicleTotal) {
    const n = Math.min(50, world.chronicleTotal - lastChronicleTotal);
    lastChronicleTotal = world.chronicleTotal;
    broadcast({ t: "chronicle", entries: world.chronicle.slice(-n) });
  }
}, 250);

// construction progress for labels
let lastPlotsJson = "";
setInterval(() => {
  const ps = plotStates(world);
  const j = JSON.stringify(ps);
  if (j !== lastPlotsJson) { lastPlotsJson = j; broadcast({ t: "plots", plots: ps }); }
}, 3000);

// ---- persistence: snapshots, event log, daily statistics ----
let saving = false;
async function persistSnapshot() {
  if (saving) return;
  saving = true;
  try { await storage.saveSnapshot(snapshot(world)); }
  catch (e) { console.error("[persist] snapshot failed:", (e as Error).message); }
  finally { saving = false; }
}
setInterval(persistSnapshot, 60_000);

let eventsLogged = world.chronicleTotal;
setInterval(() => {
  const n = Math.min(world.chronicle.length, world.chronicleTotal - eventsLogged);
  if (n <= 0) return;
  eventsLogged = world.chronicleTotal;
  storage.logEvents(world.chronicle.slice(-n)).catch((e) => console.warn("[db] events:", e.message));
}, 5000);

let statsDay = Math.floor(world.time / 1440);
setInterval(() => {
  const day = Math.floor(world.time / 1440);
  if (day === statsDay) return;
  statsDay = day;
  storage.saveDailyStats(computeStats(world)).catch((e) => console.warn("[db] stats:", e.message));
}, 2000);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[world] saving before shutdown...");
  for (const p of world.players.values()) { if (p.online) p.offlineSince = world.time; p.online = false; }
  await persistSnapshot();
  await storage.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

http.listen(PORT, "0.0.0.0", () => {
  if (!existsSync(join(DIST, "index.html"))) console.warn("[http] client/dist is empty — run `npm run build`");
  console.log(`\n  Rutzarg server running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ifs of Object.values(networkInterfaces()))
    for (const i of ifs ?? []) if (i.family === "IPv4" && !i.internal) console.log(`  LAN:     http://${i.address}:${PORT}`);
  console.log(`  LLM:     ${llmDescription()}`);
  if (llmDescription() && !llmDescription().startsWith("вимкнено")) llmProbe().then((r) => console.log(`  LLM check: ${r.ok ? "✔" : "✘"} ${r.detail}`));
  console.log(`  Storage: ${storage.kind}`);
  console.log(`  Auth:    акаунти (email/пароль)${authConfig.google ? " + Google" : ""}${authConfig.allowGuests ? " + гості" : ", гості вимкнені"}`);
  console.log(`  Stats:   http://localhost:${PORT}/api/stats\n`);
});
