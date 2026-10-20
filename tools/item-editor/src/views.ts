// Center views: crafting graph (scene-like canvas with pan/zoom), economy table, gathering & tools, diff with the game.

import { $, esc, options } from "./dom.ts";
import { edit, isModified, isNewItem, item, itemName, recipeOf, select, state, usedIn } from "./model.ts";
import { fmt, gatherEcon, gatherTools, recipeEcon, sellPrice, toolBonus } from "./economy.ts";

// ---------------------------------------------------------------------------
// Crafting graph
// ---------------------------------------------------------------------------

const NW = 184, NH = 58, GX = 250, GY = 74;
const view = { x: 0, y: 0, k: 1, fitFor: "" };

interface GNode { id: string; col: number; row: number }

function layout(sel: string) {
  // upstream: everything that goes into the item (column = -depth, deepest wins so edges flow left→right)
  const depth = new Map<string, number>([[sel, 0]]);
  const up = (id: string, d: number, path: Set<string>) => {
    const rec = recipeOf(id);
    if (!rec || path.has(id)) return;
    const next = new Set(path); next.add(id);
    for (const i of [...Object.keys(rec.inputs), ...(rec.tools ?? [])]) {
      if (i === sel) continue;
      if ((depth.get(i) ?? -1) < d + 1) depth.set(i, d + 1);
      up(i, d + 1, next);
    }
  };
  up(sel, 0, new Set());
  // downstream: what it is used in (two levels)
  const down = new Map<string, number>();
  for (const r of usedIn(sel)) if (!depth.has(r.out)) down.set(r.out, 1);
  // a second level only while it stays readable
  if (down.size <= 5) for (const [id] of [...down]) for (const r of usedIn(id)) if (!depth.has(r.out) && !down.has(r.out)) down.set(r.out, 2);
  const cols = new Map<number, string[]>();
  for (const [id, d] of depth) { const c = -d; cols.set(c, [...(cols.get(c) ?? []), id]); }
  for (const [id, d] of down) cols.set(d, [...(cols.get(d) ?? []), id]);
  const nodes: GNode[] = [];
  for (const [c, ids] of cols) {
    ids.sort((a, b) => itemName(a).localeCompare(itemName(b), "uk"));
    ids.forEach((id, i) => nodes.push({ id, col: c, row: i - (ids.length - 1) / 2 }));
  }
  const pos = new Map(nodes.map((n) => [n.id, { x: n.col * GX, y: n.row * GY }]));
  const edges: { from: string; to: string; qty: number; down: boolean; tool?: boolean }[] = [];
  for (const id of depth.keys()) {
    const rec = recipeOf(id);
    if (!rec) continue;
    for (const [i, q] of Object.entries(rec.inputs)) if (pos.has(i)) edges.push({ from: i, to: id, qty: q ?? 0, down: false });
    for (const t of rec.tools ?? []) if (pos.has(t)) edges.push({ from: t, to: id, qty: 0, down: false, tool: true });
  }
  for (const id of down.keys()) {
    const rec = recipeOf(id)!;
    for (const [i, q] of Object.entries(rec.inputs)) if (pos.has(i) && (i === sel || down.has(i))) edges.push({ from: i, to: id, qty: q ?? 0, down: true });
  }
  return { nodes, pos, edges };
}

function nodeSvg(id: string, x: number, y: number, sel: boolean): string {
  const it = item(id);
  const rec = recipeOf(id);
  const station = rec ? state.ref.stations.find((s) => s.id === rec.station)?.name ?? rec.station : gatherTools(id).length ? `добування: ${gatherTools(id).map(itemName).join(", ")}` : "купується / справи";
  const flag = isNewItem(id) ? " · нова" : isModified(id) ? " · змін." : "";
  return `<g class="gnode ${sel ? "sel" : ""}" data-id="${esc(id)}" transform="translate(${x - NW / 2},${y - NH / 2})">
    <rect class="box" width="${NW}" height="${NH}" rx="4"></rect>
    <rect width="5" height="${NH}" fill="${esc(it?.color ?? "#555")}" rx="2"></rect>
    <text x="14" y="19">${esc(it?.name ?? id)}</text>
    <text class="sub" x="${NW - 10}" y="19" text-anchor="end">${it?.basePrice ?? "?"} ср.</text>
    <text class="sub" x="14" y="36">${esc(station.length > 30 ? `${station.slice(0, 29)}…` : station)}</text>
    <text class="sub" x="14" y="50">${rec ? `${rec.minutes} хв · ×${rec.qty}${rec.minSkill ? ` · навичка ≥${rec.minSkill}` : ""}` : esc(state.ref.groups.find((g) => g.id === it?.group)?.name ?? "")}${flag}</text>
  </g>`;
}

