// DOM user interface layered over the Phaser canvas.

import type { BusinessInfo, DialogLine, DialogMsg, InspectInfo, MarketInfo, SelfState, ChronicleEntry } from "../../shared/protocol.ts";
import { ITEMS, ITEM_IDS, type ItemId } from "../../shared/items.ts";
import { SKILLS, SKILL_IDS, skillRank, type SkillId } from "../../shared/skills.ts";
import { INTERACT_RANGE } from "../../shared/constants.ts";
import { getMap, areaContains, areaAt } from "../../shared/map.ts";
import { fmtClock, dayOf, darkness, fmtDayTime } from "../../shared/time.ts";
import { net } from "./net.ts";
import { state, gameNow, latestEnt } from "./state.ts";
import { bus } from "./bus.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const map = getMap();

let dialog: DialogMsg | null = null;
/** NPC the player is currently talking to; dialog messages for anyone else are ignored. */
let dialogWith: string | null = null;
let market: MarketInfo | null = null;
let bizList: BusinessInfo[] = [];
let inspectTimer: number | null = null;

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

const PANELS = ["panel-dialog", "panel-market", "panel-biz", "panel-inspect", "panel-chronicle", "panel-help", "panel-talklog", "panel-skills"];

function openPanel(id: string) {
  const el = $(id);
  el.hidden = false;
}
function closePanel(id: string) {
  $(id).hidden = true;
  if (id === "panel-dialog" && dialog) { net.send({ t: "talk", npcId: dialog.npcId, opt: "bye" }); dialog = null; dialogWith = null; }
  if (id === "panel-inspect" && inspectTimer) { clearInterval(inspectTimer); inspectTimer = null; }
}
function togglePanel(id: string, onOpen?: () => void) {
  if ($(id).hidden) { openPanel(id); onOpen?.(); } else closePanel(id);
}
function closeAll() { for (const p of PANELS) if (!$(p).hidden) closePanel(p); }

// ---------------------------------------------------------------------------
// Toasts, chat
// ---------------------------------------------------------------------------

export function toast(text: string, kind: "info" | "good" | "bad" = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.classList.add("fade"), 3500);
  setTimeout(() => el.remove(), 4200);
}

