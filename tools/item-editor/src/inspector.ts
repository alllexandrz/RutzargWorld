// Right pane: every property of the selected item and its recipe, plus live economy numbers.

import type { GearStats, ItemDef, ItemGroup, Slot } from "../../../shared/items.ts";
import type { Recipe, Station } from "../../../shared/crafting.ts";
import type { SkillId } from "../../../shared/skills.ts";
import { $, bindSections, esc, options, section } from "./dom.ts";
import { edit, isNewItem, item, itemName, problemsFor, recipeOf, select, state, usedIn } from "./model.ts";
import { basePrice, bill, fmt, gatherEcon, gatherTools, priceRange, recipeEcon, sellPrice, toolBonus, wholesale } from "./economy.ts";

type Dict = Record<string, unknown>;

function num(v: string, min = 0): number {
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? Math.max(min, n) : min;
}

export function initInspector() {
  const root = $("inspector-body");
  // all edits commit on "change" (one undo step per field)
  root.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const id = state.selected;
    if (!id) return;
    const ds = t.dataset;
    if (ds.f) return setItemField(id, ds.f, t.value, t);
    if (ds.r) return setRecipeField(id, ds.r, t.value);
    if (ds.inItem !== undefined) return setInput(id, ds.inItem, "item", t.value);
    if (ds.inQty !== undefined) return setInput(id, ds.inQty, "qty", t.value);
    if (ds.gbRes !== undefined) return setGatherBonus(id, ds.gbRes, "res", t.value);
    if (ds.gbVal !== undefined) return setGatherBonus(id, ds.gbVal, "val", t.value);
    if (ds.addCraftTool !== undefined && t.value) {
      const tool = t.value;
      return edit(`${id}: для ремесла потрібен ${tool}`, (d) => {
        const r = d.recipes.find((x) => x.out === id);
        if (r) r.tools = [...(r.tools ?? []).filter((x) => x !== tool), tool as Recipe["out"]];
      });
    }
    if (ds.addTool !== undefined && t.value) {
      const tool = t.value;
      edit(`${id}: добувається знаряддям ${tool}`, (d) => {
        const gt = d.gatherTools as Record<string, string[]>;
        gt[id] = [...(gt[id] ?? []).filter((x) => x !== tool), tool];
      });
    }
  });
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const id = state.selected;
    if (!id) return;
    const b = t.closest("button") as HTMLButtonElement | null;
    const go = t.closest("[data-go]") as HTMLElement | null;
    if (go) return select(go.dataset.go!);
    if (!b) return;
    const ds = b.dataset;
    if (ds.addRecipe !== undefined) {
      edit(`${id}: новий рецепт`, (d) => d.recipes.push({ id, out: id as Recipe["out"], qty: 1, inputs: {}, station: "hand", skill: "carpentry", minutes: 15 }));
    } else if (ds.delRecipe !== undefined) {
      edit(`${id}: рецепт прибрано`, (d) => { d.recipes = d.recipes.filter((r) => r.out !== id); });
    } else if (ds.addInput !== undefined) {
      const first = state.data.items.find((x) => x.id !== id && !(x.id in (recipeOf(id)?.inputs ?? {})));
      if (first) edit(`${id}: + компонент`, (d) => { const r = d.recipes.find((x) => x.out === id); if (r) (r.inputs as Dict)[first.id] = 1; });
    } else if (ds.delInput) {
      const k = ds.delInput;
      edit(`${id}: − компонент ${k}`, (d) => { const r = d.recipes.find((x) => x.out === id); if (r) delete (r.inputs as Dict)[k]; });
    } else if (ds.addGb !== undefined) {
      edit(`${id}: + бонус збору`, (d) => {
        const it = d.items.find((x) => x.id === id)!;
        it.stats ??= {};
        const g = (it.stats.gather ??= {}) as Dict;
        const res = state.data.items.find((x) => x.group === "raw" && !(x.id in g))?.id ?? "wood";
        g[res] = 0.3;
      });
    } else if (ds.delGb) {
      const k = ds.delGb;
      edit(`${id}: − бонус збору ${k}`, (d) => { const g = d.items.find((x) => x.id === id)?.stats?.gather as Dict | undefined; if (g) delete g[k]; });
    } else if (ds.delCraftTool) {
      const tool = ds.delCraftTool;
      edit(`${id}: ремесло без ${tool}`, (d) => {
        const r = d.recipes.find((x) => x.out === id);
        if (!r) return;
        r.tools = (r.tools ?? []).filter((x) => x !== tool);
        if (!r.tools.length) delete r.tools;
      });
    } else if (ds.delTool) {
      const tool = ds.delTool;
      edit(`${id}: прибрано знаряддя ${tool}`, (d) => {
        const gt = d.gatherTools as Record<string, string[]>;
        gt[id] = (gt[id] ?? []).filter((x) => x !== tool);
        if (!gt[id].length) delete gt[id];
      });
    }
  });
}

