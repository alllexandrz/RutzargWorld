// Item catalogue. Prices are *base* prices; the market adjusts them by stock.

export type ItemId =
  // raw resources & food
  | "wood" | "ore" | "stone" | "grain" | "herbs" | "meal" | "sapling"
  // processed materials
  | "plank" | "iron" | "tools" | "cloth"
  // placeable things (furniture, buildings parts, stations)
  | "bed" | "table" | "bench" | "crate" | "barrel" | "fence" | "wall_wood" | "wall_stone"
  | "lamp" | "workbench" | "forge" | "anvil" | "hearth" | "well"
  // things worn or held (shared/gear.ts)
  | "cap" | "helmet" | "shirt" | "svyta" | "chainmail" | "trousers" | "lychaky" | "boots"
  | "club" | "knife" | "axe" | "pickaxe" | "sickle" | "shovel" | "spear" | "sword" | "shield";

export type ItemGroup = "raw" | "material" | "placeable" | "wear";

/** Where a worn / held item goes. */
export type Slot = "head" | "body" | "legs" | "feet" | "weapon" | "offhand";

export interface GearStats {
  attack?: number;
  armor?: number;
  /** How well-dressed / imposing — people judge by looks. */
  presence?: number;
  /** Gathering / work speed bonus per resource (0.5 = +50%). */
  gather?: Partial<Record<ItemId, number>>;
}

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
  /** Wearable items: the slot and what it gives. */
  slot?: Slot;
  stats?: GearStats;
  /** Tools: how many uses (gathered units / work) a new one lasts. */
  uses?: number;
}

// Object ids mirror shared/map.ts `O` (kept as literals: map.ts must not depend on items.ts and vice versa).
const OBJ = { TABLE: 7, BED: 9, ANVIL: 10, CRATE: 12, BARREL: 14, WELL: 15, FENCE: 17, LAMP: 18, BENCH: 21, FORGE: 22, HEARTH: 23, WALL_WOOD: 27, WALL_STONE: 28, WORKBENCH: 29 };

const raw = (id: ItemId, name: string, basePrice: number, targetStock: number, dailyExport: number, color: string): ItemDef =>
  ({ id, name, basePrice, targetStock, dailyExport, color, group: "raw" });
const mat = (id: ItemId, name: string, basePrice: number, targetStock: number, dailyExport: number, color: string): ItemDef =>
  ({ id, name, basePrice, targetStock, dailyExport, color, group: "material" });
const put = (id: ItemId, name: string, basePrice: number, obj: number, color: string, targetStock = 4): ItemDef =>
  ({ id, name, basePrice, targetStock, dailyExport: 1, color, group: "placeable", obj });

const wear = (id: ItemId, name: string, basePrice: number, slot: Slot, stats: GearStats, color: string): ItemDef =>
  ({ id, name, basePrice, targetStock: 4, dailyExport: 1, color, group: "wear", slot, stats });

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
  cloth: mat("cloth", "Полотно", 5, 20, 4, "#d9cfb4"),
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
  cap: wear("cap", "Шапка", 6, "head", { presence: 1 }, "#7a5a3a"),
  helmet: wear("helmet", "Шолом", 34, "head", { armor: 3, presence: 1 }, "#9aa4ae"),
  shirt: wear("shirt", "Сорочка", 11, "body", { presence: 2 }, "#e8e0cc"),
  svyta: wear("svyta", "Свита", 24, "body", { armor: 1, presence: 4 }, "#8a6a4a"),
  chainmail: wear("chainmail", "Кольчуга", 80, "body", { armor: 6, presence: 2 }, "#8e98a2"),
  trousers: wear("trousers", "Штани", 10, "legs", { presence: 1 }, "#6a5a48"),
  lychaky: wear("lychaky", "Личаки", 3, "feet", { armor: 0.5 }, "#b49a6a"),
  boots: wear("boots", "Чоботи", 16, "feet", { armor: 1, presence: 2 }, "#4a3a2a"),
  club: wear("club", "Кийок", 4, "weapon", { attack: 3 }, "#7a5a32"),
  knife: { ...wear("knife", "Ніж", 16, "weapon", { attack: 4, gather: { herbs: 0.3 } }, "#b8c0c8"), uses: 100 },
  axe: { ...wear("axe", "Сокира", 22, "weapon", { attack: 5, gather: { wood: 0.6 } }, "#a8b0b8"), uses: 150 },
  pickaxe: { ...wear("pickaxe", "Кайло", 34, "weapon", { attack: 4, gather: { ore: 0.6, stone: 0.6 } }, "#98a0a8"), uses: 150 },
  sickle: { ...wear("sickle", "Серп", 16, "weapon", { attack: 2, gather: { grain: 0.6, herbs: 0.4 } }, "#c0c8d0"), uses: 120 },
  shovel: { ...wear("shovel", "Лопата", 14, "weapon", { attack: 3, gather: { sapling: 0.5 } }, "#9a8a6a"), uses: 120 },
  spear: wear("spear", "Спис", 22, "weapon", { attack: 7 }, "#a08a5a"),
  sword: wear("sword", "Меч", 48, "weapon", { attack: 10, presence: 2 }, "#d0d8e0"),
  shield: wear("shield", "Щит", 26, "offhand", { armor: 4 }, "#8a5a32"),
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
