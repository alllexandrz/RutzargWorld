// Item catalogue. Prices are *base* prices; the market adjusts them by stock.

export type ItemId = "wood" | "ore" | "stone" | "grain" | "herbs" | "meal" | "tools" | "sapling";

export interface ItemDef {
  id: ItemId;
  name: string;
  basePrice: number;
  /** Target stock the market considers "normal" — drives price feedback. */
  targetStock: number;
  /** Units the outside world (caravans) buys from the market per game day. */
  dailyExport: number;
  color: string;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  wood: { id: "wood", name: "Деревина", basePrice: 3, targetStock: 40, dailyExport: 18, color: "#9a6b3f" },
  ore: { id: "ore", name: "Руда", basePrice: 4, targetStock: 30, dailyExport: 14, color: "#7d8796" },
  stone: { id: "stone", name: "Камінь", basePrice: 3, targetStock: 30, dailyExport: 6, color: "#a39a8c" },
  grain: { id: "grain", name: "Зерно", basePrice: 2, targetStock: 40, dailyExport: 10, color: "#d8b84a" },
  herbs: { id: "herbs", name: "Трави", basePrice: 5, targetStock: 15, dailyExport: 6, color: "#5fa35a" },
  meal: { id: "meal", name: "Їжа", basePrice: 3, targetStock: 20, dailyExport: 4, color: "#c9774a" },
  sapling: { id: "sapling", name: "Саджанець", basePrice: 2, targetStock: 20, dailyExport: 0, color: "#7ab35a" },
  tools: { id: "tools", name: "Інструменти", basePrice: 18, targetStock: 8, dailyExport: 3, color: "#b7c0c8" },
};

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