function setItemField(id: string, f: string, v: string, el: HTMLInputElement | HTMLSelectElement) {
  if (f === "id") return renameItem(id, v.trim(), el);
  edit(`${id}: ${f} = ${v}`, (d) => {
    const it = d.items.find((x) => x.id === id) as ItemDef;
    const o = it as unknown as Dict;
    switch (f) {
      case "name": it.name = v; break;
      case "color": it.color = v; break;
      case "group": {
        it.group = v as ItemGroup;
        if (it.group !== "placeable") delete it.obj; else it.obj ??= state.ref.mapObjects.find((m) => m.key === "CRATE")?.id;
        if (it.group !== "wear") { delete it.slot; delete it.stats; delete it.uses; } else it.slot ??= "weapon";
        break;
      }
      case "obj": it.obj = Number(v); break;
      case "slot": it.slot = v as Slot; break;
      case "uses": if (v === "") delete it.uses; else it.uses = Math.round(num(v, 1)); break;
      case "basePrice": case "targetStock": o[f] = Math.round(num(v, 1)); break;
      case "dailyExport": it.dailyExport = Math.round(num(v, 0)); break;
      default:
        if (f.startsWith("stats.")) {
          const k = f.slice(6) as "attack" | "armor" | "presence";
          it.stats ??= {};
          if (v === "" || num(v) === 0) delete (it.stats as GearStats)[k]; else (it.stats as GearStats)[k] = num(v);
        }
    }
  });
}

/** Only new items can change id (built-in ids are referenced by game code, saves and maps). */
function renameItem(id: string, next: string, el: HTMLInputElement | HTMLSelectElement) {
  if (next === id) return;
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(next) || item(next)) { el.value = id; return alert("id: латиниця в нижньому регістрі, цифри, _, і має бути унікальним."); }
  edit(`перейменовано ${id} → ${next}`, (d) => {
    d.items.find((x) => x.id === id)!.id = next as ItemDef["id"];
    for (const r of d.recipes) {
      if (r.out === id) { r.out = next as Recipe["out"]; if (r.id === id) r.id = next; }
      const ins = r.inputs as Dict;
      if (id in ins) { ins[next] = ins[id]; delete ins[id]; }
    }
    const gt = d.gatherTools as Record<string, string[]>;
    if (gt[id]) { gt[next] = gt[id]; delete gt[id]; }
    for (const k of Object.keys(gt)) gt[k] = gt[k].map((t) => (t === id ? next : t));
    for (const k of Object.keys(d.jobTools)) if (d.jobTools[k] === id) (d.jobTools as Dict)[k] = next;
    state.selected = next; // before the re-render
  });
}

function setRecipeField(id: string, f: string, v: string) {
  edit(`${id}: рецепт ${f} = ${v}`, (d) => {
    const r = d.recipes.find((x) => x.out === id);
    if (!r) return;
    if (f === "qty") r.qty = Math.round(num(v, 1));
    else if (f === "minutes") r.minutes = num(v, 1);
    else if (f === "minSkill") { const n = Math.min(100, Math.round(num(v, 0))); if (n > 0) r.minSkill = n; else delete r.minSkill; }
    else if (f === "station") r.station = v as Station;
    else if (f === "skill") r.skill = v as SkillId;
  });
}

function setInput(id: string, key: string, what: "item" | "qty", v: string) {
  edit(`${id}: компонент ${key} → ${v}`, (d) => {
    const r = d.recipes.find((x) => x.out === id);
    if (!r) return;
    const ins = r.inputs as Dict;
    if (what === "qty") ins[key] = Math.round(num(v, 1));
    else if (v !== key && v !== id) {
      const q = ins[key];
      delete ins[key];
      ins[v] = (Number(ins[v] ?? 0) + Number(q));
    }
  });
}

function setGatherBonus(id: string, key: string, what: "res" | "val", v: string) {
  edit(`${id}: бонус збору ${key}`, (d) => {
    const g = d.items.find((x) => x.id === id)?.stats?.gather as Dict | undefined;
    if (!g) return;
    if (what === "val") g[key] = num(v, 0) / 100;
    else if (v !== key) { g[v] = g[key]; delete g[key]; }
  });
}

