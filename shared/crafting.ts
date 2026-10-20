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
}

const r = (out: ItemId, qty: number, inputs: Recipe["inputs"], station: Station, skill: SkillId, minutes: number): Recipe =>
  ({ id: out, out, qty, inputs, station, skill, minutes });

export const RECIPES: Recipe[] = [
  r("plank", 2, { wood: 1 }, "hand", "carpentry", 6),
  r("workbench", 1, { plank: 6 }, "hand", "carpentry", 30),
  r("forge", 1, { stone: 10, wood: 2 }, "hand", "building", 45),
  r("hearth", 1, { stone: 6, wood: 2 }, "hand", "building", 30),
  r("wall_stone", 1, { stone: 4 }, "hand", "building", 15),
  r("well", 1, { stone: 12, wood: 2 }, "hand", "building", 60),
  r("iron", 1, { ore: 2, wood: 1 }, "forge", "smithing", 15),
  r("anvil", 1, { iron: 4 }, "forge", "smithing", 45),
  r("tools", 1, { iron: 1, plank: 1 }, "anvil", "smithing", 25),
  r("lamp", 1, { iron: 1, plank: 2 }, "anvil", "smithing", 30),
  r("bed", 1, { plank: 6, grain: 2 }, "workbench", "carpentry", 40),
  r("table", 1, { plank: 4 }, "workbench", "carpentry", 25),
  r("bench", 1, { plank: 3 }, "workbench", "carpentry", 15),
  r("crate", 1, { plank: 3 }, "workbench", "carpentry", 15),
  r("barrel", 1, { plank: 4, iron: 1 }, "workbench", "carpentry", 30),
  r("fence", 2, { plank: 2 }, "workbench", "carpentry", 10),
  r("wall_wood", 1, { plank: 4 }, "workbench", "carpentry", 20),
  r("meal", 1, { grain: 2 }, "hearth", "cooking", 15),
  // clothes: nettle and flax fibre from herbs are spun and woven by hand
  r("cloth", 1, { herbs: 2 }, "hand", "tailoring", 20),
  r("cap", 1, { cloth: 1 }, "hand", "tailoring", 15),
  r("shirt", 1, { cloth: 2 }, "hand", "tailoring", 25),
  r("trousers", 1, { cloth: 2 }, "hand", "tailoring", 25),
  r("svyta", 1, { cloth: 4 }, "workbench", "tailoring", 45),
  r("lychaky", 1, { wood: 1 }, "hand", "tailoring", 15),
  r("boots", 1, { cloth: 2, plank: 1 }, "workbench", "tailoring", 35),
  // weapons, tools and armour
  r("club", 1, { wood: 2 }, "hand", "carpentry", 10),
  r("shield", 1, { plank: 3, iron: 1 }, "workbench", "carpentry", 30),
  r("knife", 1, { iron: 1 }, "anvil", "smithing", 15),
  r("sickle", 1, { iron: 1 }, "anvil", "smithing", 20),
  r("axe", 1, { iron: 1, plank: 1 }, "anvil", "smithing", 25),
  r("pickaxe", 1, { iron: 2, plank: 1 }, "anvil", "smithing", 30),
  r("spear", 1, { iron: 1, plank: 2 }, "anvil", "smithing", 25),
  r("sword", 1, { iron: 3 }, "anvil", "smithing", 50),
  r("helmet", 1, { iron: 2 }, "anvil", "smithing", 35),
  r("chainmail", 1, { iron: 5 }, "anvil", "smithing", 80),
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
