// Economy calculators over the draft data. Formulas mirror the game code (shared/items.ts marketPrice,
// shared/crafting.ts craftMinutes, server gathering time) — the numbers come from GameConstants.

import type { Recipe } from "../../../shared/crafting.ts";
import type { ItemId } from "../../../shared/items.ts";
import { item, recipeOf, state } from "./model.ts";

const C = () => state.ref.constants;

export function basePrice(id: string): number { return item(id)?.basePrice ?? 0; }
/** What the market pays a seller at normal stock. */
export function sellPrice(id: string): number { return Math.max(1, Math.floor(basePrice(id) * C().marketBuyFactor)); }
export function priceRange(id: string): [number, number] {
  const b = basePrice(id);
  return [Math.max(1, Math.round(b * C().priceMinMult)), Math.max(1, Math.round(b * C().priceMaxMult))];
}
export function wholesale(id: string): { price: number; perDay: number } {
  const it = item(id);
  return { price: Math.max(1, Math.floor(basePrice(id) * C().wholesaleFactor)), perDay: (it?.dailyExport ?? 0) * 3 };
}

/** Game minutes per batch at a skill level (novice 1×, master ~2× faster). */
export function craftMinutes(rec: Recipe, skill = state.skill): number {
  return rec.minutes / (0.8 + Math.max(0, Math.min(100, skill)) / 100 * 1.2);
}

/** Tools that extract this resource, and the best speed bonus among them. */
export function gatherTools(id: string): string[] {
  return (state.data.gatherTools as Record<string, string[]>)[id] ?? [];
}
export function toolBonus(tool: string, resource: string): number {
  return (item(tool)?.stats?.gather as Record<string, number> | undefined)?.[resource] ?? 0;
}

/** Game minutes per gathered unit (null — can't be gathered: no tool rule). */
export function gatherMinutes(id: string, skill = state.skill): number | null {
  const tools = gatherTools(id);
  if (!tools.length) return null;
  const best = Math.max(0, ...tools.map((t) => toolBonus(t, id)));
  return C().gatherBaseMinutes / (0.8 + skill / 250) / (1 + best);
}

/** Wear cost of the tool per gathered unit (price / uses of the cheapest proper tool). */
export function toolCostPerUnit(id: string): number {
  const costs = gatherTools(id).map((t) => { const it = item(t); return it?.uses ? it.basePrice / it.uses : Infinity; });
  const c = Math.min(...costs);
  return Number.isFinite(c) ? c : 0;
}

export interface Bill {
  /** Raw resources (things without a recipe) for 1 unit of the item. */
  raw: Record<string, number>;
  /** Craft minutes along the whole chain. */
  craftMin: number;
  /** Silver for the raw resources at base price. */
  rawCost: number;
  /** Gathering minutes for the raw resources that can be gathered (others are bought). */
  gatherMin: number;
  /** Raw resources nobody can gather (must be bought / come from businesses). */
  bought: string[];
  steps: { rec: Recipe; times: number }[];
  cycle: boolean;
}

/** Everything that goes into ONE unit of an item, down to raw resources. */
export function bill(id: string, skill = state.skill): Bill {
  const out: Bill = { raw: {}, craftMin: 0, rawCost: 0, gatherMin: 0, bought: [], steps: [], cycle: false };
  const walk = (x: string, qty: number, path: Set<string>) => {
    const rec = recipeOf(x);
    if (!rec || path.has(x)) {
      if (path.has(x)) out.cycle = true;
      out.raw[x] = (out.raw[x] ?? 0) + qty;
      return;
    }
    const times = qty / rec.qty;
    out.craftMin += craftMinutes(rec, skill) * times;
    out.steps.push({ rec, times });
    const next = new Set(path); next.add(x);
    for (const [i, n] of Object.entries(rec.inputs)) walk(i, (n ?? 0) * times, next);
  };
  walk(id, 1, new Set());
  for (const [r, q] of Object.entries(out.raw)) {
    out.rawCost += basePrice(r) * q;
    const g = gatherMinutes(r, skill);
    if (g === null) out.bought.push(r); else out.gatherMin += g * q;
  }
  return out;
}