export function renderGraph() {
  const sel = state.selected;
  const el = $("view");
  if (!sel || !item(sel)) { el.innerHTML = `<div class="empty">Вибери річ.</div>`; return; }
  const { nodes, pos, edges } = layout(sel);
  if (view.fitFor !== sel) {
    const r = el.getBoundingClientRect();
    const xs = nodes.map((n) => n.col * GX), ys = nodes.map((n) => n.row * GY);
    const w = Math.max(...xs) - Math.min(...xs) + NW + 80, h = Math.max(...ys) - Math.min(...ys) + NH + 80;
    view.k = Math.max(0.35, Math.min(1.2, Math.min(r.width / w, r.height / h)));
    view.x = r.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * view.k;
    view.y = r.height / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * view.k;
    view.fitFor = sel;
  }
  const paths = edges.map((e) => {
    const a = pos.get(e.from)!, b = pos.get(e.to)!;
    const x1 = a.x + NW / 2, y1 = a.y, x2 = b.x - NW / 2, y2 = b.y, mx = (x1 + x2) / 2;
    return `<path class="gedge ${e.down ? "out" : ""} ${e.tool ? "tool" : ""}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" marker-end="url(#arr)"></path>
      <text class="glabel" x="${x2 - 22}" y="${y2 - 6}">${e.tool ? "⚒" : `×${e.qty}`}</text>`;
  }).join("");
  el.innerHTML = `<div class="graph-wrap" id="graph">
    <svg><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#6a7080"></path></marker></defs>
      <g id="graph-root" transform="translate(${view.x},${view.y}) scale(${view.k})">${paths}${nodes.map((n) => nodeSvg(n.id, pos.get(n.id)!.x, pos.get(n.id)!.y, n.id === sel)).join("")}</g></svg>
    <div class="graph-tools"><button class="mini" id="graph-fit" title="Вмістити">⤢</button></div>
    <div class="graph-legend">← компоненти (⚒ пунктир — інструмент) · <b>${esc(itemName(sel))}</b> · де використовується → &nbsp;|&nbsp; колесо — масштаб, тягни — рух, клік — вибрати</div>
  </div>`;
  bindGraph();
}

