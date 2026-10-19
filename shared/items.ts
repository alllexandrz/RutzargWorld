// Item catalogue. Prices are *base* prices; the market adjusts them by stock.

export type ItemId =
  // raw resources & food
  | "wood" | "ore" | "stone" | "grain" | "herbs" | "meal" | "sapling"
  // processed materials
  | "plank" | "iron" | "tools"
  // placeable things (furniture, buildings parts, stations)
  | "bed" | "table" | "bench" | "crate" | "barrel" | "fence" | "wall_wood" | "wall_stone"
  | "lamp" | "workbench" | "forge" | "anvil" | "hearth" | "well";

export type ItemGroup = "raw" | "material" | "placeable";

export interface ItemDef {
  id: ItemId;
  name: string;
  basePrice: number;
  /** Target stock the market considers "normal" — drives price feedback. */
  targetStock: number;
  /** Units the outside world (caravans) buys from the market per game day. */
  dailyExport: number;
  color: string;
  group: ItemGroup;
  /** Placeable items: the map object (shared/map.ts `O`) it becomes when put down. */
  obj?: number;
}

// Object ids mirror shared/map.ts `O` (kept as literals: map.ts must not depend on items.ts and vice versa).
const OBJ = { TABLE: 7, BED: 9, ANVIL: 10, CRATE: 12, BARREL: 14, WELL: 15, FENCE: 17, LAMP: 18, BENCH: 21, FORGE: 22, HEARTH: 23, WALL_WOOD: 27, WALL_STONE: 28, WORKBENCH: 29 };

const raw = (id: ItemId, name: string, basePrice: number, targetStock: number, dailyExport: number, color: string): ItemDef =>
  ({ id, name, basePrice, targetStock, dailyExport, color, group: "raw" });
const mat = (id: ItemId, name: string, basePrice: number, targetStock: number, dailyExport: number, color: string): ItemDef =>
  ({ id, name, basePrice, targetStock, dailyExport, color, group: "material" });
const put = (id: ItemId, name: string, basePrice: number, obj: number, color: string, targetStock = 4): ItemDef =>
  ({ id, name, basePrice, targetStock, dailyExport: 1, color, group: "placeable", obj });

export const ITEMS: Record<ItemId, ItemDef> = {
  wood: raw("wood", "Деревина", 3, 40, 18, "#9a6b3f"),
  ore: raw("ore", "Руда", 4, 30, 14, "#7d8796"),
  stone: raw("stone", "Камінь", 3, 30, 6, "#a39a8c"),
  grain: raw("grain", "Зерно", 2, 40, 10, "#d8b84a"),
  herbs: raw("herbs", "Трави", 5, 15, 6, "#5fa35a"),
  meal: raw("meal", "Їжа", 3, 20, 4, "#c9774a"),
  sapling: { ...raw("sapling", "Саджанець", 2, 20, 0, "#7ab35a") },
  plank: mat("plank", "Дошки", 2, 30, 3, "#c89a62"),
  iron: mat("iron", "Залізо", 14, 10, 3, "#8e9aa6"),
  tools: mat("tools", "Інструменти", 18, 8, 3, "#b7c0c8"),
  bed: put("bed", "Ліжко", 22, OBJ.BED, "#8a7a6a"),
  table: put("table", "Стіл", 12, OBJ.TABLE, "#7a5230"),
  bench: put("bench", "Лава", 9, OBJ.BENCH, "#8a6a3a"),
  crate: put("crate", "Скриня", 9, OBJ.CRATE, "#8a6a3a"),
  barrel: put("barrel", "Діжка", 28, OBJ.BARREL, "#6e4a2a"),
  fence: put("fence", "Огорожа", 3, OBJ.FENCE, "#9a7a4a", 12),
  wall_wood: put("wall_wood", "Дерев'яна стіна", 11, OBJ.WALL_WOOD, "#8a6038", 10),
  wall_stone: put("wall_stone", "Кам'яна стіна", 15, OBJ.WALL_STONE, "#8f877a", 10),
  lamp: put("lamp", "Вуличний ліхтар", 24, OBJ.LAMP, "#e8b860"),
  workbench: put("workbench", "Верстак", 16, OBJ.WORKBENCH, "#a07040", 2),
  forge: put("forge", "Горно", 45, OBJ.FORGE, "#c0502a", 2),
  anvil: put("anvil", "Ковадло", 70, OBJ.ANVIL, "#5a5a64", 2),
  hearth: put("hearth", "Вогнище", 30, OBJ.HEARTH, "#d0703a", 2),
  well: put("well", "Колодязь", 55, OBJ.WELL, "#7a8a9a", 1),
};

/** The placeable item that a map object comes from (for dismantling). */
export function itemForObj(obj: number): ItemId | null {
  for (const def of Object.values(ITEMS)) if (def.obj === obj) return def.id;
  return null;
}

export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

export type Inventory = Partial<Record<ItemId, number>>;

export function invCount(inv: Inventory, item: ItemId): number {
  return inv[item] ?? 0;
}

export function invAdd(inv: Inventory, item: ItemId, n: number): void {
  const v = (inv[item] ?? 0) + n;
  if (v <= 0) delete inv[item];
  else inv[item] = v;
}

/** Market price for one unit given current stock: scarce → expensive, glut → cheap. */
export function marketPrice(item: ItemId, stock: number): number {
  const def = ITEMS[item];
  const ratio = stock / def.targetStock;
  const mult = Math.max(0.4, Math.min(2.5, 1.6 - 0.6 * ratio));
  return Math.max(1, Math.round(def.basePrice * mult));
}

/** Price the market pays when buying from a seller (spread). */
export function marketBuyPrice(item: ItemId, stock: number): number {
  return Math.max(1, Math.floor(marketPrice(item, stock) * 0.8));
}