/** Wear of the craftsman's tools per batch (price / uses of each tool). */
export function toolWearPerBatch(rec: Recipe): number {
  return (rec.tools ?? []).reduce((s, t) => { const it = item(t); return s + (it?.uses ? it.basePrice / it.uses : 0); }, 0);
}

/** Can a crafter at this skill level make it at all? */
export function skillAllows(rec: Recipe, skill = state.skill): boolean {
  return (rec.minSkill ?? 0) <= skill;
}

export interface RecipeEcon {
  rec: Recipe;
  /** Tool wear per batch (silver). */
  toolWear: number;
  /** The slider's skill is below the recipe's minimum. */
  locked: boolean;
  /** Inputs bought at base price. */
  inputCost: number;
  /** Output at base price / at the price the market pays. */
  outValue: number;
  outSell: number;
  minutes: number;
  /** Profit per batch when inputs are bought and the result is sold to the market. */
  tradeProfit: number;
  /** Silver per game hour of crafting (from bought inputs, sold to the market). */
  perHour: number;
  /** Silver per game hour doing everything yourself: gather, craft, sell (bought raws are paid for). */
  scratchPerHour: number;
  /** Selling the raw resources instead (silver per game hour of gathering). */
  rawPerHour: number;
  arbitrage: boolean;
  bill: Bill;
}

export function recipeEcon(rec: Recipe, skill = state.skill): RecipeEcon {
  const inputCost = Object.entries(rec.inputs).reduce((s, [i, n]) => s + basePrice(i) * (n ?? 0), 0);
  const outValue = basePrice(rec.out) * rec.qty;
  const outSell = sellPrice(rec.out) * rec.qty;
  const minutes = craftMinutes(rec, skill);
  const toolWear = toolWearPerBatch(rec);
  const tradeProfit = outSell - inputCost - toolWear;
  const b = bill(rec.out, skill);
  const boughtCost = b.bought.reduce((s, r) => s + basePrice(r) * (b.raw[r] ?? 0), 0);
  const scratchMin = (b.craftMin + b.gatherMin) * rec.qty;
  const chainWear = b.steps.reduce((s, st) => s + toolWearPerBatch(st.rec) * st.times, 0) * rec.qty;
  const scratchGain = outSell - boughtCost * rec.qty - chainWear;
  const gatherable = Object.keys(b.raw).filter((r) => !b.bought.includes(r));
  const rawSell = gatherable.reduce((s, r) => s + sellPrice(r) * (b.raw[r] ?? 0), 0) * rec.qty;
  const rawMin = b.gatherMin * rec.qty;
  return {
    rec, toolWear, locked: !skillAllows(rec, skill), inputCost, outValue, outSell, minutes, tradeProfit,
    perHour: minutes > 0 ? (tradeProfit / minutes) * 60 : 0,
    scratchPerHour: scratchMin > 0 ? (scratchGain / scratchMin) * 60 : 0,
    rawPerHour: rawMin > 0 ? (rawSell / rawMin) * 60 : 0,
    arbitrage: tradeProfit > 0,
    bill: b,
  };
}

/** Silver per game hour gathering a raw resource and selling it (tool wear subtracted). */
export function gatherEcon(id: string, skill = state.skill) {
  const m = gatherMinutes(id, skill);
  if (m === null) return null;
  const perUnit = sellPrice(id) - toolCostPerUnit(id);
  return { minutes: m, unitsPerHour: 60 / m, perHour: (perUnit * 60) / m, wearPerUnit: toolCostPerUnit(id) };
}

export const fmt = (n: number, d = 1) => (Number.isFinite(n) ? (Math.round(n * 10 ** d) / 10 ** d).toString() : "—");
export type { ItemId };
