// Crafting recipes (concept: everything in the world can be made). Shared by the server
// (authoritative crafting for players and NPCs) and the client (craft panel).
//
// Production chains:
//   wood → plank (hands) → workbench, beds, tables, walls...
//   stone → forge, hearth, stone walls, well (hands)
//   ore + wood → iron (forge) → anvil (forge) → tools, lamps (anvil)
//   grain / herbs → meal (hearth)
//   herbs → cloth (hands) → clothes; iron (anvil) → weapons, axes, pickaxes, armour

import type { ItemId, Inventory } from "./items.ts";
import type { SkillId } from "./skills.ts";
import { O, findObjNear, type GameMap } from "./map.ts";

/** Where the work happens. "hand" = anywhere. */
export type Station = "hand" | "workbench" | "forge" | "anvil" | "hearth";

export const STATION_OBJ: Record<Exclude<Station, "hand">, number> = {
  workbench: O.WORKBENCH, forge: O.FORGE, anvil: O.ANVIL, hearth: O.HEARTH,
};

export const STATION_NAMES: Record<Station, string> = {
  hand: "руками", workbench: "верстак", forge: "горно", anvil: "ковадло", hearth: "вогнище",
};

export interface Recipe {
  id: string;
  out: ItemId;
  qty: number;
  inputs: Partial<Record<ItemId, number>>;
  station: Station;
  skill: SkillId;
  /** Game minutes for a novice (skill multiplier 1.0 → minutes / 1.0). */
  minutes: number;
  /** Below this level of the skill one can't make it at all (0 / undefined = anyone). */
  minSkill?: number;
  /** Tools one must have (in hand or in the bag); each batch wears every one of them by one use. */
  tools?: ItemId[];
}

type Req = { minSkill?: number; tools?: ItemId[] };
const r = (out: ItemId, qty: number, inputs: Recipe["inputs"], station: Station, skill: SkillId, minutes: number, req: Req = {}): Recipe =>
  ({ id: out, out, qty, inputs, station, skill, minutes, ...(req.minSkill ? { minSkill: req.minSkill } : {}), ...(req.tools?.length ? { tools: req.tools } : {}) });

// requirement shorthands
const HAMMER: Req = { tools: ["hammer"] };
const SAW: Req = { tools: ["saw"] };
const NEEDLE: Req = { tools: ["needle"] };
const lvl = (minSkill: number, base: Req = {}): Req => ({ ...base, minSkill });