function chatLine(html: string, cls = "") {
  const log = $("chat-log");
  const div = document.createElement("div");
  div.className = `line ${cls}`;
  div.innerHTML = html;
  log.appendChild(div);
  while (log.childElementCount > 120) log.firstElementChild!.remove();
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function bar(id: string, v: number) {
  const el = $(id);
  el.style.width = `${Math.max(0, Math.min(100, v))}%`;
  el.parentElement!.classList.toggle("low", v < 25);
}

function renderSelf(s: SelfState) {
  $("hud-name").textContent = s.name + (s.blessing ? " ✦" : "");
  $("hud-coins").textContent = String(s.coins);
  bar("bar-hunger", s.hunger);
  bar("bar-energy", s.energy);
  $("hud-hunger").textContent = String(s.hunger);
  $("hud-energy").textContent = String(s.energy);
  const inv = ITEM_IDS.filter((i) => (s.inv[i] ?? 0) > 0)
    .map((i) => `<span class="chip" style="--c:${ITEMS[i].color}" title="${ITEMS[i].name}">${ITEMS[i].name} <b>${s.inv[i]}</b></span>`).join("");
  $("inventory").innerHTML = inv || `<span class="muted">Сумка порожня</span>`;
  const busy = $("busy");
  if (s.busy) {
    busy.hidden = false;
    $("busy-label").textContent = s.busy.label;
    ($("busy-fill") as HTMLElement).style.width = `${Math.round(s.busy.progress * 100)}%`;
  } else busy.hidden = true;
  $("hud-family").innerHTML = (s.family ?? []).map((l) => `<div>❤ ${esc(l)}</div>`).join("");
  const jail = $("jail");
  if (s.jailedUntil) { jail.hidden = false; jail.textContent = `У в'язниці до ${fmtClock(s.jailedUntil)}`; } else jail.hidden = true;
}

function updateClock() {
  const t = gameNow();
  const d = darkness(t);
  const icon = d > 0.6 ? "☾" : d > 0.05 ? "◐" : "☀";
  $("hud-clock").innerHTML = `<span class="icon">${icon}</span> День ${dayOf(t)} · ${fmtClock(t)}`;
  const a = areaAt(map, state.myPos.x, state.myPos.y);
  $("hud-place").textContent = a?.name ?? "Околиці Каргата";
  $("btn-market").classList.toggle("hint", inMarket());
  $("hud-ping").textContent = `${Math.round(net.rtt)} мс`;
}

function inMarket() {
  const m = map.areas.market;
  return areaContains({ ...m, x: m.x - 2, y: m.y - 2, w: m.w + 4, h: m.h + 4 }, state.myPos.x, state.myPos.y);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function nearestNpc(): string | null {
  const snaps = state.snaps[state.snaps.length - 1];
  if (!snaps) return null;
  let best: string | null = null, bd = INTERACT_RANGE;
  const sel = state.selectedId ? snaps.ents.get(state.selectedId) : undefined;
  if (sel && sel.k !== "player" && Math.hypot(sel.x - state.myPos.x, sel.y - state.myPos.y) <= INTERACT_RANGE) return sel.id;
  for (const e of snaps.ents.values()) {
    if (e.k === "player") continue;
    const d = Math.hypot(e.x - state.myPos.x, e.y - state.myPos.y);
    if (d < bd) { bd = d; best = e.id; }
  }
  return best;
}

function interact() {
  const npc = nearestNpc();
  if (npc) return talk(npc);
  if (inMarket()) return openMarket();
  net.send({ t: "act", a: "gather" });
}

function talk(npcId: string) {
  dialogWith = npcId;
  state.selectedId = npcId;
  bus.emit("select", npcId);
  net.send({ t: "talk", npcId, opt: "open" });
}

function openMarket() {
  net.send({ t: "openMarket" });
  openPanel("panel-market");
}

function openBiz() {
  net.send({ t: "biz", op: "list" });
  togglePanel("panel-biz");
}

function openInspect(id: string | null) {
  if (!id) { toast("Спершу клацни на персонажа.", "info"); return; }
  net.send({ t: "inspect", id });
  openPanel("panel-inspect");
  if (inspectTimer) clearInterval(inspectTimer);
  inspectTimer = window.setInterval(() => { if (state.selectedId) net.send({ t: "inspect", id: state.selectedId }); }, 2000);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function skillRows(skills: Partial<Record<string, number>>, all: boolean): string {
  const ids = SKILL_IDS.filter((id) => all || (skills[id] ?? 0) >= 1);
  if (!ids.length) return `<div class="muted">Ще нічого не вміє.</div>`;
  return ids.map((id) => {
    const v = Math.floor(skills[id] ?? 0);
    return `<div class="kv"><span>${SKILLS[id as SkillId].name}</span><span class="minibar s"><i style="width:${v}%"></i></span><span class="num">${v} · ${skillRank(v)}</span></div>`;
  }).join("");
}

function renderSkills() {
  const s = state.self;
  $("skills-body").innerHTML = `${skillRows(s?.skills ?? {}, true)}
    <p class="muted">Будь-яку навичку може опанувати будь-хто: вона росте, коли нею користуєшся (рубаєш дерева — лісорубство, добуваєш руду чи камінь — гірництво...).
    Вища навичка — швидша робота. Навичка ≥30 відкриває роботу поза своїм соціальним класом.</p>`;
}

// ---------------------------------------------------------------------------
// Conversation log — every line of every dialogue, re-readable later (J)
// ---------------------------------------------------------------------------

interface Conv { npcId: string; name: string; title: string; last: number; lines: Omit<DialogLine, "id">[] }
let convs: Record<string, Conv> = {};
let convSelected: string | null = null;
const seenLines = new Set<number>();
const talklogKey = () => `rutzarg.talklog.${state.token || state.myId}`;

function loadTalklog() {
  try { convs = JSON.parse(localStorage.getItem(talklogKey()) ?? "{}") as Record<string, Conv>; } catch { convs = {}; }
}
function saveTalklog() {
  try { localStorage.setItem(talklogKey(), JSON.stringify(convs)); } catch { /* storage full or blocked */ }
}

function recordDialog(d: DialogMsg) {
  if (!Object.keys(convs).length) loadTalklog();
  let c = convs[d.npcId];
  if (!c) c = convs[d.npcId] = { npcId: d.npcId, name: d.npcName, title: d.title, last: 0, lines: [] };
  c.title = d.title;
  let added = false;
  for (const l of d.lines) {
    if (seenLines.has(l.id)) continue;
    seenLines.add(l.id);
    c.lines.push({ who: l.who, text: l.text, t: l.t, mine: l.mine });
    c.last = Date.now();
    added = true;
    chatLine(l.mine ? `<b class="me">Ти → ${esc(d.npcName)}:</b> ${esc(l.text)}` : `<b class="npc">${esc(l.who)}:</b> ${esc(l.text)}`, "dlg");
  }
  if (c.lines.length > 300) c.lines.splice(0, c.lines.length - 300);
  if (added) { saveTalklog(); if (!$("panel-talklog").hidden) renderTalklog(); }
}

function renderTalklog() {
  if (!Object.keys(convs).length) loadTalklog();
  const list = Object.values(convs).sort((a, b) => b.last - a.last);
  if (!convSelected || !convs[convSelected]) convSelected = list[0]?.npcId ?? null;
  $("talklog-list").innerHTML = list.length
    ? list.map((c) => `<button class="${c.npcId === convSelected ? "sel" : ""}" data-npc="${c.npcId}">${esc(c.name)}<span class="muted">${esc(c.title)}</span></button>`).join("")
    : `<div class="muted">Ти ще ні з ким не говорив.</div>`;
  $("talklog-list").querySelectorAll<HTMLButtonElement>("[data-npc]").forEach((b) => b.onclick = () => { convSelected = b.dataset.npc!; renderTalklog(); });
  const c = convSelected ? convs[convSelected] : undefined;
  const body = $("talklog-lines");
  body.innerHTML = c
    ? c.lines.map((l) => `<div class="dl ${l.mine ? "me" : "npc"}"><span class="muted">${fmtDayTime(l.t)}</span> <b>${esc(l.mine ? "Ти" : l.who)}:</b> ${esc(l.text)}</div>`).join("")
    : "";
  body.scrollTop = body.scrollHeight;
}

// ---------------------------------------------------------------------------
// Dialogue
// ---------------------------------------------------------------------------

function renderDialog(d: DialogMsg) {
  // Late replies (e.g. an LLM answer) must not re-open a conversation the player closed.
  if (d.npcId !== dialogWith) return;
  recordDialog(d);
  const fresh = !dialog || dialog.npcId !== d.npcId;
  dialog = d;
  const input = $("dlg-input") as HTMLInputElement;
  input.disabled = !!d.pending;
  ($("dlg-send") as HTMLButtonElement).disabled = !!d.pending;
  if (fresh) { input.value = ""; setTimeout(() => input.focus(), 0); }
  else if (!d.pending) input.focus();
  openPanel("panel-dialog");
  $("dlg-title").innerHTML = `${esc(d.npcName)} <span class="muted">· ${esc(d.title)}</span>`;
  const lines = d.lines.map((l) => `<div class="dl ${l.who === d.npcName ? "npc" : "me"}"><b>${esc(l.who)}:</b> ${esc(l.text)}</div>`).join("");
  $("dlg-lines").innerHTML = lines + (d.pending ? `<div class="dl npc pending"><b>${esc(d.npcName)}</b> думає…</div>` : "");
  $("dlg-lines").scrollTop = 1e9;
  const opts = $("dlg-opts");
  opts.innerHTML = "";
  $("dlg-arg").innerHTML = "";
  for (const o of d.options) {
    const btn = document.createElement("button");
    btn.textContent = o.label;
    btn.disabled = !!d.pending;
    btn.onclick = () => {
      if (o.id === "bye") { closePanel("panel-dialog"); return; }
      if (!o.arg) { net.send({ t: "talk", npcId: d.npcId, opt: o.id }); return; }
      renderArg(d, o.id, o.arg);
    };
    opts.appendChild(btn);
  }
}

function renderArg(d: DialogMsg, opt: string, arg: "person" | "wage" | "text" | "buy") {
  const box = $("dlg-arg");
  if (arg === "buy") {
    const list = d.sellable ?? [];
    box.innerHTML = `<select id="arg-biz">${list.map((b) => `<option value="${b.id}" data-ask="${b.ask ?? ""}">${esc(b.name)}${b.ask ? ` — просить ${b.ask}` : " — не продає"}</option>`).join("")}</select>
      <label>Твоя ціна <input id="arg-price" type="number" min="1" value="${list[0]?.ask ?? 50}"></label><button id="arg-go">Запропонувати угоду</button>
      <span class="muted">У тебе ${state.self?.coins ?? 0} срібла</span>`;
    const sel = $("arg-biz") as HTMLSelectElement;
    sel.onchange = () => { const ask = sel.selectedOptions[0]?.dataset.ask; if (ask) ($("arg-price") as HTMLInputElement).value = ask; };
    $("arg-go").onclick = () => net.send({ t: "talk", npcId: d.npcId, opt, bizId: sel.value, price: Number(($("arg-price") as HTMLInputElement).value) });
    return;
  }
  if (arg === "person") {
    box.innerHTML = `<select id="arg-person">${(d.persons ?? []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select><button id="arg-go">Запитати</button>`;
    $("arg-go").onclick = () => net.send({ t: "talk", npcId: d.npcId, opt, arg: ($("arg-person") as HTMLSelectElement).value });
  } else if (arg === "wage") {
    const biz = d.offerable ?? [];
    box.innerHTML = `<select id="arg-biz">${biz.map((b) => `<option value="${b.id}" data-w="${b.wage}">${esc(b.name)}</option>`).join("")}</select>
      <label>Платня/день <input id="arg-wage" type="number" min="1" max="50" value="${biz[0]?.wage ?? 8}"></label><button id="arg-go">Запропонувати</button>`;
    $("arg-go").onclick = () => net.send({
      t: "talk", npcId: d.npcId, opt, bizId: ($("arg-biz") as HTMLSelectElement).value, wage: Number(($("arg-wage") as HTMLInputElement).value),
    });
  } else {
    box.innerHTML = `<input id="arg-text" maxlength="200" placeholder="Що скажеш?"><button id="arg-go">Сказати</button>`;
    const send = () => { const v = ($("arg-text") as HTMLInputElement).value.trim(); if (v) net.send({ t: "talk", npcId: d.npcId, opt, arg: v }); };
    $("arg-go").onclick = send;
    ($("arg-text") as HTMLInputElement).onkeydown = (e) => { if (e.key === "Enter") send(); e.stopPropagation(); };
    ($("arg-text") as HTMLInputElement).focus();
  }
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

function renderMarket(m: MarketInfo) {
  market = m;
  const inv = state.self?.inv ?? {};
  $("market-body").innerHTML = `<table class="tbl"><tr><th>Товар</th><th>На ринку</th><th>Купити</th><th>Продати</th><th>У тебе</th><th></th></tr>` +
    m.items.map((i) => `<tr>
      <td><span class="dot" style="--c:${ITEMS[i.id].color}"></span>${esc(i.name)}</td><td>${i.stock}</td>
      <td>${i.buy}</td><td>${i.sell}</td><td>${inv[i.id] ?? 0}</td>
      <td class="acts">
        <button data-op="buy" data-i="${i.id}" data-q="1">+1</button>
        <button data-op="buy" data-i="${i.id}" data-q="5">+5</button>
        <button data-op="sell" data-i="${i.id}" data-q="1" ${(inv[i.id] ?? 0) < 1 ? "disabled" : ""}>−1</button>
        <button data-op="sell" data-i="${i.id}" data-q="${inv[i.id] ?? 0}" ${(inv[i.id] ?? 0) < 1 ? "disabled" : ""}>Усе</button>
      </td></tr>`).join("") + `</table>
      <p class="muted">Ціни залежать від запасів: дефіцит → дорожче, надлишок → дешевше. Каравани щодня вивозять частину товару.</p>`;
  for (const b of $("market-body").querySelectorAll("button")) {
    (b as HTMLButtonElement).onclick = () => net.send({ t: "market", op: b.getAttribute("data-op") as "buy" | "sell", item: b.getAttribute("data-i") as ItemId, qty: Number(b.getAttribute("data-q")) });
  }
}

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------

function renderBiz(list: BusinessInfo[]) {
  bizList = list;
  const me = state.myId;
  const inResidence = areaContains(map.areas.residence, state.myPos.x, state.myPos.y);
  $("biz-body").innerHTML = list.map((b) => {
    const mine = b.ownerId === me;
    const workers = b.workers.map((w) => `${esc(w.name)}${w.unpaidDays ? ` <span class="bad">(не оплачено ${w.unpaidDays} дн.)</span>` : ""}${mine && w.id !== me ? ` <button class="mini" data-fire="${w.id}" data-biz="${b.id}">звільнити</button>` : ""}`).join(", ") || "—";
    const stock = Object.entries(b.stock).filter(([, v]) => (v ?? 0) > 0).map(([k, v]) => `${ITEMS[k as ItemId]?.name ?? k}: ${v}`).join(", ") || "—";
    return `<div class="biz ${mine ? "mine" : ""}">
      <div class="biz-h"><b>${esc(b.name)}</b> <span class="muted">${esc(b.ownerName)}</span>
        ${b.forSale !== null ? `<span class="sale">Продається: ${b.forSale} срібла</span> <button data-buy="${b.id}" ${inResidence ? "" : "disabled title='Купівля — у резиденції старости'"}>Купити</button>` : ""}</div>
      <div class="biz-r">Платня: <b>${b.wage}</b>/день · Працівники ${b.workers.length}/${b.maxWorkers}: ${workers}</div>
      <div class="biz-r">Години: ${b.workHours[0]}:00–${b.workHours[1]}:00 · Продукт: ${b.product ? ITEMS[b.product].name : "—"} · Склад: ${stock} · Каса: ${b.treasury}</div>
      <div class="biz-r muted">Хто може працювати: ${b.allowedClasses.join(", ")}</div>
      ${mine ? `<div class="biz-own">
        <label>Платня <input type="number" min="1" max="50" value="${b.wage}" id="wage-${b.id}"></label><button data-wage="${b.id}">Встановити</button>
        <label>Сума <input type="number" min="1" value="20" id="amt-${b.id}"></label><button data-dep="${b.id}">Покласти в касу</button><button data-wd="${b.id}">Забрати</button>
        <div class="muted">Наймай людей у розмові з ними («Запропонувати роботу»). Безробітні NPC приходять самі, якщо є вакансія. Платня виплачується о 18:00 з каси — якщо грошей не вистачить, люди це запам'ятають.</div>
      </div>` : ""}
    </div>`;
  }).join("");
  const deposits = state.plots.filter((p) => p.kind !== "house");
  $("biz-body").insertAdjacentHTML("beforeend", `<h3 class="sect">Родовища: шахти й кар'єри</h3>
    <p class="muted">Руда й камінь на поверхні закінчуються. Тут можна замовити будівництво шахти чи кар'єру — артіль закупить матеріали й збудує, а справа стане твоєю (оформлення — у резиденції старости).</p>` +
    deposits.map((d) => `<div class="deposit"><b>${esc(d.name)}</b> — ${d.resource === "ore" ? "руда" : "камінь"}, запас: ${d.remaining ?? "?"}
      ${d.stage === "built" ? ` · <span class="good">працює</span>` : d.stage === "site" ? ` · будується ${d.progress ?? 0}% (${esc(d.by ?? "")})` : d.queued ? ` · у черзі (${esc(d.by ?? "")})` :
        d.cost !== null ? ` · <button data-commission="${d.id}" ${inResidence ? "" : "disabled title='Оформлення — у резиденції старости'"}>Замовити ${d.kind === "mine" ? "шахту" : "кар'єр"} за ${d.cost}</button>` : ""}</div>`).join(""));
  const body = $("biz-body");
  body.querySelectorAll<HTMLButtonElement>("[data-commission]").forEach((b) => b.onclick = () => net.send({ t: "biz", op: "commission", plotId: b.dataset.commission }));
  body.querySelectorAll<HTMLButtonElement>("[data-buy]").forEach((b) => b.onclick = () => net.send({ t: "biz", op: "buy", bizId: b.dataset.buy }));
  body.querySelectorAll<HTMLButtonElement>("[data-wage]").forEach((b) => b.onclick = () => net.send({ t: "biz", op: "setWage", bizId: b.dataset.wage, amount: Number(($(`wage-${b.dataset.wage}`) as HTMLInputElement).value) }));
  body.querySelectorAll<HTMLButtonElement>("[data-dep]").forEach((b) => b.onclick = () => net.send({ t: "biz", op: "deposit", bizId: b.dataset.dep, amount: Number(($(`amt-${b.dataset.dep}`) as HTMLInputElement).value) }));
  body.querySelectorAll<HTMLButtonElement>("[data-wd]").forEach((b) => b.onclick = () => net.send({ t: "biz", op: "withdraw", bizId: b.dataset.wd, amount: Number(($(`amt-${b.dataset.wd}`) as HTMLInputElement).value) }));
  body.querySelectorAll<HTMLButtonElement>("[data-fire]").forEach((b) => b.onclick = () => net.send({ t: "biz", op: "fire", bizId: b.dataset.biz, workerId: b.dataset.fire }));
}

// ---------------------------------------------------------------------------
// Observer / inspector (developer view of an agent's mind)
// ---------------------------------------------------------------------------

const P_NAMES: Record<string, string> = { greed: "Жадібність", courage: "Сміливість", loyalty: "Лояльність", ambition: "Амбіції", lawfulness: "Законослухняність", empathy: "Емпатія", sociability: "Товариськість" };

function renderInspect(i: InspectInfo) {
  if (i.id !== state.selectedId) return;
  const needs = Object.entries(i.needs).map(([k, v]) => `<div class="kv"><span>${k}</span><span class="minibar"><i style="width:${v}%"></i></span></div>`).join("");
  const pers = Object.entries(i.personality).map(([k, v]) => `<div class="kv"><span>${P_NAMES[k] ?? k}</span><span class="minibar p"><i style="width:${v * 100}%"></i></span></div>`).join("");
  const rels = i.relations.map((r) => `<div class="rel"><b>${esc(r.name)}</b> довіра ${r.trust} · симпатія ${r.affection}${r.fear ? ` · страх ${r.fear}` : ""}</div>`).join("") || `<div class="muted">—</div>`;
  const mems = i.memories.map((m) => `<div class="mem"><span class="muted">${fmtDayTime(m.t)}</span> ${esc(m.text)} <span class="conf" title="впевненість">${Math.round(m.conf * 100)}%</span></div>`).join("") || `<div class="muted">—</div>`;
  $("inspect-body").innerHTML = `
    <h3>${esc(i.name)}</h3>
    <div class="muted">${esc(i.profession)} · ${esc(i.socialClass)} · ${esc(i.faction)}</div>
    <div class="kv"><span>Робота</span><span>${esc(i.job)}</span></div>
    <div class="kv"><span>Гроші</span><span>${i.coins}</span></div>
    <div class="kv"><span>Де</span><span>${esc(i.location)}</span></div>
    <div class="kv"><span>Зараз</span><span>${esc(i.activity)}</span></div>
    ${needs}
    <div class="kv"><span>Дім</span><span>${esc(i.home ?? "—")}</span></div>
    <h4>Навички</h4>${skillRows(i.skills ?? {}, false)}
    ${i.family?.length ? `<h4>Сім'я</h4>${i.family.map((f) => `<div>• ${esc(f)}</div>`).join("")}` : ""}
    ${i.goals.length ? `<h4>Цілі</h4>${i.goals.map((g) => `<div>• ${esc(g)}</div>`).join("")}` : ""}
    ${pers ? `<h4>Характер</h4>${pers}` : ""}
    <h4>Стосунки</h4>${rels}
    <h4>Пам'ять (переконання, не обов'язково правда)</h4>${mems}`;
}

// ---------------------------------------------------------------------------
// Chronicle (world truth log — observer tool for the prototype)
// ---------------------------------------------------------------------------

function addChronicle(entries: ChronicleEntry[]) {
  const box = $("chronicle-body");
  for (const e of entries) {
    // the welcome history and the live stream can overlap
    if (state.chronicle.slice(-80).some((c) => c.t === e.t && c.text === e.text)) continue;
    state.chronicle.push(e);
    const div = document.createElement("div");
    div.className = `chr ${e.kind}`;
    div.innerHTML = `<span class="muted">${fmtDayTime(e.t)}</span> ${esc(e.text)}`;
    box.appendChild(div);
  }
  while (box.childElementCount > 300) box.firstElementChild!.remove();
  box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function initUI() {
  $("ui").hidden = false;

  net.on((m) => {
    switch (m.t) {
      case "self": state.self = m.s; renderSelf(m.s); if (!$("panel-skills").hidden) renderSkills(); if (!$("panel-market").hidden && market) renderMarket(market); break;
      case "toast": toast(m.text, m.kind); break;
      case "chat": chatLine(`<b class="pl">${esc(m.name)}:</b> ${esc(m.text)}`); break;
      case "say": {
        const e = latestEnt(m.id);
        if (!e || e.k === "player") break;
        if (Math.hypot(e.x - state.myPos.x, e.y - state.myPos.y) < 12) chatLine(`<b class="npc">${esc(e.n)}:</b> ${esc(m.text)}`, "npc");
        break;
      }
      case "dialog": renderDialog(m); break;
      case "dialogClose": if (dialog) { dialog = null; dialogWith = null; $("panel-dialog").hidden = true; } break;
      case "market": renderMarket(m.m); break;
      case "biz": renderBiz(m.list); break;
      case "inspect": renderInspect(m.info); break;
      case "chronicle": addChronicle(m.entries); break;
      case "error": toast(m.text, "bad"); break;
    }
  });

  bus.on("select", (id: string) => {
    const e = latestEnt(id);
    if (!e) return;
    $("ctx").hidden = false;
    $("ctx-name").textContent = `${e.n}${e.s ? ` · ${e.s}` : ""}`;
    $("ctx-talk").hidden = e.k === "player";
    $("ctx-steal").hidden = e.k !== "npc";
    if (!$("panel-inspect").hidden) openInspect(id);
  });

  $("ctx-talk").onclick = () => { if (state.selectedId) talk(state.selectedId); };
  $("ctx-steal").onclick = () => { if (state.selectedId) net.send({ t: "pickpocket", npcId: state.selectedId }); };
  $("ctx-inspect").onclick = () => openInspect(state.selectedId);
  $("ctx-close").onclick = () => { $("ctx").hidden = true; state.selectedId = null; };

  $("btn-interact").onclick = interact;
  $("btn-gather").onclick = () => net.send({ t: "act", a: "gather" });
  $("btn-eat").onclick = () => net.send({ t: "act", a: "eat" });
  $("btn-rest").onclick = () => net.send({ t: "act", a: "rest" });
  $("btn-pray").onclick = () => net.send({ t: "act", a: "pray" });
  $("btn-plant").onclick = () => net.send({ t: "act", a: "plant" });
  $("btn-market").onclick = () => { if (inMarket()) openMarket(); else toast("Ринок — на центральній площі міста.", "info"); };
  $("btn-biz").onclick = openBiz;
  $("btn-chronicle").onclick = () => togglePanel("panel-chronicle");
  $("btn-inspect").onclick = () => ($("panel-inspect").hidden ? openInspect(state.selectedId) : closePanel("panel-inspect"));
  $("btn-help").onclick = () => togglePanel("panel-help");
  for (const id of PANELS) $(id).querySelector(".close")?.addEventListener("click", () => closePanel(id));

  // Free text to the NPC in the current dialogue
  const dlgInput = $("dlg-input") as HTMLInputElement;
  const sayToNpc = () => {
    const v = dlgInput.value.trim();
    if (!v || !dialog || dialog.pending) return;
    net.send({ t: "talk", npcId: dialog.npcId, opt: "say", arg: v });
    dlgInput.value = "";
  };
  $("dlg-send").onclick = sayToNpc;
  dlgInput.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") sayToNpc();
    else if (e.key === "Escape") { dlgInput.blur(); closePanel("panel-dialog"); }
  };

  const chatInput = $("chat-input") as HTMLInputElement;
  chatInput.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const v = chatInput.value.trim();
      if (v) net.send({ t: "chat", text: v });
      chatInput.value = "";
      chatInput.blur();
    } else if (e.key === "Escape") chatInput.blur();
  };

  window.addEventListener("keydown", (e) => {
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
    switch (e.key.toLowerCase()) {
      case "enter": chatInput.focus(); e.preventDefault(); break;
      case "e": case "у": interact(); break;
      case "f": case "а": net.send({ t: "act", a: "gather" }); break;
      case "q": case "й": net.send({ t: "act", a: "eat" }); break;
      case "r": case "к": net.send({ t: "act", a: "rest" }); break;
      case "p": case "з": net.send({ t: "act", a: "pray" }); break;
      case "t": case "е": net.send({ t: "act", a: "plant" }); break;
      case "m": case "ь": if (inMarket()) openMarket(); else toast("Ринок — на центральній площі міста.", "info"); break;
      case "b": case "и": openBiz(); break;
      case "l": case "д": togglePanel("panel-chronicle"); break;
      case "i": case "ш": $("panel-inspect").hidden ? openInspect(state.selectedId) : closePanel("panel-inspect"); break;
      case "h": case "р": togglePanel("panel-help"); break;
      case "j": case "о": togglePanel("panel-talklog", renderTalklog); break;
      case "k": case "л": togglePanel("panel-skills", renderSkills); break;
      case "escape": closeAll(); $("ctx").hidden = true; break;
    }
  });

  // close dialog automatically if we walk away
  setInterval(() => {
    updateClock();
    if (dialog) {
      const e = latestEnt(dialog.npcId);
      if (!e || Math.hypot(e.x - state.myPos.x, e.y - state.myPos.y) > INTERACT_RANGE + 2) {
        const name = dialog.npcName;
        closePanel("panel-dialog");
        toast(`Розмову з ${name} перервано. Перечитати її можна в «Розмовах» (J).`, "info");
      }
    }
    if (!$("panel-biz").hidden && bizList.length) { /* refreshed by server replies */ }
  }, 250);

  // keep-alive: while the dialog window is open the NPC keeps waiting for us
  setInterval(() => { if (dialog) net.send({ t: "talk", npcId: dialog.npcId, opt: "keep" }); }, 5000);
  $("btn-talklog").onclick = () => togglePanel("panel-talklog", renderTalklog);
  $("btn-skills").onclick = () => togglePanel("panel-skills", renderSkills);

  chatLine(`<span class="muted">Ласкаво просимо до Каргата. Натисни <b>H</b> — довідка. <b>Enter</b> — чат з іншими гравцями.</span>`);
}
