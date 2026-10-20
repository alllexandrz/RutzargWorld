// DOM user interface layered over the Phaser canvas.

import type { BusinessInfo, CharInfo, LodgingInfo, DialogLine, DialogMsg, InspectInfo, MarketInfo, SelfState, ChronicleEntry, PoliticsInfo } from "../../shared/protocol.ts";
import { ITEMS, ITEM_IDS, type ItemGroup, type ItemId, type Slot } from "../../shared/items.ts";
import { SLOT_NAMES, condLabel, usesLeft, usesOf } from "../../shared/gear.ts";
import { RECIPES, STATION_NAMES, craftMinutes, nearStation, type Station } from "../../shared/crafting.ts";
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

const PANELS = ["panel-dialog", "panel-market", "panel-biz", "panel-inspect", "panel-chronicle", "panel-help", "panel-talklog", "panel-char", "panel-craft", "panel-politics"];

function openPanel(id: string) {
  const el = $(id);
  el.hidden = false;
  raisePanel(el);
  clampPanel(el);
}

// ---------------------------------------------------------------------------
// Draggable windows: grab the title bar. The position is remembered per window
// (per browser); double-click the title bar to put the window back.
// ---------------------------------------------------------------------------

let topZ = 5;
function raisePanel(el: HTMLElement) { el.style.zIndex = String(++topZ); }

const POS_KEY = "rutzarg.panelPos";
function loadPositions(): Record<string, { x: number; y: number }> {
  try { return JSON.parse(localStorage.getItem(POS_KEY) ?? "{}"); } catch { return {}; }
}
function savePosition(id: string, pos: { x: number; y: number } | null) {
  try {
    const all = loadPositions();
    if (pos) all[id] = pos; else delete all[id];
    localStorage.setItem(POS_KEY, JSON.stringify(all));
  } catch { /* storage unavailable: positions just aren't remembered */ }
}

function placePanel(el: HTMLElement, x: number, y: number) {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.right = "auto";
  el.style.transform = "none";
}

/** Keep at least the title bar reachable after a resize or on reopen. */
function clampPanel(el: HTMLElement) {
  if (el.style.transform !== "none") return;
  const r = el.getBoundingClientRect();
  const x = Math.max(60 - r.width, Math.min(window.innerWidth - 60, r.left));
  const y = Math.max(0, Math.min(window.innerHeight - 40, r.top));
  if (x !== r.left || y !== r.top) placePanel(el, x, y);
}