function bindGraph() {
  const wrap = $("graph");
  const root = $("graph-root") as unknown as SVGGElement;
  const apply = () => root.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
  let drag: { x: number; y: number; moved: boolean } | null = null;
  wrap.onpointerdown = (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; wrap.setPointerCapture(e.pointerId); };
  wrap.onpointermove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; wrap.classList.add("dragging"); }
    if (drag.moved) { view.x += dx; view.y += dy; drag.x = e.clientX; drag.y = e.clientY; apply(); }
  };
  wrap.onpointerup = (e) => {
    const was = drag;
    drag = null;
    wrap.classList.remove("dragging");
    if (was && !was.moved) {
      // pointer capture retargets events to the wrapper — find the node under the cursor
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest(".gnode") as SVGGElement | null;
      if (hit?.dataset.id && hit.dataset.id !== state.selected) select(hit.dataset.id);
    }
  };
  wrap.onwheel = (e) => {
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const k2 = Math.max(0.25, Math.min(2.5, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    view.x = cx - ((cx - view.x) * k2) / view.k;
    view.y = cy - ((cy - view.y) * k2) / view.k;
    view.k = k2;
    apply();
  };
  $("graph-fit").onpointerdown = (e) => e.stopPropagation();
  $("graph-fit").onclick = () => { view.fitFor = ""; renderGraph(); };
}

// ---------------------------------------------------------------------------
// Economy table: every recipe side by side
// ---------------------------------------------------------------------------

let sortKey = "perHour", sortAsc = false;

export function renderTable() {
  const rows = state.data.recipes.filter((r) => item(r.out)).map((r) => {
    const e = recipeEcon(r);
    return { id: r.out, name: itemName(r.out), station: state.ref.stations.find((s) => s.id === r.station)?.name ?? r.station,
      skill: state.ref.skills.find((s) => s.id === r.skill)?.name ?? r.skill, price: item(r.out)!.basePrice, qty: r.qty,
      req: [r.minSkill ? `≥${r.minSkill}` : "", ...(r.tools ?? []).map((t) => `⚒ ${itemName(t)}`)].filter(Boolean).join(" "), minSkill: r.minSkill ?? 0, locked: e.locked,
      inputCost: e.inputCost, outSell: e.outSell, trade: e.tradeProfit, minutes: e.minutes, perHour: e.perHour,
      scratch: e.scratchPerHour, raw: e.rawPerHour, arb: e.arbitrage };
  });
  const cols: [string, string, boolean][] = [
    ["name", "Річ", false], ["station", "Станція", false], ["skill", "Навичка", false], ["minSkill", "Вимоги", true], ["price", "Ціна", true], ["qty", "×", true],
    ["inputCost", "Компоненти", true], ["outSell", "Ринок платить", true], ["trade", "Прибуток (купив→продав)", true],
    ["minutes", "Хв", true], ["perHour", "Ремесло /год", true], ["scratch", "Усе сам /год", true], ["raw", "Сировина /год", true],
  ];
  rows.sort((a, b) => {
    const x = (a as Record<string, unknown>)[sortKey], y = (b as Record<string, unknown>)[sortKey];
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "uk");
    return sortAsc ? c : -c;
  });
  const arb = rows.filter((r) => r.arb).length;
  $("view").innerHTML = `<div class="view-pad">
    <div class="note">Навичка ${state.skill} (сірі рядки — на цьому рівні недоступні). «Купив→продав» — компоненти за базовою ціною й знос інструментів, результат за ціною, яку платить ринок. Позитивне значення — арбітраж: гравці зароблятимуть, не добуваючи нічого.
      «Усе сам» — добування сировини знаряддям, ремесло й продаж ринку. «Сировина» — якщо просто продати добуту сировину.</div>
    ${arb ? `<div class="callout" style="margin:6px 0">Арбітраж у ${arb} рецептах — підсвічено.</div>` : `<div class="callout good" style="margin:6px 0">Арбітражу немає: купувати компоненти й перепродавати результат ринку невигідно.</div>`}
    <table class="grid"><tr>${cols.map(([k, n]) => `<th data-sort="${k}" class="${sortKey === k ? `sorted ${sortAsc ? "asc" : ""}` : ""}">${n}</th>`).join("")}</tr>
    ${rows.map((r) => `<tr data-id="${esc(r.id)}" class="${r.id === state.selected ? "sel" : ""} ${r.locked ? "locked" : ""}" ${r.locked ? `title="Недоступно на рівні навички ${state.skill}"` : ""}>
      <td><span style="color:${esc(item(r.id)?.color)}">■</span> ${esc(r.name)}</td><td>${esc(r.station)}</td><td>${esc(r.skill)}</td><td class="${r.locked ? "bad" : ""}">${esc(r.req) || "—"}</td>
      <td class="num">${r.price}</td><td class="num">${r.qty}</td><td class="num">${fmt(r.inputCost, 0)}</td><td class="num">${r.outSell}</td>
      <td class="num ${r.arb ? "warn" : ""}">${r.trade > 0 ? "+" : ""}${fmt(r.trade, 0)}</td><td class="num">${fmt(r.minutes)}</td>
      <td class="num">${fmt(r.perHour)}</td><td class="num">${fmt(r.scratch)}</td><td class="num">${r.raw ? fmt(r.raw) : "—"}</td></tr>`).join("")}
    </table></div>`;
  for (const th of $("view").querySelectorAll<HTMLElement>("th[data-sort]")) th.onclick = () => {
    const k = th.dataset.sort!;
    if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = false; }
    renderTable();
  };
  for (const tr of $("view").querySelectorAll<HTMLElement>("tr[data-id]")) tr.onclick = () => select(tr.dataset.id!);
}

