// Crafting scenarios (headless): NPCs making what they need, and the player-side rules.
// Usage: node scripts/craft-test.ts

import { World } from "../server/sim/world.ts";
import { bedsIn, idx, O } from "../shared/map.ts";
import { bedsShort, startProject } from "../server/sim/construction.ts";
import { craftOnce, pickupNear, placeItem } from "../server/sim/crafting.ts";
import { recipeById } from "../shared/crafting.ts";
import { createPlayer } from "../server/sim/players.ts";
import { leaveJob } from "../server/sim/economy.ts";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) failures++; };
const run = (w: World, minutes: number, until?: () => boolean) => {
  for (let i = 0; i < minutes * 20; i++) { w.tick(0.05); w.pendingTiles.length = 0; if (until && i % 20 === 0 && until()) return true; }
  return until ? until() : true;
};
const craftLog = (w: World) => w.chronicle.filter((e) => e.kind === "craft").map((e) => e.text);

// 1) Overcrowded home → someone makes a bed and puts it there
{
  const w = new World();
  const home = "house_1";
  const before = bedsIn(w.map, home);
  w.market.stock.bed = 0; // nothing to buy — they must make it
  // two single adults move in → more people than beds
  const movers = [...w.agents.values()].filter((a) => a.kind === "npc" && a.home !== home && !a.spouse && a.bornAt === undefined).slice(0, before + 1);
  for (const a of movers) { a.home = home; a.coins += 40; }
  check("дім переповнений", bedsShort(w, home) > 0, `ліжок ${before}, бракує ${bedsShort(w, home)}`);
  const ok = run(w, 2 * 1440, () => bedsIn(w.map, home) > before);
  check("NPC змайстрував і поставив ліжко вдома", ok, craftLog(w).slice(0, 4).join(" | "));
}

// 2) Builders make crafted materials the market lacks
{
  const w = new World();
  w.market.stock.bed = 0;
  w.townTreasury += 500;
  const plot = w.map.plots.find((p) => p.kind === "house" && w.map.plotStage[p.id] === "empty")!;
  startProject(w, plot.id, "town");
  const ok = run(w, 3 * 1440, () => (w.projects[0]?.delivered.bed ?? 0) >= 1 || w.map.plotStage[plot.id] === "built");
  check("будівельник сам зробив ліжко для будови", ok, craftLog(w).slice(0, 3).join(" | "));
}

// 3) Unemployed NPC crafts for the market
{
  const w = new World();
  const a = [...w.agents.values()].find((x) => x.jobBiz && x.kind === "npc" && w.businesses.get(x.jobBiz)?.ownerId !== x.id)!;
  leaveJob(w, a, "quit");
  a.coins = 60;
  a.socialClass = "ARCANE"; a.skills = {}; // nobody hires them → they live by their hands
  w.market.stock.bench = 0; w.market.stock.table = 0; w.market.stock.crate = 0;
  const ok = run(w, 1440, () => craftLog(w).some((t) => t.includes("продає")));
  check("безробітний майструє на продаж", ok, craftLog(w).filter((t) => t.includes(a.name)).slice(0, 3).join(" | "));
}

// 4) Player rules: craft at stations, place, dismantle, theft
{
  const w = new World();
  const p = createPlayer(w, "p1", "Тестер", "tok", { body: "#000", hair: "#000", skin: "#000" }, "m");
  p.inv = { wood: 10, stone: 4, grain: 2, saw: 1 }; // furniture needs a saw
  p.x = 8.5; p.y = 32.2; // next to the public workbench in the warehouse (8,33)
  check("дошки руками", craftOnce(w, p, recipeById("plank")!).ok && p.inv.plank === 2);
  for (let i = 0; i < 2; i++) craftOnce(w, p, recipeById("plank")!);
  check("стіл на верстаку", craftOnce(w, p, recipeById("table")!).ok && p.inv.table === 1);
  p.x = 60.5; p.y = 60.5;
  check("без верстака стіл не зробити", !craftOnce(w, p, recipeById("table")!).ok);
  check("кам'яна стіна руками", craftOnce(w, p, recipeById("wall_stone")!).ok);
  // find free outdoor tile next to the player
  let spot: { x: number; y: number } | null = null;
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [0, 2]]) {
    const r = placeItem(w, p, "wall_stone", 60 + dx, 60 + dy);
    if (r.ok) { spot = { x: 60 + dx, y: 60 + dy }; break; }
  }
  check("стіну поставлено", !!spot && w.map.obj[idx(spot.x, spot.y)] === O.WALL_STONE, JSON.stringify(spot));
  const back = pickupNear(w, p);
  check("свою стіну розібрано без злочину", back.ok && !back.stolenFrom && p.inv.wall_stone === 1);
  // someone else's lamp
  const lamp = Object.entries(w.res.placed).length;
  void lamp;
  p.x = 69.5; p.y = 34.2; // near the street lamps at (68..84, 33)
  const before = w.chronicle.filter((e) => e.kind === "crime").length;
  const stolen = pickupNear(w, p);
  check("чужий ліхтар — крадіжка", stolen.ok && !!stolen.stolenFrom && w.chronicle.filter((e) => e.kind === "crime").length > before, stolen.reason ?? stolen.stolenFrom);
  // indoor rule
  p.inv.table = 1;
  const tav = w.map.areas.tavern;
  p.x = tav.x + 1.5; p.y = tav.y + 1.5;
  check("у чужому домі ставити не можна", !placeItem(w, p, "table", tav.x + 2, tav.y + 2).ok);
}

console.log(failures ? `\n${failures} перевірок не пройшло` : "\nУсі перевірки пройдено");
process.exit(failures ? 1 : 0);