export const RECIPES: Recipe[] = [
  r("plank", 2, { wood: 1 }, "hand", "carpentry", 6),
  r("workbench", 1, { plank: 6 }, "hand", "carpentry", 30),
  r("forge", 1, { stone: 10, wood: 2 }, "hand", "building", 45),
  r("hearth", 1, { stone: 6, wood: 2 }, "hand", "building", 30),
  r("wall_stone", 1, { stone: 4 }, "hand", "building", 15),
  r("well", 1, { stone: 12, wood: 2 }, "hand", "building", 60, lvl(15)),
  r("iron", 1, { ore: 2, wood: 1 }, "forge", "smithing", 15),
  r("anvil", 1, { iron: 4 }, "forge", "smithing", 45, lvl(20, HAMMER)),
  r("tools", 1, { iron: 1, plank: 1 }, "anvil", "smithing", 25, HAMMER),
  r("lamp", 1, { iron: 1, plank: 2 }, "anvil", "smithing", 30, HAMMER),
  r("bed", 1, { plank: 6, grain: 2 }, "workbench", "carpentry", 40, SAW),
  r("table", 1, { plank: 4 }, "workbench", "carpentry", 25, SAW),
  r("bench", 1, { plank: 3 }, "workbench", "carpentry", 15, SAW),
  r("crate", 1, { plank: 3 }, "workbench", "carpentry", 15, SAW),
  r("barrel", 1, { plank: 4, iron: 1 }, "workbench", "carpentry", 30, lvl(15, SAW)),
  r("fence", 2, { plank: 2 }, "workbench", "carpentry", 10, SAW),
  r("wall_wood", 1, { plank: 4 }, "workbench", "carpentry", 20, SAW),
  r("meal", 1, { grain: 2 }, "hearth", "cooking", 15),
  // craftsmen's tools: the hammer is forged without one (someone has to make the first)
  r("hammer", 1, { iron: 2, plank: 1 }, "anvil", "smithing", 25),
  r("saw", 1, { iron: 1, wood: 1 }, "anvil", "smithing", 20, HAMMER),
  r("needle", 1, { iron: 1 }, "anvil", "smithing", 15, HAMMER),
  // clothes: nettle and flax fibre from herbs are spun and woven by hand
  r("cloth", 1, { herbs: 2 }, "hand", "tailoring", 20),
  r("cap", 1, { cloth: 1 }, "hand", "tailoring", 15, NEEDLE),
  r("shirt", 1, { cloth: 2 }, "hand", "tailoring", 25, NEEDLE),
  r("trousers", 1, { cloth: 2 }, "hand", "tailoring", 25, NEEDLE),
  r("svyta", 1, { cloth: 4 }, "workbench", "tailoring", 45, lvl(20, NEEDLE)),
  r("lychaky", 1, { wood: 1 }, "hand", "tailoring", 15),
  r("boots", 1, { cloth: 2, plank: 1 }, "workbench", "tailoring", 35, lvl(10, NEEDLE)),
  // weapons, tools and armour
  r("club", 1, { wood: 2 }, "hand", "carpentry", 10),
  r("shield", 1, { plank: 3, iron: 1 }, "workbench", "carpentry", 30, lvl(10, SAW)),
  r("knife", 1, { iron: 1 }, "anvil", "smithing", 15, HAMMER),
  r("sickle", 1, { iron: 1 }, "anvil", "smithing", 20, HAMMER),
  r("axe", 1, { iron: 1, plank: 1 }, "anvil", "smithing", 25, HAMMER),
  r("shovel", 1, { iron: 1, plank: 1 }, "anvil", "smithing", 20, HAMMER),
  r("pickaxe", 1, { iron: 2, plank: 1 }, "anvil", "smithing", 30, HAMMER),
  r("spear", 1, { iron: 1, plank: 2 }, "anvil", "smithing", 25, lvl(15, HAMMER)),
  r("sword", 1, { iron: 3 }, "anvil", "smithing", 50, lvl(35, HAMMER)),
  r("helmet", 1, { iron: 2 }, "anvil", "smithing", 35, lvl(25, HAMMER)),
  r("chainmail", 1, { iron: 5 }, "anvil", "smithing", 80, lvl(45, HAMMER)),
];

export const RECIPE_BY_OUT: Partial<Record<ItemId, Recipe>> = Object.fromEntries(RECIPES.map((x) => [x.out, x]));

export function recipeById(id: string): Recipe | undefined {
  return RECIPES.find((x) => x.id === id);
}

/** How far from a station one may work. */
export const STATION_RANGE = 1.8;

export function nearStation(map: GameMap, x: number, y: number, st: Station): boolean {
  return st === "hand" || !!findObjNear(map, x, y, STATION_OBJ[st], STATION_RANGE);
}

/** Can this person make the recipe (skill level, tools)? Inputs and station are checked separately. */
export function craftRequirements(rec: Recipe, skill: number | undefined, has: (item: ItemId) => boolean): { ok: boolean; skillShort: number; missingTools: ItemId[] } {
  const skillShort = Math.max(0, (rec.minSkill ?? 0) - Math.floor(skill ?? 0));
  const missingTools = (rec.tools ?? []).filter((t) => !has(t));
  return { ok: skillShort === 0 && !missingTools.length, skillShort, missingTools };
}

export function missingInputs(inv: Inventory, rec: Recipe, times = 1): Partial<Record<ItemId, number>> {
  const out: Partial<Record<ItemId, number>> = {};
  for (const [item, n] of Object.entries(rec.inputs) as [ItemId, number][]) {
    const lack = n * times - (inv[item] ?? 0);
    if (lack > 0) out[item] = lack;
  }
  return out;
}

/** Game minutes a craft takes at a given skill level (novice 1×, master ~2× faster). */
export function craftMinutes(rec: Recipe, skill: number | undefined): number {
  return rec.minutes / (0.8 + Math.max(0, Math.min(100, skill ?? 0)) / 100 * 1.2);
}
