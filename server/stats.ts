// Daily world statistics (economy, population, nature) — stored in the database for analysis/balancing.

import type { World } from "./sim/world.ts";
import type { DailyStats } from "./storage.ts";
import { ITEM_IDS, marketPrice } from "../shared/items.ts";
import { isChild } from "./sim/family.ts";
import { surfaceCounts } from "./sim/resources.ts";

export function computeStats(w: World): DailyStats {
  const npcs = [...w.agents.values()].filter((a) => a.kind === "npc");
  return {
    day: Math.floor(w.time / 1440) + 1,
    gameTime: Math.floor(w.time),
    population: npcs.length,
    children: npcs.filter((a) => isChild(w, a)).length,
    playersTotal: w.players.size,
    playersOnline: [...w.players.values()].filter((p) => p.online).length,
    townTreasury: Math.round(w.townTreasury),
    market: Object.fromEntries(ITEM_IDS.map((id) => [id, { stock: w.marketStock(id), price: marketPrice(id, w.marketStock(id)) }])),
    businesses: [...w.businesses.values()].map((b) => ({
      id: b.id, name: b.name, owner: w.nameOf(b.ownerId), workers: b.workers.length, wage: b.wage, treasury: Math.round(b.treasury),
    })),
    houses: Object.values(w.map.plotStage).filter((s) => s === "built").length,
    deposits: { ...w.res.deposits },
    surface: surfaceCounts(w),
  };
}