function makeDraggable(el: HTMLElement) {
  const bar = el.querySelector(".ph") as HTMLElement | null;
  if (!bar) return;
  const saved = loadPositions()[el.id];
  if (saved) placePanel(el, saved.x, saved.y);
  el.addEventListener("pointerdown", () => raisePanel(el));
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, select, a")) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    placePanel(el, r.left, r.top);
    bar.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      const x = Math.max(60 - r.width, Math.min(window.innerWidth - 60, ev.clientX - dx));
      const y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy));
      placePanel(el, x, y);
    };
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
      const p = el.getBoundingClientRect();
      savePosition(el.id, { x: Math.round(p.left), y: Math.round(p.top) });
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
    e.preventDefault();
  });
  bar.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    el.style.left = el.style.top = el.style.right = el.style.transform = "";
    savePosition(el.id, null);
  });
}
function closePanel(id: string) {
  $(id).hidden = true;
  if (id === "panel-dialog" && dialog) { net.send({ t: "talk", npcId: dialog.npcId, opt: "bye" }); dialog = null; dialogWith = null; }
  if (id === "panel-inspect" && inspectTimer) { clearInterval(inspectTimer); inspectTimer = null; }
  if (id === "panel-char" && charTimer) { clearInterval(charTimer); charTimer = null; }
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
    .map((i) => ITEMS[i].obj !== undefined
      ? `<span class="chip placeable" data-place="${i}" style="--c:${ITEMS[i].color}" title="${ITEMS[i].name} — клікни, щоб поставити">${ITEMS[i].name} <b>${s.inv[i]}</b></span>`
      : ITEMS[i].slot
      ? `<span class="chip placeable" data-equip="${i}" style="--c:${ITEMS[i].color}" title="${ITEMS[i].name} — клікни, щоб вдягнути">${ITEMS[i].name} <b>${s.inv[i]}</b></span>`
      : `<span class="chip" style="--c:${ITEMS[i].color}" title="${ITEMS[i].name}">${ITEMS[i].name} <b>${s.inv[i]}</b></span>`).join("");
  $("inventory").innerHTML = inv || `<span class="muted">Сумка порожня</span>`;
  const busy = $("busy");
  if (s.busy) {
    busy.hidden = false;
    $("busy-label").textContent = s.busy.label;
    ($("busy-fill") as HTMLElement).style.width = `${Math.round(s.busy.progress * 100)}%`;
  } else busy.hidden = true;
  const owed = (s.debts ?? []).reduce((n, d) => n + d.owe, 0);
  $("hud-home").innerHTML = (s.home
    ? `⌂ ${esc(s.home.name)}${s.home.debt ? ` <span class="bad">борг ${s.home.debt}</span>` : ""}`
    : `<span class="bad">⌂ ніде ночувати</span>`) + (owed ? `<div class="${s.debts.some((d) => d.overdueDays) ? "bad" : ""}">Борги: ${owed} срібла</div>` : "")
    + (s.equip?.weapon ? (ITEMS[s.equip.weapon.item].uses ? `<div>⚒ ${ITEMS[s.equip.weapon.item].name}: ${usesLeft(s.equip.weapon)}/${usesOf(s.equip.weapon.item)}</div>` : "") : `<div class="muted">⚒ без знаряддя</div>`);
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

// ---------------------------------------------------------------------------
// Character panel (I): gear, bag, stats
// ---------------------------------------------------------------------------

type CharTab = "gear" | "bag" | "stats" | "home";
let charTab: CharTab = "gear";
let charInfo: CharInfo | null = null;
let charTimer: number | null = null;

function openChar(tab?: CharTab) {
  if (tab) charTab = tab;
  else if (!$("panel-char").hidden) { closePanel("panel-char"); return; }
  openPanel("panel-char");
  net.send({ t: "charinfo" });
  if (charTab === "home") net.send({ t: "lodging", op: "info" });
  if (!charTimer) charTimer = window.setInterval(() => {
    if (charTab === "stats") net.send({ t: "charinfo" });
    if (charTab === "home") net.send({ t: "lodging", op: "info" });
  }, 3000);
  renderChar();
}

function statText(id: ItemId): string {
  const st = ITEMS[id].stats ?? {};
  const parts: string[] = [];
  if (st.attack) parts.push(`атака +${st.attack}`);
  if (st.armor) parts.push(`захист +${st.armor}`);
  if (st.presence) parts.push(`вигляд +${st.presence}`);
  for (const [r, v] of Object.entries(st.gather ?? {}) as [ItemId, number][]) parts.push(`${ITEMS[r].name.toLowerCase()} +${Math.round(v * 100)}%`);
  return parts.join(" · ");
}

const DOLL: (Slot | null)[] = [null, "head", null, "weapon", "body", "offhand", null, "legs", null, null, "feet", null];

function gearTab(s: SelfState): string {
  const slots = DOLL.map((slot) => {
    if (!slot) return `<div class="doll-gap"></div>`;
    const w = s.equip?.[slot];
    if (!w) return `<div class="slot empty"><div class="sn">${SLOT_NAMES[slot]}</div><div class="muted">порожньо</div></div>`;
    const cls = w.dur < 25 ? "bad" : w.dur < 50 ? "warn" : "";
    const tool = ITEMS[w.item].uses !== undefined;
    const rep = s.repairs?.find((r) => r.slot === slot);
    return `<div class="slot" style="--c:${ITEMS[w.item].color}">
      <div class="sn">${SLOT_NAMES[slot]}</div>
      <div class="it">${ITEMS[w.item].name}</div>
      <div class="muted st">${statText(w.item)}</div>
      <div class="dur ${cls}" title="Стан: ${condLabel(w.dur)}"><i style="width:${w.dur}%"></i></div>
      <div class="muted st">${tool ? `міцність ${usesLeft(w)}/${usesOf(w.item)}` : `${condLabel(w.dur)} · ${w.dur}%`}</div>
      <div class="slot-btns"><button class="mini" data-unequip="${slot}">Зняти</button>
        ${rep ? `<button class="mini" data-repair="${slot}" ${s.coins < rep.cost ? "disabled" : ""} title="${esc(rep.where)}">Полагодити · ${rep.cost}</button>` : ""}
        <button class="mini danger" data-discard-slot="${slot}" title="Викинути">✕</button></div>
    </div>`;
  }).join("");
  const spare = ITEM_IDS.filter((i) => ITEMS[i].slot && (s.inv[i] ?? 0) > 0);
  const spareHtml = spare.length
    ? spare.map((i) => {
      const cur = s.equip?.[ITEMS[i].slot!];
      return `<div class="kv"><span><span class="dot" style="--c:${ITEMS[i].color}"></span>${ITEMS[i].name} ×${s.inv[i]} <span class="muted">· ${SLOT_NAMES[ITEMS[i].slot!].toLowerCase()} · ${statText(i)}</span></span>
        <button class="mini" data-equip="${i}">${cur ? `Замінити ${ITEMS[cur.item].name.toLowerCase()}` : "Вдягнути"}</button></div>`;
    }).join("")
    : `<div class="muted">У сумці немає одягу чи зброї. Пошити або викувати — у «Ремеслі» (C), купити — на ринку (M).</div>`;
  const st = s.stats;
  return `<div class="char-gear">
      <div class="doll">${slots}</div>
      <div class="char-side">
        <h4>Бойові якості</h4>
        <div class="kv"><span>Атака</span><b>${st.attack}</b></div>
        <div class="kv"><span>Захист</span><b>${st.armor}</b></div>
        <div class="kv"><span>Вигляд</span><b>${st.presence}</b></div>
        <div class="kv"><span>Сила в бою</span><b>${st.power}</b></div>
        ${(s.equip && Object.values(s.equip).some((x) => x && x.dur < 100)) && !s.repairs?.length ? `<p class="muted">Полагодити зношене можна біля ковадла (залізні речі — кузня Ульфа) чи верстака (дерев'яні й одяг). У чужій майстерні — за плату власнику, на своїй станції — лише матеріали.</p>` : ""}
        <p class="muted">Сила = атака + захист + навичка «Бій». Хто помітно сильніший за вартового, може відбитися від арешту. Вигляд — як тебе сприймають люди (вибори).</p>
        <h4>Можна вдягнути</h4>${spareHtml}
      </div>
    </div>
    <p class="muted">Знаряддя в руці пришвидшує роботу й зношується від неї; одяг зношується щодня. Знята річ пам'ятає свій знос.</p>`;
}

const GROUPS: { g: ItemGroup | "food"; title: string }[] = [
  { g: "raw", title: "Ресурси" }, { g: "food", title: "Їжа" }, { g: "material", title: "Матеріали" },
  { g: "wear", title: "Одяг, зброя, знаряддя" }, { g: "placeable", title: "Речі для дому й будівництва" },
];

function bagTab(s: SelfState): string {
  const have = ITEM_IDS.filter((i) => (s.inv[i] ?? 0) > 0);
  let value = 0;
  const sections = GROUPS.map(({ g, title }) => {
    const items = have.filter((i) => (i === "meal" ? "food" : ITEMS[i].group) === g);
    if (!items.length) return "";
    const cards = items.map((i) => {
      const def = ITEMS[i], n = s.inv[i] ?? 0;
      value += def.basePrice * n;
      const act = def.slot ? `<span class="slot-btns"><button class="mini" data-equip="${i}">Вдягнути</button><button class="mini danger" data-discard-item="${i}" title="Викинути одну">✕</button></span>`
        : def.obj !== undefined ? `<button class="mini" data-place="${i}">Поставити</button>`
        : i === "meal" ? `<button class="mini" data-eat="1">З'їсти</button>` : "";
      return `<div class="card" style="--c:${def.color}"><div class="cn">${def.name}</div><div class="cq">×${n}</div>
        <div class="muted cv">≈ ${def.basePrice * n} срібла${def.slot ? ` · ${statText(i)}` : ""}</div>${act}</div>`;
    }).join("");
    return `<h4>${title}</h4><div class="cards">${cards}</div>`;
  }).join("");
  return `<div class="kv"><span>Гроші</span><b>⛁ ${s.coins} срібла</b></div>
    <div class="kv"><span>Речей у сумці</span><span>${have.reduce((a, i) => a + (s.inv[i] ?? 0), 0)} · орієнтовна вартість ≈ ${value} срібла</span></div>
    ${sections || `<p class="muted">Сумка порожня. Збирай ресурси (F), купуй на ринку (M), майструй (C).</p>`}`;
}

function statsTab(s: SelfState): string {
  const c = charInfo;
  const bar = (label: string, v: number) => `<div class="kv"><span>${label}</span><span class="minibar"><i style="width:${v}%"></i></span><span class="num">${v}</span></div>`;
  const rep = c?.reputation;
  const people = (l: { name: string; v: number }[]) => l.map((x) => `${esc(x.name)} <span class="muted">(${x.v > 0 ? "+" : ""}${x.v})</span>`).join(", ") || "—";
  const gather = c ? Object.entries(c.gather).map(([k, v]) => `${k} +${v}%`).join(", ") : "";
  return `<div class="char-stats">
    <div>
      <h4>Хто ти</h4>
      ${c ? `<div class="kv"><span>Клас</span><span>${esc(c.socialClass)}</span></div>
      <div class="kv"><span>Фракція</span><span>${esc(c.faction)}</span></div>
      <div class="kv"><span>Робота</span><span>${esc(c.job ?? "—")}</span></div>
      <div class="kv"><span>Справи</span><span>${esc(c.businesses.join(", ") || "—")}</span></div>
      <div class="kv"><span>У Каргаті</span><span>${c.daysInWorld !== null ? `${c.daysInWorld} дн.` : "—"}</span></div>
      <div class="kv"><span>Зараз</span><span>${esc(c.location)}</span></div>
      <div class="kv"><span>Житло</span><span>${s.home ? `${esc(s.home.name)} (${s.home.kind === "own" ? "власний дім" : `${s.home.kind === "house" ? "будинок" : s.home.kind === "bench" ? "лава" : "ліжко"}, ${s.home.price}/ніч`})` : `<span class="bad">ніде</span>`}</span></div>
      ${c.lastJailed !== null ? `<div class="kv"><span>Востаннє у в'язниці</span><span>${fmtDayTime(c.lastJailed)}</span></div>` : ""}
      ${c.roles.map((r) => `<div>• ${esc(r)}</div>`).join("")}` : `<div class="muted">Завантаження…</div>`}
      <h4>Стан</h4>
      ${bar("Ситість", s.hunger)}${bar("Енергія", s.energy)}
      ${s.jailedUntil ? `<div class="bad">У в'язниці до ${fmtClock(s.jailedUntil)}</div>` : ""}
      ${s.blessing ? `<div>✦ Благословення Клумнога</div>` : ""}
      <h4>Бойові якості</h4>
      <div class="kv"><span>Атака / Захист</span><span>${s.stats.attack} / ${s.stats.armor}</span></div>
      <div class="kv"><span>Сила в бою</span><span>${s.stats.power}</span></div>
      <div class="kv"><span>Вигляд</span><span>${s.stats.presence}</span></div>
      ${gather ? `<div class="kv"><span>Знаряддя</span><span>${gather}</span></div>` : ""}
      ${s.debts?.length ? `<h4>Борги</h4>${s.debts.map((d) => `<div class="kv ${d.overdueDays ? "bad" : ""}"><span>${esc(d.lender)}</span><span>${d.owe} срібла · ${d.overdueDays ? `прострочено ${d.overdueDays} дн.` : `до ${fmtDayTime(d.due)}`}</span></div>`).join("")}
        <p class="muted">Віддати — у розмові з кредитором. Прострочений борг росте, а через 3 дні кредитор іде до варти.</p>` : ""}
      ${s.family?.length ? `<h4>Сім'я</h4>${s.family.map((f) => `<div>❤ ${esc(f)}</div>`).join("")}` : ""}
    </div>
    <div>
      <h4>Навички</h4>${skillRows(s.skills ?? {}, true)}
      <h4>Репутація</h4>
      ${rep ? `<div class="kv"><span>Тебе знають</span><span>${rep.known} з ${rep.adults} дорослих</span></div>
      <div class="kv"><span>Прихильні / ворожі</span><span><span class="good">${rep.friends}</span> / <span class="bad">${rep.foes}</span></span></div>
      <div class="kv"><span>Довіра · повага · страх</span><span>${rep.trust} · ${rep.respect} · ${rep.fear}</span></div>
      <div class="kv"><span>Найкраще думають</span><span>${people(c!.friends)}</span></div>
      <div class="kv"><span>Найгірше думають</span><span>${people(c!.foes)}</span></div>` : ""}
      <h4>Що про тебе кажуть</h4>
      ${c?.rumors.length ? c.rumors.map((r) => `<div class="mem">${esc(r.text)} <span class="conf" title="скільки людей у це вірять">${r.n} ос.</span></div>`).join("") : `<div class="muted">Поки нічого — ти ще ніхто в Каргаті.</div>`}
    </div>
  </div>
  <p class="muted">Навички ростуть, коли ними користуєшся; вища навичка — швидша робота, ≥30 відкриває роботу поза своїм класом. Репутація — це те, що люди пам'ятають і переказують одне одному, а не очки.</p>`;
}

let lodging: LodgingInfo | null = null;

const KIND_NAMES: Record<string, string> = { bed: "койкомісце (ліжко)", bench: "місце на лаві в таверні — сон гірший", house: "увесь будинок", own: "власний дім" };

/** Own houses (letting beds) and free plots to commission one. */
function ownHomes(s: SelfState): string {
  const l = lodging;
  if (!l) return "";
  const owned = l.owned.map((h) => `<div class="lodge-cur">
      <div class="kv"><span>Твій дім</span><b>${esc(h.name)}</b></div>
      <div class="kv"><span>Ліжок</span><span>${h.beds}${h.lodgers.length ? ` · мешканці: ${h.lodgers.map(esc).join(", ")}` : ""}</span></div>
      <label class="chk"><input type="checkbox" id="let-${h.area}" ${h.letting ? "checked" : ""}> Здавати вільні ліжка</label>
      <label>ціна за ніч <input type="number" min="1" max="30" value="${h.price}" id="letp-${h.area}" style="width:56px"></label>
      <button class="mini" data-letting="${h.area}">Зберегти</button>
      <div class="muted">Мешканці (NPC і гравці) платитимуть тобі щовечора. У своєму домі ти спиш, майструєш і ставиш меблі безкоштовно.</div>
    </div>`).join("");
  const allPlots = state.plots.filter((p) => p.kind === "house" && p.stage !== "built");
  // building sites first, then a few free plots
  const plots = [...allPlots.filter((p) => p.stage !== "empty" || p.queued), ...allPlots.filter((p) => p.stage === "empty" && !p.queued).slice(0, 4)];
  const more = allPlots.length - plots.length;
  const mine = state.plots.filter((p) => p.kind === "house" && p.stage !== "empty" && p.by === s.name);
  const rows = plots.map((p) => `<div class="deposit"><b>${esc(p.name)}</b>
      ${p.stage === "site" ? ` · будується ${p.progress ?? 0}% (${esc(p.by ?? "")})` : p.queued ? ` · у черзі (${esc(p.by ?? "")})` :
        ` · <button class="mini" data-commission-house="${p.id}" ${l.atResidence && s.coins >= l.houseCost ? "" : "disabled"}>Замовити за ${p.cost ?? l.houseCost}</button>`}</div>`).join("");
  return `<h4>Свій дім</h4>${owned}
    ${mine.length && !l.owned.length ? `<div class="muted">Твій будинок будується: ${mine.map((p) => `${esc(p.name)} ${p.progress ?? 0}%`).join(", ")}.</div>` : ""}
    ${rows ? `${rows}${more > 0 ? `<div class="muted">…і ще ${more} вільних ділянок</div>` : ""}<p class="muted">Будинок замовляють у резиденції старости: платиш артілі (матеріали + праця), вона закупить усе й збудує, а дім стане твоїм.${l.atResidence ? "" : " Зараз ти не в резиденції."}</p>` : `<div class="muted">Вільних ділянок під будинок немає.</div>`}`;
}

function homeTab(s: SelfState): string {
  const l = lodging;
  const cur = l?.current;
  const curHtml = cur
    ? `<div class="lodge-cur">
        <div class="kv"><span>Де мешкаєш</span><b>${esc(cur.name)}</b></div>
        <div class="kv"><span>${cur.kind === "own" ? "Що це" : "Що винаймаєш"}</span><span>${KIND_NAMES[cur.kind]}</span></div>
        ${cur.kind === "own" ? "" : `<div class="kv"><span>Плата</span><span>${cur.price} срібла за ніч · щовечора о 21:00</span></div>`}
        <div class="kv"><span>Господар</span><span>${esc(cur.landlord)}</span></div>
        <div class="kv"><span>Мешкаєш з</span><span>${fmtDayTime(cur.since)}</span></div>
        ${cur.debt ? `<div class="kv bad"><span>Борг за житло</span><b>${cur.debt} срібла</b></div><div class="bad">Не заплатиш кілька ночей — виселять.</div>` : ""}
        <div class="kv"><span>Зараз</span><span>${cur.here ? `<span class="good">ти вдома — R: ${cur.kind === "bench" ? "сон на лаві (гірший)" : "повноцінний сон"}</span>` : "не вдома"}</span></div>
        <button data-leave="1">${cur.kind === "own" ? "Не ночувати тут" : "З'їхати"}</button>
      </div>`
    : `<div class="lodge-cur bad">Ти ніде не мешкаєш. Спиш де доведеться — сон неглибокий (сил набираєшся у 2,5 раза повільніше).</div>`;
  const offers = l?.offers ?? [];
  const rows = offers.map((o) => `<tr>
      <td>${esc(o.name)}</td><td>${o.kind === "house" ? "увесь будинок" : `${o.kind === "bench" ? "місце на лаві" : "ліжко"} <span class="muted">(вільних ${o.free})</span>`}</td>
      <td><b>${o.price}</b> срібла/ніч</td><td>${esc(o.landlord)}</td>
      <td>${o.here ? `<button class="mini" data-rent="${o.area}" data-kind="${o.kind}" ${s.coins < o.price ? "disabled title='Перша ніч наперед'" : ""}>Винайняти</button>` : `<span class="muted">прийди туди</span>`}</td>
    </tr>`).join("");
  return `${curHtml}
    <h4>Можна винайняти</h4>
    ${offers.length ? `<table class="tbl"><tr><th>Де</th><th>Що</th><th>Ціна</th><th>Господар</th><th></th></tr>${rows}</table>` : `<div class="muted">${l ? "Зараз вільного житла немає." : "Завантаження…"}</div>`}
    ${ownHomes(s)}
    <p class="muted">Домовляються на місці: прийди в таверну чи до будинку й натисни «Винайняти» — перша ніч наперед, далі плата щовечора о 21:00. Цілий будинок — твій: можна ставити там меблі й працювати на своєму верстаку.
      NPC теж платять за ліжка своїм господарям; хто не платить, того виселяють у таверну.</p>`;
}

function renderChar() {
  const s = state.self;
  if (!s || $("panel-char").hidden) return;
  // don't wipe what the player is typing (price fields...)
  const f = document.activeElement;
  if (f && $("char-body").contains(f) && (f.tagName === "INPUT" || f.tagName === "SELECT")) return;
  $("char-title").textContent = `${s.name}${s.blessing ? " ✦" : ""}`;
  for (const b of $("panel-char").querySelectorAll<HTMLButtonElement>(".char-tabs button")) b.classList.toggle("sel", b.dataset.tab === charTab);
  $("char-body").innerHTML = charTab === "gear" ? gearTab(s) : charTab === "bag" ? bagTab(s) : charTab === "home" ? homeTab(s) : statsTab(s);
}

// ---------------------------------------------------------------------------
// Town politics (G)
// ---------------------------------------------------------------------------

let politics: PoliticsInfo | null = null;
const HOW: Record<PoliticsInfo["how"], string> = { founding: "давній староста", elected: "обраний", coup: "захопив владу силою" };

function meter(v: number, min: number, max: number, cls = "") {
  return `<span class="minibar ${cls}"><i style="width:${Math.round(((v - min) / (max - min)) * 100)}%"></i></span>`;
}

function renderPolitics(i: PoliticsInfo) {
  politics = i;
  // don't wipe a number the player is typing (the panel refreshes every few seconds)
  const focused = document.activeElement;
  if (focused && focused.tagName === "INPUT" && $("politics-body").contains(focused)) return;
  const here = i.atResidence;
  const lock = here ? "" : `disabled title="Це оформлюється в резиденції старости"`;
  const el = i.election;
  const elHtml = el ? `<h3 class="sect">${el.reason === "recall" ? "Дострокові вибори" : "Вибори старости"} · підрахунок ${fmtDayTime(el.endsAt)}</h3>
      <p class="muted">Числа — скільки людей зараз за кожного (NPC можуть передумати: агітація, подарунки, чутки).</p>
      ${el.candidates.map((c) => `<div class="kv"><span>${esc(c.name)}${c.id === i.reeve.id ? " <span class=\"muted\">(чинний)</span>" : ""}</span><span><b>${c.votes}</b></span>
        <span><button data-vote="${c.id}" ${lock} ${el.yourVote === c.id ? "class=\"sel\"" : ""}>${el.yourVote === c.id ? "Твій голос ✓" : "Голосувати"}</button></span></div>`).join("")}
      ${el.youRun ? `<p class="good">Ти кандидат. Агітуй: у розмові з людьми — «Голосуй за мене».</p>` : `<button data-pol="candidate" ${lock}>Висунутися кандидатом (25 срібла)</button>`}`
    : `<p>Наступні вибори: <b>${fmtDayTime(i.nextElection)}</b>.</p>
       <p>Петиція за відставку: <b>${i.petition.count}/${i.petition.needed}</b> підписів ${i.petition.signed ? "· <span class=\"muted\">твій підпис є</span>" : i.youAreReeve ? "" : `<button data-pol="sign" ${lock}>Підписати</button>`}
       <span class="muted">— переконуй людей у розмовах («Підпиши петицію…»).</span></p>`;
  const reeveHtml = i.youAreReeve ? `<h3 class="sect">Ти староста</h3>
      ${here ? "" : `<p class="muted">Укази підписуються в резиденції.</p>`}
      <div class="kv"><span>Податок на виручку справ</span><span>${i.taxSteps.map((t) => `<button data-tax="${t}" ${lock} ${Math.abs(t - i.taxRate) < 0.001 ? "class=\"sel\"" : ""}>${Math.round(t * 100)}%</button>`).join(" ")}</span></div>
      <p class="muted">Податок наповнює скарбницю (будинки, ліхтарі, платня варті), але власники справ тобі цього не пробачають.</p>
      ${(i.townBiz ?? []).map((b) => `<div class="kv"><span>${esc(b.name)} <span class="muted">${b.workers}/${b.maxWorkers}</span></span>
        <span><input type="number" min="1" max="50" value="${b.wage}" id="tw-${b.id}"><button data-twage="${b.id}" ${lock}>Платня</button>
        ${b.privatisable ? `<input type="number" min="0" value="${b.forSale ?? Math.round(b.value * 1.5)}" id="ts-${b.id}"><button data-tsale="${b.id}" ${lock}>${b.forSale ? `Продається за ${b.forSale} · змінити` : "Виставити на продаж"}</button>${b.forSale ? `<button data-tunsale="${b.id}" ${lock}>Зняти</button>` : ""}` : ""}</span></div>`).join("")}
      ${(i.prisoners ?? []).length ? `<div class="kv"><span>В'язні</span><span>${i.prisoners!.map((x) => `${esc(x.name)} <button data-pardon="${x.id}" ${lock}>Помилувати</button>`).join(" ")}</span></div>` : ""}
      <div class="kv"><span class="bad">Скарбниця — твоя?</span><span><input type="number" min="1" max="60" value="20" id="emb-amt"><button data-pol="embezzle" class="danger" ${lock}>Взяти собі</button></span></div>
      <p class="muted">Хто побачить — розкаже. А писар іноді перевіряє книги.</p>` : "";
  $("politics-body").innerHTML = `
    <div class="kv"><span>Староста</span><span><b>${esc(i.reeve.name)}</b> <span class="muted">· ${HOW[i.how]}${i.since ? ` · при владі від: ${fmtDayTime(i.since)}` : ""}</span></span></div>
    <div class="kv"><span>Легітимність</span>${meter(i.legitimacy, 0, 100)}<span class="num">${i.legitimacy}</span></div>
    <div class="kv"><span>Підтримка городян</span>${meter(i.approval, -100, 100)}<span class="num">${i.approval > 0 ? "+" : ""}${i.approval}</span></div>
    <div class="kv"><span>Скарбниця</span><span>${i.treasury} срібла · податок ${Math.round(i.taxRate * 100)}%</span></div>
    ${!i.youAreReeve ? `<div class="kv"><span>Варта на твоєму боці</span><span>${i.plot.sworn} з ${i.plot.guards} ${i.plot.sworn * 2 > i.plot.guards ? "· <b class=\"good\">досить для перевороту</b> (вимагай влади в розмові зі старостою)" : ""}</span></div>` : ""}
    ${here ? "" : `<p class="muted">Підписи, кандидатуру, голос і пожертви оформлюють у резиденції старости — кнопки оживуть, коли ти будеш там.</p>`}
    ${elHtml}
    ${reeveHtml}
    <div class="kv"><span>Пожертвувати громаді</span><span><input type="number" min="5" value="20" id="don-amt"><button data-pol="donate" ${lock}>Пожертвувати</button></span></div>
    <h3 class="sect">Політична хроніка</h3>
    ${i.history.map((h) => `<div class="line"><span class="muted">${fmtDayTime(h.t)}</span> ${esc(h.text)}</div>`).join("") || `<div class="muted">Поки тихо.</div>`}`;
  const body = $("politics-body");
  const send = (op: string, extra: Record<string, unknown> = {}) => net.send({ t: "politics", op: op as never, ...extra });
  body.querySelectorAll<HTMLButtonElement>("[data-vote]").forEach((b) => b.onclick = () => send("vote", { target: b.dataset.vote }));
  body.querySelectorAll<HTMLButtonElement>("[data-tax]").forEach((b) => b.onclick = () => send("setTax", { amount: Number(b.dataset.tax) }));
  body.querySelectorAll<HTMLButtonElement>("[data-twage]").forEach((b) => b.onclick = () => send("setWage", { bizId: b.dataset.twage, amount: Number(($(`tw-${b.dataset.twage}`) as HTMLInputElement).value) }));
  body.querySelectorAll<HTMLButtonElement>("[data-tsale]").forEach((b) => b.onclick = () => send("forSale", { bizId: b.dataset.tsale, amount: Number(($(`ts-${b.dataset.tsale}`) as HTMLInputElement).value) }));
  body.querySelectorAll<HTMLButtonElement>("[data-tunsale]").forEach((b) => b.onclick = () => send("forSale", { bizId: b.dataset.tunsale, amount: 0 }));
  body.querySelectorAll<HTMLButtonElement>("[data-pardon]").forEach((b) => b.onclick = () => send("pardon", { target: b.dataset.pardon }));
  body.querySelectorAll<HTMLButtonElement>("[data-pol]").forEach((b) => b.onclick = () => {
    const op = b.dataset.pol!;
    if (op === "donate") send(op, { amount: Number(($("don-amt") as HTMLInputElement).value) });
    else if (op === "embezzle") send(op, { amount: Number(($("emb-amt") as HTMLInputElement).value) });
    else send(op);
  });
}

function openPolitics() {
  togglePanel("panel-politics", () => net.send({ t: "politics", op: "info" }));
}

// ---------------------------------------------------------------------------
// Crafting (C) & building
// ---------------------------------------------------------------------------

const STATION_ORDER: Station[] = ["hand", "workbench", "forge", "anvil", "hearth"];
const STATION_TITLES: Record<Station, string> = {
  hand: "Руками — будь-де", workbench: "На верстаку", forge: "У горні", anvil: "На ковадлі", hearth: "На вогнищі",
};
const STATION_WHERE: Record<Station, string> = {
  hand: "", workbench: "верстак є у Складі (або зроби свій)", forge: "горно — у кузні Ульфа", anvil: "ковадло — у кузні Ульфа", hearth: "вогнище — у таверні (або склади своє)",
};

function renderCraft() {
  const s = state.self;
  if (!s) return;
  const inv = s.inv;
  const html = STATION_ORDER.map((st) => {
    const near = nearStation(map, state.myPos.x, state.myPos.y, st);
    // someone else's workshop: the owner's fee per item
    const ws = near ? s.workshops?.find((x) => x.station === st) : undefined;
    const fee = ws && !ws.free ? ws.fee : 0;
    const rows = RECIPES.filter((r) => r.station === st).map((r) => {
      const ins = (Object.entries(r.inputs) as [ItemId, number][]).map(([i, n]) => {
        const have = inv[i] ?? 0;
        return `<span class="${have < n ? "lack" : ""}">${ITEMS[i].name} ${have}/${n}</span>`;
      }).join("");
      const can = near && s.coins >= fee && (Object.entries(r.inputs) as [ItemId, number][]).every(([i, n]) => (inv[i] ?? 0) >= n);
      const secs = Math.round(craftMinutes(r, s.skills[r.skill]) * 0.4);
      return `<div class="recipe ${can ? "" : "off"}">
        <div><b>${ITEMS[r.out].name}</b>${r.qty > 1 ? ` ×${r.qty}` : ""} <span class="muted">· ${secs} с</span></div>
        <div class="in">${ins}</div>
        <div class="btns"><button data-craft="${r.id}" data-n="1" ${can ? "" : "disabled"}>Зробити</button><button data-craft="${r.id}" data-n="5" ${can ? "" : "disabled"}>×5</button></div>
      </div>`;
    }).join("");
    const feeTxt = ws ? (ws.free ? ` · ${esc(ws.label)}: для тебе безкоштовно` : fee > 0 ? ` · <span class="${s.coins < fee ? "bad" : "fee"}">${esc(ws.label)}: плата ${fee} срібла за виріб (${esc(ws.owner)})</span>` : ` · ${esc(ws.label)}: безкоштовно`) : "";
    const where = st === "hand" ? "" : near ? ` <span class="muted">· ти поруч ✓${feeTxt}</span>` : ` <span class="muted">· ${STATION_WHERE[st]}</span>`;
    return `<div class="craft-group">${STATION_TITLES[st]}${where}</div>${rows}`;
  }).join("");
  $("craft-body").innerHTML = `${html}<p class="muted">Матеріали — збором (F) або на ринку (M). Зроблене з позначкою в сумці можна поставити: клікни на нього. X — розібрати річ поруч.
    Навичка ремесла (теслярство, ковальство, кравецтво, будівництво, кулінарія) пришвидшує роботу. Одяг і зброю вдягають у вікні «Персонаж» (I).
    Працювати в чужій майстерні (кузня, таверна, склад, чужий дім) — за плату власнику за кожен виріб; ціну встановлює власник. Свої працівники, мешканці й надворі — безкоштовно.</p>`;
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

function renderArg(d: DialogMsg, opt: string, arg: "person" | "wage" | "text" | "buy" | "amount") {
  const box = $("dlg-arg");
  if (arg === "amount") {
    const label = opt === "borrow" ? "Сума позики (0 — спитати умови)" : opt === "repay" ? "Скільки віддати (0 — усе)" : "Хабар (можна 0)";
    box.innerHTML = `<label>${label} <input id="arg-amount" type="number" min="0" value="0"></label><button id="arg-go">Сказати</button>
      <span class="muted">У тебе ${state.self?.coins ?? 0} срібла</span>`;
    $("arg-go").onclick = () => net.send({ t: "talk", npcId: d.npcId, opt, price: Number(($("arg-amount") as HTMLInputElement).value) });
    return;
  }
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

/** Owner: sell or take what's piled up in the warehouse; lumber camps can saw planks. */
function stockControls(b: BusinessInfo): string {
  const rows = (b.outlets ?? []).map((o) => `<div class="stock-row">
      <b>${esc(o.name)}: ${o.qty}</b>
      <span class="muted">ринок ${o.marketPrice}/шт, візьме ще ${o.marketRoom} · оптовики ${o.wholesalePrice}/шт, візьмуть ще ${o.wholesaleLeft} сьогодні</span>
      <span class="btns"><input type="number" min="1" value="${o.qty}" id="sq-${b.id}-${o.item}">
        <button data-sell="${b.id}" data-item="${o.item}" data-to="market" ${o.marketRoom ? "" : "disabled"}>На ринок</button>
        <button data-sell="${b.id}" data-item="${o.item}" data-to="caravan" ${o.wholesaleLeft ? "" : "disabled"}>Оптовикам</button>
        <button data-take="${b.id}" data-item="${o.item}" title="Прийди на свою справу">Забрати собі</button></span>
    </div>`).join("");
  const proc = b.process === null || b.process === undefined ? "" :
    `<label class="chk"><input type="checkbox" data-process="${b.id}" ${b.process ? "checked" : ""}> Різати деревину на дошки й продавати дошки (дорожчі, інший ринок)</label>`;
  return `<div class="stock">${rows || `<div class="muted">Склад порожній.</div>`}${proc}</div>`;
}

/** Owner's books: the last few days of the business. */
function ledgerTable(b: BusinessInfo): string {
  const rows = (b.ledger ?? []).slice().reverse();
  if (!rows.length) return `<div class="biz-r muted">Журнал: ще немає записів (перший підсумок — о 18:00).</div>`;
  const extra = rows.some((d) => d.rent || d.fees);
  return `<table class="ledger"><tr><th>День</th><th>Вироблено</th><th>Продано</th><th>Виручка</th>${extra ? "<th>Оренда / майстерня</th>" : ""}<th>Платня</th><th>Невиплати</th></tr>` +
    rows.map((d) => `<tr><td>${d.day}</td><td>${Math.floor(d.made)}</td><td>${d.sold}</td><td>${d.revenue}</td>${extra ? `<td>${d.rent ?? 0} / ${d.fees ?? 0}</td>` : ""}<td>${d.wages}</td><td class="${d.unpaid ? "bad" : ""}">${d.unpaid || "—"}</td></tr>`).join("") +
    `</table>`;
}

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
      ${b.craftFee !== null || b.bedRent !== undefined ? `<div class="biz-r">${b.craftFee !== null ? `Майстерня для сторонніх: <b>${b.craftFee}</b> срібла за виріб` : ""}${b.bedRent !== undefined ? ` · Ліжко: <b>${b.bedRent}</b> срібла за ніч` : ""}
        ${b.canSetFees ? `<span class="fees">${b.craftFee !== null ? `<label>за виріб <input type="number" min="0" max="30" value="${b.craftFee}" id="fee-${b.id}"></label><button class="mini" data-fee="${b.id}">Встановити</button>` : ""}
          ${b.bedRent !== undefined ? `<label>ліжко/ніч <input type="number" min="1" max="30" value="${b.bedRent}" id="bed-${b.id}"></label><button class="mini" data-bed="${b.id}">Встановити</button>` : ""}</span>` : ""}</div>` : ""}
      ${mine ? ledgerTable(b) : ""}
      ${mine ? stockControls(b) : ""}
      ${mine ? `<div class="biz-own">
        <label class="chk"><input type="checkbox" data-autopay="${b.id}" ${b.autoPay !== false ? "checked" : ""}> Якщо в касі бракує на платню — доплачувати з мого гаманця (і коли я офлайн)</label>
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
  body.querySelectorAll<HTMLButtonElement>("[data-sell]").forEach((x) => x.onclick = () => net.send({
    t: "biz", op: "sellStock", bizId: x.dataset.sell, item: x.dataset.item as ItemId, to: x.dataset.to as "market" | "caravan",
    amount: Number(($(`sq-${x.dataset.sell}-${x.dataset.item}`) as HTMLInputElement).value) }));
  body.querySelectorAll<HTMLButtonElement>("[data-take]").forEach((x) => x.onclick = () => net.send({
    t: "biz", op: "takeStock", bizId: x.dataset.take, item: x.dataset.item as ItemId,
    amount: Number(($(`sq-${x.dataset.take}-${x.dataset.item}`) as HTMLInputElement).value) }));
  body.querySelectorAll<HTMLInputElement>("[data-process]").forEach((c) => c.onchange = () => net.send({ t: "biz", op: "process", bizId: c.dataset.process, amount: c.checked ? 1 : 0 }));
  body.querySelectorAll<HTMLInputElement>("[data-autopay]").forEach((c) => c.onchange = () => net.send({ t: "biz", op: "autoPay", bizId: c.dataset.autopay, amount: c.checked ? 1 : 0 }));
  body.querySelectorAll<HTMLButtonElement>("[data-fee]").forEach((b) => b.onclick = () => net.send({ t: "biz", op: "craftFee", bizId: b.dataset.fee, amount: Number(($(`fee-${b.dataset.fee}`) as HTMLInputElement).value) }));
  body.querySelectorAll<HTMLButtonElement>("[data-bed]").forEach((b) => b.onclick = () => net.send({ t: "biz", op: "bedRent", bizId: b.dataset.bed, amount: Number(($(`bed-${b.dataset.bed}`) as HTMLInputElement).value) }));
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
    ${i.gear?.length ? `<h4>Спорядження</h4>${i.gear.map((g) => `<div>• ${esc(g)}</div>`).join("")}` : ""}
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
      case "self": state.self = m.s; renderSelf(m.s); renderChar(); if (!$("panel-craft").hidden) renderCraft(); if (!$("panel-market").hidden && market) renderMarket(market); break;
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
      case "politics": renderPolitics(m.info); break;
      case "char": charInfo = m.info; renderChar(); break;
      case "lodging": lodging = m.info; renderChar(); break;
      case "inbox": {
        chatLine(`<b>Поки тебе не було:</b>`, "away");
        for (const it of m.items) chatLine(`<span class="muted">${fmtDayTime(it.t)}</span> <span class="${it.kind === "bad" ? "bad" : it.kind === "good" ? "good" : ""}">${esc(it.text)}</span>`, "away");
        toast(`Поки тебе не було: ${m.items.length} повідомл. — дивись у чаті.`, "info");
        break;
      }
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
  for (const id of PANELS) makeDraggable($(id));
  window.addEventListener("resize", () => { for (const id of PANELS) if (!$(id).hidden) clampPanel($(id)); });

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
      case "i": case "ш": openChar(); break;
      case "o": case "щ": $("panel-inspect").hidden ? openInspect(state.selectedId) : closePanel("panel-inspect"); break;
      case "h": case "р": togglePanel("panel-help"); break;
      case "j": case "о": togglePanel("panel-talklog", renderTalklog); break;
      case "k": case "л": if (!$("panel-char").hidden && charTab === "stats") closePanel("panel-char"); else openChar("stats"); break;
      case "c": case "с": togglePanel("panel-craft", renderCraft); break;
      case "g": case "п": openPolitics(); break;
      case "x": case "ч": net.send({ t: "pickup" }); break;
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
  $("btn-craft").onclick = () => togglePanel("panel-craft", renderCraft);
  $("btn-politics").onclick = openPolitics;
  // live numbers while the panel is open (votes move, petitions fill up)
  setInterval(() => { if (!$("panel-politics").hidden) net.send({ t: "politics", op: "info" }); }, 3000);
  $("btn-pickup").onclick = () => net.send({ t: "pickup" });
  $("craft-body").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button[data-craft]") as HTMLButtonElement | null;
    if (b) net.send({ t: "craft", recipe: b.dataset.craft!, n: Number(b.dataset.n) });
  });
  $("inventory").addEventListener("click", (e) => {
    const eq = (e.target as HTMLElement).closest("[data-equip]") as HTMLElement | null;
    if (eq) { net.send({ t: "equip", item: eq.dataset.equip as ItemId }); return; }
    const chip = (e.target as HTMLElement).closest("[data-place]") as HTMLElement | null;
    if (!chip) return;
    closePanel("panel-craft");
    bus.emit("build", chip.dataset.place as ItemId);
  });
  bus.on("buildHint", (text: string | null) => { $("build-hint").hidden = !text; $("build-hint").innerHTML = text ?? ""; });
  // station proximity changes as we walk
  let stationSig = "";
  setInterval(() => {
    if ($("panel-craft").hidden) return;
    const sig = STATION_ORDER.map((st) => (nearStation(map, state.myPos.x, state.myPos.y, st) ? 1 : 0)).join("");
    if (sig !== stationSig) { stationSig = sig; renderCraft(); }
  }, 500);
  $("btn-talklog").onclick = () => togglePanel("panel-talklog", renderTalklog);
  $("btn-char").onclick = () => openChar();
  for (const b of $("panel-char").querySelectorAll<HTMLButtonElement>(".char-tabs button")) b.onclick = () => openChar(b.dataset.tab as CharTab);
  $("char-body").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const eq = t.closest("[data-equip]") as HTMLElement | null;
    if (eq) return net.send({ t: "equip", item: eq.dataset.equip as ItemId });
    const rp = t.closest("[data-repair]") as HTMLElement | null;
    if (rp) return net.send({ t: "repair", slot: rp.dataset.repair as Slot });
    const ds = t.closest("[data-discard-slot]") as HTMLElement | null;
    if (ds) return net.send({ t: "discard", slot: ds.dataset.discardSlot as Slot });
    const di = t.closest("[data-discard-item]") as HTMLElement | null;
    if (di) return net.send({ t: "discard", item: di.dataset.discardItem as ItemId });
    const un = t.closest("[data-unequip]") as HTMLElement | null;
    if (un) return net.send({ t: "unequip", slot: un.dataset.unequip as Slot });
    const pl = t.closest("[data-place]") as HTMLElement | null;
    if (pl) { closePanel("panel-char"); bus.emit("build", pl.dataset.place as ItemId); return; }
    if (t.closest("[data-eat]")) net.send({ t: "act", a: "eat" });
    const rent = t.closest("[data-rent]") as HTMLElement | null;
    if (rent) return net.send({ t: "lodging", op: "rent", area: rent.dataset.rent, kind: rent.dataset.kind as "bed" | "house" });
    if (t.closest("[data-leave]")) net.send({ t: "lodging", op: "leave" });
    const lt = t.closest("[data-letting]") as HTMLElement | null;
    if (lt) {
      const a = lt.dataset.letting!;
      return net.send({ t: "lodging", op: "letting", area: a, on: ($(`let-${a}`) as HTMLInputElement).checked, amount: Number(($(`letp-${a}`) as HTMLInputElement).value) });
    }
    const ch = t.closest("[data-commission-house]") as HTMLElement | null;
    if (ch) { net.send({ t: "biz", op: "commission", plotId: ch.dataset.commissionHouse }); setTimeout(() => net.send({ t: "lodging", op: "info" }), 400); }
  });

  chatLine(`<span class="muted">Ласкаво просимо до Каргата. Натисни <b>H</b> — довідка. <b>Enter</b> — чат з іншими гравцями.</span>`);
}
