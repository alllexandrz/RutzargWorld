// An owner goes offline: the business keeps producing, selling and paying; on return the
// player gets a "while you were away" report. Usage: node scripts/offline-test.ts

import { World } from "../server/sim/world.ts";
import { awaySummary, createPlayer } from "../server/sim/players.ts";
import { hire, sellFromStock } from "../server/sim/economy.ts";
import { playerBiz } from "../server/sim/players.ts";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) failures++; };

const w = new World();
const p = createPlayer(w, "p1", "Власник", "t", { body: "#000", hair: "#000", skin: "#000" }, "m");
const b = w.businesses.get("sawmill_old")!;
b.ownerId = p.id; b.forSale = null; p.ownedBusinesses.push(b.id);
b.treasury = 0; // empty till: only the owner's purse can pay
b.wage = 10;
p.coins = 300;
const workers = [...w.agents.values()].filter((a) => a.kind === "npc" && a.bornAt === undefined && a.profession !== "moneylender" && a.jobBiz !== "guard" && ![...w.businesses.values()].some((x) => x.ownerId === a.id)).slice(0, 2);
for (const a of workers) hire(w, b, a);
p.online = false; p.offlineSince = w.time;

for (let i = 0; i < 3 * 1440 * 20; i++) { w.tick(0.05); w.pendingTiles.length = 0; }

const days = b.ledger ?? [];
const sum = (k: "made" | "sold" | "revenue" | "wages" | "unpaid") => days.reduce((n, d) => n + d[k], 0);
check("вироблялося без власника", sum("made") > 0, `вироблено ${Math.floor(sum("made"))}`);
check("продавалося без власника", sum("sold") > 0, `продано ${sum("sold")} за ${sum("revenue")}`);
check("платню виплачено (доплата з гаманця)", sum("unpaid") === 0 && sum("wages") > 0, `платня ${sum("wages")}, гаманець ${p.coins}`);
// (someone may still be poached for a better wage — that's the labour market, not a bug)
check("ніхто не лишився без платні", !w.chronicle.some((e) => e.text.includes("Стара лісопилка") && e.text.includes("не змогла заплатити")));
const report = awaySummary(w, p);
check("звіт «поки тебе не було»", report.length > 0 && report[0].text.includes("Стара лісопилка"), report[0]?.text);
check("повідомлення не загубилися", report.length > 1, `${report.length} шт.`);
// Expensive payroll the sales can't cover → the purse pays (autoPay), or nobody does when it's off.
for (const autoPay of [true, false]) {
  const w2 = new World();
  const p2 = createPlayer(w2, "p2", "Щедрий", "t", { body: "#000", hair: "#000", skin: "#000" }, "f");
  const b2 = w2.businesses.get("sawmill_old")!;
  b2.ownerId = p2.id; b2.forSale = null; p2.ownedBusinesses.push(b2.id);
  b2.treasury = 0; b2.wage = 40; b2.autoPay = autoPay; p2.coins = 500;
  const ws = [...w2.agents.values()].filter((a) => a.kind === "npc" && a.bornAt === undefined && a.profession !== "moneylender" && a.jobBiz !== "guard" && ![...w2.businesses.values()].some((x) => x.ownerId === a.id)).slice(0, 2);
  for (const a of ws) hire(w2, b2, a);
  p2.online = false; p2.offlineSince = w2.time;
  for (let i = 0; i < 1440 * 20; i++) { w2.tick(0.05); w2.pendingTiles.length = 0; }
  const unpaid = (b2.ledger ?? []).reduce((n, d) => n + d.unpaid, 0);
  if (autoPay) check("доплата з гаманця, коли виручки мало", unpaid === 0 && p2.coins < 500, `гаманець 500 → ${p2.coins}`);
  else check("без доплати — невиплата (як і раніше)", unpaid > 0, `невиплат ${unpaid}`);
}

// Glutted market: 160 wood in town, 250 in the yard → other ways to sell
{
  const w3 = new World();
  const p3 = createPlayer(w3, "p3", "Лісник", "t", { body: "#000", hair: "#000", skin: "#000" }, "m");
  const b3 = w3.businesses.get("sawmill_old")!;
  b3.ownerId = p3.id; b3.forSale = null; p3.ownedBusinesses.push(b3.id);
  b3.stock.wood = 250; b3.treasury = 0;
  w3.market.stock.wood = 160;
  const m = sellFromStock(w3, b3, "wood", 50, "market");
  check("ринок переповнений — відмова з поясненням", !m.ok, m.ok ? "" : m.reason);
  const c = sellFromStock(w3, b3, "wood", 250, "caravan");
  check("оптовики купують частину", c.ok && b3.stock.wood! < 250 && b3.treasury > 0, `склад ${b3.stock.wood}, каса ${b3.treasury}`);
  const c2 = sellFromStock(w3, b3, "wood", 10, "caravan");
  check("ліміт оптовиків на день", !c2.ok);
  p3.x = w3.map.areas[b3.area].x + 1; p3.y = w3.map.areas[b3.area].y + 1;
  playerBiz(w3, p3, "takeStock", b3.id, 20, undefined, "wood");
  check("забрати деревину собі в сумку", p3.inv.wood === 20);
  playerBiz(w3, p3, "process", b3.id, 1);
  const ws3 = [...w3.agents.values()].filter((a) => a.kind === "npc" && a.bornAt === undefined && a.profession !== "moneylender" && a.jobBiz !== "guard" && ![...w3.businesses.values()].some((x) => x.ownerId === a.id)).slice(0, 2);
  for (const a of ws3) hire(w3, b3, a);
  p3.coins = 200;
  const before = b3.stock.wood!;
  for (let i = 0; i < 1440 * 20; i++) { w3.tick(0.05); w3.pendingTiles.length = 0; }
  const sold = (b3.ledger ?? []).reduce((n, d) => n + d.sold, 0);
  check("переробка: колоди → дошки, дошки продаються", (b3.stock.wood ?? 0) < before && sold > 0, `деревина ${before} → ${b3.stock.wood}, дошок продано ${sold}, на ринку дошок ${w3.marketStock("plank")}`);
}

console.log(failures ? `\n${failures} перевірок не пройшло` : "\nУсі перевірки пройдено");
process.exit(failures ? 1 : 0);