// ---------------------------------------------------------------------------
// Gathering & tools: what extracts what, how fast, and which tool each job needs
// ---------------------------------------------------------------------------

export function renderGather() {
  const raws = state.data.items.filter((x) => x.group === "raw" || gatherTools(x.id).length);
  const wear = state.data.items.filter((x) => x.group === "wear").map((x) => ({ id: x.id, name: x.name }));
  const tools = state.data.items.filter((x) => x.uses);
  $("view").innerHTML = `<div class="view-pad">
    <h3>Добування сировини (навичка ${state.skill})</h3>
    <table class="grid"><tr><th>Ресурс</th><th>Знаряддя</th><th>Хв/шт.</th><th>Шт./год</th><th>Ринок платить</th><th>Знос/шт.</th><th>Дохід/год</th></tr>
    ${raws.map((x) => {
      const g = gatherEcon(x.id);
      return `<tr data-id="${esc(x.id)}" class="${x.id === state.selected ? "sel" : ""}"><td><span style="color:${esc(x.color)}">■</span> ${esc(x.name)}</td>
        <td>${gatherTools(x.id).map((t) => `${esc(itemName(t))} <span class="muted">+${Math.round(toolBonus(t, x.id) * 100)}%</span>`).join(", ") || `<span class="muted">не добувається</span>`}</td>
        <td class="num">${g ? fmt(g.minutes, 2) : "—"}</td><td class="num">${g ? fmt(g.unitsPerHour) : "—"}</td><td class="num">${sellPrice(x.id)}</td>
        <td class="num">${g ? fmt(g.wearPerUnit, 2) : "—"}</td><td class="num">${g ? fmt(g.perHour) : "—"}</td></tr>`;
    }).join("")}</table>
    <h3>Знаряддя: міцність і вартість використання</h3>
    <table class="grid"><tr><th>Знаряддя</th><th>Ціна</th><th>Міцність</th><th>Ціна використання</th><th>Що добуває</th></tr>
    ${tools.map((t) => `<tr data-id="${esc(t.id)}"><td>${esc(t.name)}</td><td class="num">${t.basePrice}</td><td class="num">${t.uses}</td>
      <td class="num">${fmt(t.basePrice / (t.uses ?? 1), 2)}</td>
      <td>${Object.entries(t.stats?.gather ?? {}).map(([r, v]) => `${esc(itemName(r))} +${Math.round((v ?? 0) * 100)}%`).join(", ")}</td></tr>`).join("")}</table>
    <h3>Знаряддя для роботи на підприємствах</h3>
    <div class="note">Без цього знаряддя працівник справи не працює; справа купує його з каси.</div>
    <table class="grid"><tr><th>Вид справи</th><th>Знаряддя</th><th></th></tr>
    ${Object.entries(state.data.jobTools).map(([k, t]) => `<tr><td class="mono">${esc(k)}</td><td><select data-job="${esc(k)}">${options(wear, t)}</select></td><td><button class="mini danger" data-job-del="${esc(k)}">✕</button></td></tr>`).join("")}
    <tr><td><select id="job-new">${options(state.ref.businessKinds.filter((k) => !(k in state.data.jobTools)).map((k) => ({ id: k, name: k })), "", "＋ вид справи…")}</select></td><td></td><td></td></tr></table>
  </div>`;
  const v = $("view");
  for (const tr of v.querySelectorAll<HTMLElement>("tr[data-id]")) tr.onclick = () => select(tr.dataset.id!);
  for (const s of v.querySelectorAll<HTMLSelectElement>("select[data-job]")) s.onchange = () => edit(`робота ${s.dataset.job}: ${s.value}`, (d) => { (d.jobTools as Record<string, string>)[s.dataset.job!] = s.value; });
  for (const b of v.querySelectorAll<HTMLButtonElement>("[data-job-del]")) b.onclick = () => edit(`робота ${b.dataset.jobDel}: без знаряддя`, (d) => { delete (d.jobTools as Record<string, string>)[b.dataset.jobDel!]; });
  const nw = $<HTMLSelectElement>("job-new");
  nw.onchange = () => { if (nw.value) edit(`робота ${nw.value}: потрібне знаряддя`, (d) => { (d.jobTools as Record<string, string>)[nw.value] = wear[0]?.id ?? "axe"; }); };
}

