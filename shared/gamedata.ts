// Game data exchange format: items, recipes and tool requirements as plain JSON.
// - The item editor (tools/item-editor) imports it from a running server and exports it back.
// - The server loads data/game-data.json on start, applies edits live and pushes them to clients.
// - Built-in defaults stay in items.ts / crafting.ts / gear.ts; a game-data file only overrides them.
//
// Rules for applying (keep running worlds consistent):
//   - items are added or changed, never removed (saves, markets and maps may reference them);
//   - a new placeable must reuse an existing map object (the map has no editor yet);
//   - recipes are replaced as a whole list.

import { ITEMS, ITEM_IDS, type GearStats, type ItemDef, type ItemGroup, type ItemId, type Slot } from "./items.ts";
import { RECIPES, RECIPE_BY_OUT, STATION_NAMES, type Recipe, type Station } from "./crafting.ts";
import { SKILLS, SKILL_IDS } from "./skills.ts";
import { JOB_TOOL, SLOT_NAMES, SLOTS, TOOL_FOR } from "./gear.ts";
import { O } from "./map.ts";
import { START_COINS } from "./constants.ts";

export const GAMEDATA_FORMAT = "rutzarg-gamedata";
export const GAMEDATA_VERSION = 1;

export interface GameData {
  format: typeof GAMEDATA_FORMAT;
  version: number;
  exportedAt: string;
  source?: string;
  items: ItemDef[];
  recipes: Recipe[];
  /** Which tools extract a raw resource (the first is the proper one). */
  gatherTools: Partial<Record<ItemId, ItemId[]>>;
  /** Tool a worker of a business kind needs. */
  jobTools: Record<string, ItemId>;
  /** Read-only lists and constants for editors (ignored on import). */
  reference?: GameReference;
}

export interface GameReference {
  groups: { id: ItemGroup; name: string }[];
  slots: { id: Slot; name: string }[];
  stations: { id: Station; name: string }[];
  skills: { id: string; name: string }[];
  mapObjects: { id: number; key: string }[];
  businessKinds: string[];
  constants: GameConstants;
}

/** Numbers the economy depends on (mirrors server code; for calculators). */
export interface GameConstants {
  /** Game minutes per gathered unit for a novice without a tool bonus (players). */
  gatherBaseMinutes: number;
  /** Market pays this share of the price when buying from a seller. */
  marketBuyFactor: number;
  /** Market price multiplier bounds (scarcity / glut). */
  priceMinMult: number;
  priceMaxMult: number;
  /** Market refuses to buy above targetStock × this. */
  marketFullMult: number;
  /** Caravans pay this share of the base price, dailyExport × 3 units a day. */
  wholesaleFactor: number;
  startCoins: number;
  /** Real seconds per game minute of crafting for players. */
  craftSecondsPerMinute: number;
  /** Repair at someone else's workshop: share of the price of the wear. */
  repairFactor: number;
}

export const GAME_CONSTANTS: GameConstants = {
  gatherBaseMinutes: 2.4, marketBuyFactor: 0.8, priceMinMult: 0.4, priceMaxMult: 2.5, marketFullMult: 4,
  wholesaleFactor: 0.5, startCoins: START_COINS, craftSecondsPerMinute: 0.4, repairFactor: 0.6,
};

export const GROUP_NAMES: Record<ItemGroup, string> = {
  raw: "Сировина", material: "Матеріали", placeable: "Речі (ставляться)", wear: "Одяг, зброя, знаряддя",
};