// ---------------------------------------------------------------------------

export function renderInspector() {
  const root = $("inspector-body");
  const id = state.selected;
  const it = id ? item(id) : undefined;
  if (!it || !id) { root.innerHTML = `<div class="empty">Вибери річ ліворуч або на графі.</div>`; return; }
  const rec = recipeOf(id);
  const ref = state.ref;
  const itemsOpt = state.data.items.map((x) => ({ id: x.id, name: `${x.name} (${x.id})` }));
  const rawOpt = state.data.items.filter((x) => x.group === "raw").map((x) => ({ id: x.id, name: x.name }));
  const probs = problemsFor(id);

  const head = probs.length ? `<div class="full">${probs.map((p) => `<div class="callout ${p.level === "error" ? "bad" : ""}">${esc(p.text)}</div>`).join("")}</div>` : "";

  const basic = `${head}
    <label>id</label>${isNewItem(id) ? `<input data-f="id" value="${esc(id)}" class="mono">` : `<span class="ro" title="Вбудовані id не змінюються: на них посилаються код, збереження й мапа">${esc(id)}</span>`}
    <label>Назва</label><input data-f="name" value="${esc(it.name)}">
    <label>Група</label><select data-f="group">${options(ref.groups, it.group)}</select>
    <label>Колір</label><div class="row"><input type="color" data-f="color" value="${esc(it.color)}"><span class="mono muted">${esc(it.color)}</span></div>
    ${it.group === "placeable" ? `<label>Об'єкт мапи</label><select data-f="obj">${options(ref.mapObjects.map((m) => ({ id: m.id, name: `${m.key} (${m.id})` })), it.obj)}</select>` : ""}`;

  const [pmin, pmax] = priceRange(id);
  const ws = wholesale(id);
  const market = `
    <label>Базова ціна</label><input type="number" min="1" data-f="basePrice" value="${it.basePrice}">
    <label>Норма запасу</label><input type="number" min="1" data-f="targetStock" value="${it.targetStock}" title="Запас, який ринок вважає нормальним — від нього рахується дефіцит/надлишок">
    <label>Каравани/день</label><input type="number" min="0" data-f="dailyExport" value="${it.dailyExport}" title="Скільки одиниць щодня вивозять каравани з ринку">
    <div class="full">
      <div class="kv"><span>Ціна на ринку (дефіцит … надлишок)</span><b>${pmax} … ${pmin}</b></div>
      <div class="kv"><span>Ринок платить продавцю (звичайний запас)</span><b>${sellPrice(id)}</b></div>
      <div class="kv"><span>Оптовики: ціна × обсяг на день</span><b>${ws.price} × ${ws.perDay}</b></div>
      <div class="kv"><span>Ринок перестає купувати від</span><b>${it.targetStock * ref.constants.marketFullMult} шт.</b></div>
    </div>`;

  let gear = "";
  if (it.group === "wear") {
    const st = it.stats ?? {};
    const gb = Object.entries(st.gather ?? {});
    gear = `
      <label>Слот</label><select data-f="slot">${options(ref.slots, it.slot)}</select>
      <label>Атака</label><input type="number" step="0.5" min="0" data-f="stats.attack" value="${st.attack ?? ""}">
      <label>Захист</label><input type="number" step="0.5" min="0" data-f="stats.armor" value="${st.armor ?? ""}">
      <label>Вигляд</label><input type="number" step="0.5" min="0" data-f="stats.presence" value="${st.presence ?? ""}">
      <label>Міцність</label><input type="number" min="1" data-f="uses" value="${it.uses ?? ""}" placeholder="для знарядь: використань" title="Знаряддя: скільки зібраних одиниць / робочих годин витримує. Порожньо — не знаряддя (зношується щодня, як одяг).">
      <label>Бонус збору</label><div class="full">${gb.map(([r, v]) => `<div class="row" style="margin-bottom:3px">
          <select data-gb-res="${esc(r)}">${options(rawOpt, r)}</select>
          <input type="number" min="0" max="500" data-gb-val="${esc(r)}" value="${Math.round((v ?? 0) * 100)}"><span class="muted">%</span>
          <button class="mini danger" data-del-gb="${esc(r)}">✕</button></div>`).join("")}
        <button class="mini" data-add-gb>＋ ресурс</button></div>
      ${it.uses ? `<div class="full"><div class="kv"><span>Знос за використання</span><b>${fmt(it.basePrice / it.uses, 2)} срібла</b></div>
        <div class="kv"><span>Ремонт з повного зносу (чужа / своя майстерня)</span><b>${Math.ceil(it.basePrice * ref.constants.repairFactor)} / ${Math.max(1, Math.ceil(Math.ceil(it.basePrice * ref.constants.repairFactor) / 3))}</b></div></div>` : ""}`;
  }

  // gathering: which tools extract this item
  const tools = gatherTools(id);
  const ge = gatherEcon(id);
  const wearItems = state.data.items.filter((x) => x.group === "wear").map((x) => ({ id: x.id, name: x.name }));
  const gather = `<div class="full">
      <div class="chips">${tools.map((t) => `<span class="chip" style="--c:${esc(item(t)?.color)}">${esc(itemName(t))} <span class="muted">+${Math.round(toolBonus(t, id) * 100)}%</span><button data-del-tool="${esc(t)}">✕</button></span>`).join("") || `<span class="muted">Не добувається напряму (лише ремеслом, справами чи ринком).</span>`}</div>
      <div class="row" style="margin-top:5px"><select data-add-tool>${options(wearItems.filter((x) => !tools.includes(x.id)), "", "＋ знаряддя для добування…")}</select></div>
      ${ge ? `<div style="margin-top:6px">
        <div class="kv"><span>Час на одиницю (навичка ${state.skill})</span><b>${fmt(ge.minutes, 2)} хв</b></div>
        <div class="kv"><span>Одиниць за ігрову годину</span><b>${fmt(ge.unitsPerHour)}</b></div>
        <div class="kv"><span>Знос знаряддя на одиницю</span><b>${fmt(ge.wearPerUnit, 2)}</b></div>
        <div class="kv"><span>Дохід за годину (продаж ринку − знос)</span><b>${fmt(ge.perHour)}</b></div></div>` : ""}
    </div>`;

  let recipe: string;
  if (rec) {
    const e = recipeEcon(rec);
    const ins = Object.entries(rec.inputs);
    recipe = `
      <label>Станція</label><select data-r="station">${options(ref.stations, rec.station)}</select>
      <label>Навичка</label><select data-r="skill">${options(ref.skills, rec.skill)}</select>
      <label>Час (новачок)</label><div class="row"><input type="number" min="1" data-r="minutes" value="${rec.minutes}"><span class="muted">хв · зараз ${fmt(e.minutes)} хв</span></div>
      <label>Виходить</label><div class="row"><input type="number" min="1" data-r="qty" value="${rec.qty}"><span class="muted">шт. за раз</span></div>
      <label>Мін. навичка</label><div class="row"><input type="number" min="0" max="100" data-r="minSkill" value="${rec.minSkill ?? 0}" title="Нижче цього рівня навички річ не зробити зовсім (0 — будь-хто)">
        <span class="${e.locked ? "bad" : "muted"}">${rec.minSkill ? (e.locked ? `недоступно на рівні ${state.skill}` : "доступно") : "будь-хто"}</span></div>
      <label>Інструменти</label><div class="full">
        <div class="chips">${(rec.tools ?? []).map((t) => `<span class="chip" style="--c:${esc(item(t)?.color)}" title="Має бути в сумці чи в руці; кожен раз зношується на одне використання">⚒ ${esc(itemName(t))}${item(t)?.uses ? ` <span class="muted">${fmt((item(t)!.basePrice) / item(t)!.uses!, 2)} ср./раз</span>` : ""}<button data-del-craft-tool="${esc(t)}">✕</button></span>`).join("") || `<span class="muted">Без інструментів.</span>`}</div>
        <div class="row" style="margin-top:4px"><select data-add-craft-tool>${options(wearItems.filter((x) => x.id !== id && !(rec.tools ?? []).includes(x.id as Recipe["out"])), "", "＋ інструмент для ремесла…")}</select></div></div>
      <label>Компоненти</label><div class="full">${ins.map(([i, n]) => `<div class="row" style="margin-bottom:3px">
          <select data-in-item="${esc(i)}">${options(itemsOpt.filter((o) => o.id !== id), i)}</select>
          <input type="number" min="1" data-in-qty="${esc(i)}" value="${n}">
          <span class="muted" style="width:58px;text-align:right">${basePrice(i) * (n ?? 0)} ср.</span>
          <button class="mini danger" data-del-input="${esc(i)}">✕</button></div>`).join("")}
        <div class="row"><button class="mini" data-add-input>＋ компонент</button><span class="tb-spacer"></span><button class="mini danger" data-del-recipe>Прибрати рецепт</button></div></div>`;
  } else {
    recipe = `<div class="full muted">Рецепта немає — річ лише добувається, купується чи виробляється справами.</div><div class="full"><button data-add-recipe>＋ Додати рецепт</button></div>`;
  }

  // economy readouts
  let econ = "";
  if (rec) {
    const e = recipeEcon(rec);
    const b = e.bill;
    econ = `<div class="full">
      ${e.locked ? `<div class="callout bad" style="margin-bottom:6px">На рівні навички ${state.skill} цей рецепт недоступний (потрібно ≥ ${rec.minSkill}).</div>` : ""}
      <div class="kv"><span>Компоненти за ціною ринку</span><b>${fmt(e.inputCost, 0)}</b></div>
      ${e.toolWear ? `<div class="kv"><span>Знос інструментів за раз</span><b>${fmt(e.toolWear, 2)}</b></div>` : ""}
      <div class="kv"><span>Результат: базова / платить ринок</span><b>${e.outValue} / ${e.outSell}</b></div>
      <div class="kv"><span>Купив компоненти → зробив → продав</span><b class="${e.tradeProfit > 0 ? "warn" : ""}">${e.tradeProfit > 0 ? "+" : ""}${fmt(e.tradeProfit, 0)} за раз · ${fmt(e.perHour)}/год</b></div>
      <div class="kv"><span>Усе сам: добув, зробив, продав</span><b>${fmt(e.scratchPerHour)}/год</b></div>
      <div class="kv"><span>Для порівняння: продати сировину</span><b>${e.rawPerHour ? `${fmt(e.rawPerHour)}/год` : "—"}</b></div>
      <div class="kv"><span>Ланцюг: ремесло + добування на 1 шт.</span><b>${fmt(b.craftMin)} + ${fmt(b.gatherMin)} хв</b></div>
      ${e.arbitrage ? `<div class="callout" style="margin-top:6px">Арбітраж: вигідно купувати компоненти на ринку й продавати результат ринку. Підніми ціни компонентів, знизь ціну результату або додай час.</div>` : ""}
      ${e.scratchPerHour > 0 && e.rawPerHour > 0 && e.scratchPerHour < e.rawPerHour ? `<div class="callout bad" style="margin-top:6px">Ремесло тут невигідне: продати сировину дає більше за годину.</div>` : ""}
      ${b.cycle ? `<div class="callout bad">Рецепт замикається сам на себе.</div>` : ""}
      <h4 style="margin:8px 0 4px">Сировина на 1 шт.</h4>
      <div class="chips">${Object.entries(b.raw).map(([r, q]) => `<span class="chip" data-go="${esc(r)}" style="--c:${esc(item(r)?.color)};cursor:pointer">${esc(itemName(r))} ×${fmt(q, 2)}${b.bought.includes(r) ? ` <span class="muted">(купити)</span>` : ""}</span>`).join("")}</div>
      <div class="kv" style="margin-top:4px"><span>Сировина за базовою ціною</span><b>${fmt(b.rawCost)}</b></div>
    </div>`;
  }
  const uses = usedIn(id);
  const asTool = state.data.recipes.filter((r) => (r.tools ?? []).includes(id as Recipe["out"]));
  const usedHtml = `<div class="full chips">${uses.map((r) => `<span class="chip" data-go="${esc(r.out)}" style="--c:${esc(item(r.out)?.color)};cursor:pointer">${esc(itemName(r.out))} ×${r.inputs[id as keyof typeof r.inputs]}</span>`).join("") || `<span class="muted">Ніде не використовується.</span>`}
    ${asTool.map((r) => `<span class="chip" data-go="${esc(r.out)}" style="--c:${esc(item(r.out)?.color)};cursor:pointer">⚒ інструмент для: ${esc(itemName(r.out))}</span>`).join("")}
    ${Object.entries(state.data.jobTools).filter(([, t]) => t === id).map(([k]) => `<span class="chip">робота: ${esc(k)}</span>`).join("")}</div>`;

  root.innerHTML = section("basic", "Річ", basic) + section("market", "Ринок і ціна", market)
    + (gear ? section("gear", "Спорядження", gear) : "")
    + section("gather", "Добування (знаряддя)", gather)
    + section("recipe", "Рецепт ремесла", recipe)
    + (econ ? section("econ", `Економіка (навичка ${state.skill})`, econ) : "")
    + section("used", "Де використовується", usedHtml);
  bindSections(root);
  void bill;
}