// ---------------------------------------------------------------------------
// Diff with the game
// ---------------------------------------------------------------------------

export function renderDiff() {
  const g = state.game, d = state.data;
  const lines: string[] = [];
  const show = (v: unknown) => esc(JSON.stringify(v));
  for (const it of d.items) {
    const old = g.items.find((x) => x.id === it.id);
    if (!old) { lines.push(`<tr data-id="${esc(it.id)}"><td>${esc(it.name)}</td><td class="good">нова річ</td><td></td><td class="mono">${show({ ...it })}</td></tr>`); continue; }
    for (const k of new Set([...Object.keys(old), ...Object.keys(it)])) {
      const a = (old as unknown as Record<string, unknown>)[k], b = (it as unknown as Record<string, unknown>)[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) lines.push(`<tr data-id="${esc(it.id)}"><td>${esc(it.name)}</td><td>${esc(k)}</td><td class="mono bad">${show(a)}</td><td class="mono good">${show(b)}</td></tr>`);
    }
  }
  for (const r of d.recipes) {
    const old = g.recipes.find((x) => x.out === r.out);
    if (JSON.stringify(old ?? null) !== JSON.stringify(r)) lines.push(`<tr data-id="${esc(r.out)}"><td>${esc(itemName(r.out))}</td><td>рецепт</td><td class="mono bad">${show(old ?? "—")}</td><td class="mono good">${show(r)}</td></tr>`);
  }
  for (const r of g.recipes) if (!d.recipes.some((x) => x.out === r.out)) lines.push(`<tr data-id="${esc(r.out)}"><td>${esc(itemName(r.out))}</td><td>рецепт</td><td class="mono bad">${show(r)}</td><td class="good">прибрано</td></tr>`);
  for (const k of new Set([...Object.keys(g.gatherTools), ...Object.keys(d.gatherTools)])) {
    const a = (g.gatherTools as Record<string, unknown>)[k], b = (d.gatherTools as Record<string, unknown>)[k];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) lines.push(`<tr data-id="${esc(k)}"><td>${esc(itemName(k))}</td><td>знаряддя добування</td><td class="mono bad">${show(a ?? "—")}</td><td class="mono good">${show(b ?? "—")}</td></tr>`);
  }
  if (JSON.stringify(g.jobTools) !== JSON.stringify(d.jobTools)) lines.push(`<tr><td>Робота</td><td>знаряддя справ</td><td class="mono bad">${show(g.jobTools)}</td><td class="mono good">${show(d.jobTools)}</td></tr>`);
  $("view").innerHTML = `<div class="view-pad">
    <div class="note">Порівняння з тим, що гра мала при останньому завантаженні «З гри» (або з вбудованими значеннями). Застосувати зміни — кнопка «У гру».</div>
    ${lines.length ? `<table class="grid"><tr><th>Річ</th><th>Поле</th><th>У грі</th><th>У редакторі</th></tr>${lines.join("")}</table>` : `<div class="empty">Змін немає.</div>`}</div>`;
  for (const tr of $("view").querySelectorAll<HTMLElement>("tr[data-id]")) tr.onclick = () => select(tr.dataset.id!);
}
