// Rutzarg item editor — entry point: toolbar, panes, server import/export, files, shortcuts.

import type { GameData, Problem } from "../../../shared/gamedata.ts";
import type { ItemDef } from "../../../shared/items.ts";
import { $, download, esc } from "./dom.ts";
import { BUILTIN, canRedo, canUndo, cloneData, doRedo, doUndo, edit, emit, isNewItem, item, load, log, onChange, restoreDraft, select, state, type View } from "./model.ts";
import { initOutline, renderOutline } from "./outline.ts";
import { initInspector, renderInspector } from "./inspector.ts";
import { renderDiff, renderGather, renderGraph, renderTable } from "./views.ts";

let bottom: "problems" | "log" = "problems";

function status(text: string, kind: "info" | "good" | "bad" = "info") {
  const el = $("tb-status");
  el.textContent = text;
  el.className = kind === "info" ? "muted" : kind;
  el.title = text;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  renderOutline();
  renderInspector();
  renderView();
  renderBottom();
  $<HTMLButtonElement>("tb-undo").disabled = !canUndo();
  $<HTMLButtonElement>("tb-redo").disabled = !canRedo();
  $<HTMLButtonElement>("tb-del").disabled = !state.selected || !isNewItem(state.selected);
  $<HTMLButtonElement>("tb-dup").disabled = !state.selected;
}