export function gameReference(): GameReference {
  return {
    groups: (Object.keys(GROUP_NAMES) as ItemGroup[]).map((id) => ({ id, name: GROUP_NAMES[id] })),
    slots: SLOTS.map((id) => ({ id, name: SLOT_NAMES[id] })),
    stations: (Object.keys(STATION_NAMES) as Station[]).map((id) => ({ id, name: STATION_NAMES[id] })),
    skills: SKILL_IDS.map((id) => ({ id, name: SKILLS[id].name })),
    mapObjects: Object.entries(O).filter(([, v]) => v > 0).map(([key, id]) => ({ id, key })),
    businessKinds: ["lumber", "mine", "quarry", "farm", "construction", "smithy", "tavern", "trade", "guard", "temple", "admin"],
    constants: { ...GAME_CONSTANTS },
  };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** The data the game is running with right now. */
export function exportGameData(source = "game"): GameData {
  return {
    format: GAMEDATA_FORMAT, version: GAMEDATA_VERSION, exportedAt: new Date().toISOString(), source,
    items: ITEM_IDS.map((id) => clone(ITEMS[id])),
    recipes: clone(RECIPES),
    gatherTools: clone(TOOL_FOR),
    jobTools: clone(JOB_TOOL),
    reference: gameReference(),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface Problem { level: "error" | "warning"; where: string; text: string }

const GROUPS = new Set<ItemGroup>(["raw", "material", "placeable", "wear"]);
const STATIONS = new Set(Object.keys(STATION_NAMES));
const ID_RE = /^[a-z][a-z0-9_]{1,30}$/;

export function validateGameData(d: unknown): Problem[] {
  const out: Problem[] = [];
  const err = (where: string, text: string) => out.push({ level: "error", where, text });
  const warn = (where: string, text: string) => out.push({ level: "warning", where, text });
  const g = d as GameData;
  if (!g || typeof g !== "object") { err("файл", "Це не JSON з даними гри"); return out; }
  if (g.format !== GAMEDATA_FORMAT) err("файл", `Невідомий формат «${String(g.format)}»`);
  if (!Array.isArray(g.items) || !Array.isArray(g.recipes)) { err("файл", "Немає списків items / recipes"); return out; }
  const ids = new Set<string>();
  const objs = new Set<number>(Object.values(O));
  for (const it of g.items) {
    const w = `річ «${it?.id ?? "?"}»`;
    if (!it || typeof it.id !== "string" || !ID_RE.test(it.id)) { err(w, "id — латиниця в нижньому регістрі, цифри, _ (2–31 символ)"); continue; }
    if (ids.has(it.id)) err(w, "id повторюється");
    ids.add(it.id);
    if (!it.name?.trim()) err(w, "Немає назви");
    if (!GROUPS.has(it.group)) err(w, `Невідома група «${it.group}»`);
    if (!(Number.isFinite(it.basePrice) && it.basePrice >= 1)) err(w, "Базова ціна має бути ≥ 1");
    if (!(Number.isFinite(it.targetStock) && it.targetStock >= 1)) err(w, "Норма запасу на ринку має бути ≥ 1");
    if (!(Number.isFinite(it.dailyExport) && it.dailyExport >= 0)) err(w, "Експорт караванами — число ≥ 0");
    if (!/^#[0-9a-fA-F]{6}$/.test(it.color ?? "")) err(w, "Колір — у форматі #rrggbb");
    if (it.group === "placeable" && !(it.obj !== undefined && objs.has(it.obj))) err(w, "Річ, що ставиться, має посилатися на наявний об'єкт мапи");
    if (it.group !== "placeable" && it.obj !== undefined) warn(w, "Об'єкт мапи має сенс лише для речей, що ставляться");
    if (it.group === "wear" && !it.slot) err(w, "Одяг/зброя/знаряддя має мати слот");
    if (it.group !== "wear" && it.slot) warn(w, "Слот має сенс лише для групи «Одяг, зброя, знаряддя»");
    if (it.uses !== undefined && !(it.uses >= 1)) err(w, "Міцність (використань) має бути ≥ 1");
    const st = it.stats as GearStats | undefined;
    for (const k of ["attack", "armor", "presence"] as const) if (st?.[k] !== undefined && !(Number.isFinite(st[k]) && st[k]! >= 0)) err(w, `Характеристика ${k} — число ≥ 0`);
    for (const [r, v] of Object.entries(st?.gather ?? {})) if (!(v! > 0 && v! <= 5)) err(w, `Бонус збору ${r} — від 0 до 5`);
  }
  // built-in items can't disappear from a running world
  for (const id of ITEM_IDS as string[]) if (!ids.has(id)) warn(`річ «${id}»`, "Немає у файлі — у грі лишиться як є (вбудовані речі не видаляються)");
  const all = new Set<string>([...ids, ...(ITEM_IDS as string[])]);
  const recIds = new Set<string>();
  const outs = new Map<string, string>();
  for (const r of g.recipes) {
    const w = `рецепт «${r?.id ?? "?"}»`;
    if (!r || typeof r.id !== "string" || !r.id) { err(w, "Немає id"); continue; }
    if (recIds.has(r.id)) err(w, "id рецепта повторюється");
    recIds.add(r.id);
    if (!all.has(r.out)) err(w, `Результат «${r.out}» — немає такої речі`);
    if (outs.has(r.out)) warn(w, `Річ «${r.out}» вже робиться за рецептом «${outs.get(r.out)}» — у грі діятиме перший`);
    outs.set(r.out, r.id);
    if (!(r.qty >= 1)) err(w, "Кількість результату ≥ 1");
    if (!(r.minutes > 0)) err(w, "Час виготовлення > 0");
    if (!STATIONS.has(r.station)) err(w, `Невідома станція «${r.station}»`);
    if (!(SKILL_IDS as string[]).includes(r.skill)) err(w, `Невідома навичка «${r.skill}»`);
    const inputs = Object.entries(r.inputs ?? {});
    if (!inputs.length) err(w, "Немає компонентів");
    for (const [i, n] of inputs) {
      if (!all.has(i)) err(w, `Компонент «${i}» — немає такої речі`);
      if (!(Number(n) >= 1)) err(w, `Кількість «${i}» ≥ 1`);
      if (i === r.out) err(w, "Річ не може бути власним компонентом");
    }
    if (r.minSkill !== undefined && !(Number.isInteger(r.minSkill) && r.minSkill >= 0 && r.minSkill <= 100)) err(w, "Мінімальна навичка — ціле число 0–100");
    if (r.tools !== undefined && !Array.isArray(r.tools)) err(w, "Інструменти — список речей");
    for (const t of r.tools ?? []) {
      if (!all.has(t)) err(w, `Інструмент «${t}» — немає такої речі`);
      else if (t === r.out) err(w, "Інструмент не може бути потрібен для власного виготовлення — перший такий ніхто не зробить");
      else if (!g.items.find((x) => x.id === t)?.uses) warn(w, `Інструмент «${t}» не має міцності — не зношуватиметься`);
      if (t in (r.inputs ?? {})) warn(w, `«${t}» і компонент, і інструмент`);
    }
  }
  // cycles: a → … → a
  const byOut = new Map<string, Recipe>(g.recipes.map((r) => [r.out as string, r] as const));
  const visiting = new Set<string>(), done = new Set<string>();
  const dfs = (id: string, path: string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) { err(`рецепт «${byOut.get(id)?.id}»`, `Замкнене коло: ${[...path, id].join(" → ")}`); return; }
    visiting.add(id);
    for (const i of Object.keys(byOut.get(id)?.inputs ?? {})) dfs(i, [...path, id]);
    visiting.delete(id); done.add(id);
  };
  for (const id of byOut.keys()) dfs(id, []);
  // tools that (through their own recipes) need themselves: nobody can make the first one
  const needs = (id: string, seen: Set<string>): boolean => {
    const r = byOut.get(id);
    if (!r) return false;
    for (const t of r.tools ?? []) {
      if (seen.has(t)) return true;
      if (needs(t, new Set([...seen, t]))) return true;
    }
    return false;
  };
  for (const [id, r] of byOut) for (const t of r.tools ?? []) if (t !== id && needs(t, new Set([t]))) warn(`рецепт «${r.id}»`, `Інструмент «${t}» не можна зробити без нього самого — перший лише купити`);
  for (const [res, tools] of Object.entries(g.gatherTools ?? {})) {
    if (!all.has(res)) err(`добування «${res}»`, "Немає такої речі");
    for (const t of tools ?? []) if (!all.has(t)) err(`добування «${res}»`, `Знаряддя «${t}» — немає такої речі`);
  }
  for (const [k, t] of Object.entries(g.jobTools ?? {})) if (!all.has(t)) err(`робота «${k}»`, `Знаряддя «${t}» — немає такої речі`);
  return out;
}

// ---------------------------------------------------------------------------
// Applying (server on start / on import; clients on connect)
// ---------------------------------------------------------------------------

/** Make the game run with this data. Returns ids of newly added items. Throws on errors. */
export function applyGameData(d: GameData): string[] {
  const errors = validateGameData(d).filter((p) => p.level === "error");
  if (errors.length) throw new Error(errors.map((e) => `${e.where}: ${e.text}`).join("; "));
  const added: string[] = [];
  for (const it of d.items) {
    const id = it.id as ItemId;
    const def: ItemDef = clone(it);
    if (def.group !== "placeable") delete def.obj;
    if (def.group !== "wear") { delete def.slot; delete def.stats; }
    if (ITEMS[id]) {
      // replace fields in place: other modules hold references to the same object
      for (const k of Object.keys(ITEMS[id]) as (keyof ItemDef)[]) delete (ITEMS[id] as unknown as Record<string, unknown>)[k];
      Object.assign(ITEMS[id], def);
    } else {
      (ITEMS as Record<string, ItemDef>)[id] = def;
      ITEM_IDS.push(id);
      added.push(id);
    }
  }
  RECIPES.splice(0, RECIPES.length, ...clone(d.recipes));
  for (const k of Object.keys(RECIPE_BY_OUT)) delete (RECIPE_BY_OUT as Record<string, Recipe>)[k];
  for (const r of RECIPES) if (!RECIPE_BY_OUT[r.out]) RECIPE_BY_OUT[r.out] = r;
  if (d.gatherTools) {
    for (const k of Object.keys(TOOL_FOR)) delete (TOOL_FOR as Record<string, ItemId[]>)[k];
    Object.assign(TOOL_FOR, clone(d.gatherTools));
  }
  if (d.jobTools) {
    for (const k of Object.keys(JOB_TOOL)) delete JOB_TOOL[k];
    Object.assign(JOB_TOOL, clone(d.jobTools));
  }
  return added;
}