function renderView() {
  for (const b of $("center-tabs").querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("sel", b.dataset.view === state.view);
  if (state.view === "graph") renderGraph();
  else if (state.view === "table") renderTable();
  else if (state.view === "gather") renderGather();
  else renderDiff();
}

function renderBottom() {
  const errs = state.problems.filter((p) => p.level === "error").length;
  const warns = state.problems.length - errs;
  $("problems-count").innerHTML = `${errs ? `<span class="n">${errs}</span>` : ""}${warns ? `<span class="w">${warns}</span>` : ""}`;
  for (const b of $("bottom-tabs").querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("sel", b.dataset.bottom === bottom);
  const body = $("bottom-body");
  if (bottom === "problems") {
    body.innerHTML = state.problems.length
      ? state.problems.map((p: Problem) => `<div class="prob" data-where="${esc(p.where)}"><span class="lv ${p.level === "error" ? "bad" : "warn"}">${p.level === "error" ? "✖" : "▲"}</span><span class="wh">${esc(p.where)}</span><span>${esc(p.text)}</span></div>`).join("")
      : `<div class="logline good">Проблем немає — дані можна застосувати в грі.</div>`;
  } else {
    body.innerHTML = state.log.slice().reverse().map((l) => `<div class="logline ${l.kind === "info" ? "" : l.kind}">${esc(l.t)}  ${esc(l.text)}</div>`).join("");
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** The editor talks only to the server it was loaded from (session cookie, no CORS). */
const online = location.protocol.startsWith("http");

/** Session over (or never started) → back to the sign-in page. */
function signedOut(r: Response): boolean {
  if (r.status !== 401) return false;
  status("Сесія завершилась — увійди знову", "bad");
  setTimeout(() => location.assign("/editor/login.html"), 800);
  return true;
}

async function importFromGame() {
  if (!online) { status("Редактор відкрито як файл: обмін з грою недоступний, працюють JSON-файли", "bad"); return; }
  status("Завантаження з гри…");
  try {
    const r = await fetch("/api/gamedata", { cache: "no-store" });
    if (signedOut(r)) return;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = (await r.json()) as GameData;
    load(d, `Завантажено з гри: ${d.items.length} речей, ${d.recipes.length} рецептів`, true);
    status(`З гри: ${d.items.length} речей · ${new Date().toLocaleTimeString()}`, "good");
  } catch (e) {
    status(`Не вдалося: ${(e as Error).message}`, "bad");
    log(`Помилка завантаження з гри: ${(e as Error).message}`, "bad");
    renderBottom();
  }
}

async function applyToGame() {
  const errs = state.problems.filter((p) => p.level === "error");
  if (errs.length) { bottom = "problems"; renderBottom(); status(`Спершу виправ помилки (${errs.length})`, "bad"); return; }
  if (!online) { status("Редактор відкрито як файл: збережи JSON і застосуй з редактора на сервері", "bad"); return; }
  if (!confirm("Застосувати ці речі й рецепти в запущеній грі? Гравці отримають зміни одразу, файл data/game-data.json буде перезаписано.")) return;
  status("Застосування…");
  try {
    const r = await fetch("/api/gamedata", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rutzarg-editor": "1" },
      body: JSON.stringify(state.data),
    });
    if (signedOut(r)) return;
    const body = (await r.json().catch(() => ({}))) as { error?: string; added?: string[]; problems?: Problem[] };
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    log(`Застосовано в грі${body.added?.length ? `, нові речі: ${body.added.join(", ")}` : ""}`, "good");
    status(`Застосовано в грі · ${new Date().toLocaleTimeString()}`, "good");
    await importFromGame();
  } catch (e) {
    status(`Не застосовано: ${(e as Error).message}`, "bad");
    log(`Не застосовано: ${(e as Error).message}`, "bad");
    renderBottom();
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function newItem(from?: ItemDef) {
  let n = 1;
  const base = from ? from.id.replace(/_\d+$/, "") : "new_item";
  while (item(`${base}_${n}`)) n++;
  const id = `${base}_${n}`;
  const def: ItemDef = from ? { ...cloneData(from), id: id as ItemDef["id"], name: `${from.name} (копія)` } : { id: id as ItemDef["id"], name: "Нова річ", basePrice: 5, targetStock: 10, dailyExport: 2, color: "#8a7a6a", group: "material" };
  def.id = id as ItemDef["id"];
  edit(from ? `Дублікат ${from.id} → ${id}` : `Нова річ ${id}`, (d) => {
    d.items.push(def);
    const rec = from ? d.recipes.find((r) => r.out === from.id) : undefined;
    if (rec) d.recipes.push({ ...cloneData(rec), id, out: id as ItemDef["id"] });
  });
  select(id);
}

function deleteItem() {
  const id = state.selected;
  if (!id || !isNewItem(id)) return;
  const users = state.data.recipes.filter((r) => id in r.inputs).map((r) => r.out);
  if (users.length && !confirm(`«${id}» використовується в рецептах: ${users.join(", ")}. Прибрати звідти теж?`)) return;
  edit(`Видалено ${id}`, (d) => {
    d.items = d.items.filter((x) => x.id !== id);
    d.recipes = d.recipes.filter((r) => r.out !== id);
    for (const r of d.recipes) delete (r.inputs as Record<string, number>)[id];
    const gt = d.gatherTools as Record<string, string[]>;
    delete gt[id];
    for (const k of Object.keys(gt)) gt[k] = gt[k].filter((t) => t !== id);
    for (const k of Object.keys(d.jobTools)) if (d.jobTools[k] === id) delete d.jobTools[k];
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function whoAmI() {
  if (!online) { $("tb-who").textContent = "офлайн (файл)"; return; }
  const r = await fetch("/api/editor/me", { cache: "no-store" }).catch(() => null);
  if (!r || signedOut(r)) return;
  const me = (await r.json()) as { who: string; login: boolean };
  $("tb-who").textContent = me.who;
  $("tb-logout").hidden = !me.login;
}

function init() {
  void whoAmI();
  $("tb-logout").onclick = async () => {
    await fetch("/api/editor/logout", { method: "POST" }).catch(() => null);
    location.assign("/editor/login.html");
  };
  $("tb-import").onclick = importFromGame;
  $("tb-apply").onclick = applyToGame;
  $("tb-open").onclick = () => $("file-input").click();
  $<HTMLInputElement>("file-input").onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try { load(JSON.parse(await f.text()) as GameData, `Відкрито файл ${f.name}`); }
    catch (err) { log(`Не вдалося відкрити ${f.name}: ${(err as Error).message}`, "bad"); renderBottom(); }
    (e.target as HTMLInputElement).value = "";
  };
  $("tb-save").onclick = () => {
    download(`rutzarg-gamedata-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ ...state.data, exportedAt: new Date().toISOString(), source: "item-editor" }, null, 2));
    log("Збережено у файл");
    renderBottom();
  };
  $("tb-builtin").onclick = () => { if (confirm("Скинути редактор до вбудованих значень коду гри?")) load(BUILTIN, "Скинуто до вбудованих значень"); };
  $("tb-undo").onclick = doUndo;
  $("tb-redo").onclick = doRedo;
  $("tb-new").onclick = () => newItem();
  $("tb-dup").onclick = () => { const it = state.selected ? item(state.selected) : undefined; if (it) newItem(it); };
  $("tb-del").onclick = deleteItem;
  const skill = $<HTMLInputElement>("tb-skill");
  skill.oninput = () => { state.skill = Number(skill.value); $("tb-skill-v").textContent = skill.value; renderInspector(); renderView(); };
  for (const b of $("center-tabs").querySelectorAll<HTMLButtonElement>("button")) b.onclick = () => { state.view = b.dataset.view as View; renderView(); };
  for (const b of $("bottom-tabs").querySelectorAll<HTMLButtonElement>("button")) b.onclick = () => { bottom = b.dataset.bottom as "problems" | "log"; renderBottom(); };
  $("bottom-body").addEventListener("click", (e) => {
    const p = (e.target as HTMLElement).closest(".prob") as HTMLElement | null;
    const m = p?.dataset.where?.match(/«([^»]+)»/);
    if (m && item(m[1])) select(m[1]);
    else if (m) { const r = state.data.recipes.find((x) => x.id === m[1]); if (r) select(r.out); }
  });
  window.addEventListener("keydown", (e) => {
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && tag !== "INPUT") { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); $("tb-save").click(); }
  });
  window.addEventListener("resize", () => { if (state.view === "graph") renderGraph(); });

  initOutline();
  initInspector();
  onChange(render);
  const restored = restoreDraft();
  emit();
  if (restored) log("Відновлено незбережену чернетку з цього браузера");
  // opened from the game server → take what the game runs with
  if (online && !restored) void importFromGame();
  else status(restored ? "Чернетка відновлена. «З гри» — щоб узяти поточні дані гри." : "Вбудовані значення. «З гри» — щоб узяти поточні дані.");
}

init();
