// Tools, repair and loans (headless): nothing is gathered bare-handed, tools wear out and break,
// workshops repair them for money, NPC workers need the tool of their trade, players borrow at interest.
// Usage: node scripts/tools-test.ts

import { World } from "../server/sim/world.ts";
import { createPlayer, playerAct, tickPlayers } from "../server/sim/players.ts";
import { discard, repairItem, repairQuote, supplyTool, toolFor } from "../server/sim/gear.ts";
import { borrow, loanTerms, onDayLoans, repay } from "../server/sim/loans.ts";
import { usesLeft, usesOf } from "../shared/gear.ts";
import { START_COINS } from "../shared/constants.ts";
import { O, idx, isWalkable } from "../shared/map.ts";
import { onHour } from "../server/sim/economy.ts";
import { jail } from "../server/sim/brain.ts";
import { assignPlan, craftOnce } from "../server/sim/crafting.ts";
import { recipeById } from "../shared/crafting.ts";
import { hasItem } from "../server/sim/gear.ts";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) failures++; };
const look = { body: "#445566", hair: "#221100", skin: "#ddaa88" };
const finishBusy = (w: World, p: ReturnType<typeof createPlayer>) => { if (p.busy) { p.busy.start = Date.now() - p.busy.dur - 1; tickPlayers(w, 0.05); } };
const nearTree = (w: World) => {
  for (let y = 15; y < 60; y++) for (let x = 45; x < 100; x++)
    if (w.map.obj[idx(x, y)] === O.TREE && isWalkable(w.map, x, y + 1)) return { x: x + 0.5, y: y + 1.5 };
  throw new Error("no tree");
};

// 1) Gathering needs a tool; the tool wears per use and breaks
{
  const w = new World();
  const p = createPlayer(w, "p1", "Лісоруб", "tok", look, "m");
  check("стартових грошей вистачає на знаряддя", START_COINS >= 40, `${START_COINS} срібла`);
  Object.assign(p, nearTree(w));
  playerAct(w, p, "gather");
  check("голими руками дерево не зрубати", !p.busy);
  p.inv.axe = 1;
  playerAct(w, p, "gather");
  check("сокира з сумки сама береться в руку", p.busy?.kind === "gather" && p.equip?.weapon?.item === "axe");
  finishBusy(w, p);
  check("+1 деревина", (p.inv.wood ?? 0) >= 1);
  check("міцність зменшилась на одне використання", usesLeft(p.equip!.weapon!) === usesOf("axe") - 1, `${usesLeft(p.equip!.weapon!)}/${usesOf("axe")}`);
  p.busy = null;
  p.equip!.weapon!.dur = 100 / usesOf("axe") * 0.5; // half a use left
  playerAct(w, p, "gather");
  finishBusy(w, p);
  check("зношена сокира ламається", !p.equip?.weapon && !p.busy, JSON.stringify(p.equip?.weapon));
  p.inv.sapling = 1;
  playerAct(w, p, "plant");
  check("без лопати не посадити", (p.inv.sapling ?? 0) === 1);
}

// 2) Repair at someone else's workshop (paid) and discarding
{
  const w = new World();
  const p = createPlayer(w, "p2", "Ремонт", "tok", look, "m");
  p.coins = 100;
  p.inv.pickaxe = 1;
  toolFor(w, p, "ore");
  p.equip!.weapon!.dur = 30;
  check("далеко від кузні — не лагодять", !repairQuote(w, p, "weapon"));
  p.x = 8.5; p.y = 19.5; // by Ulf's anvil
  const q = repairQuote(w, p, "weapon");
  check("у кузні Ульфа називають ціну", !!q && !q.self && q.cost > 0, q ? `${q.cost} срібла, ${q.where}` : "");
  const smithy = w.businesses.get("smithy")!;
  const t0 = smithy.treasury, c0 = p.coins;
  const r = repairItem(w, p, "weapon");
  check("полагоджено за гроші кузні", r.ok && p.equip!.weapon!.dur === 100 && p.coins === c0 - q!.cost && smithy.treasury === t0 + q!.cost, r.reason);
  // Ulf fixes his own things at his own anvil: materials only
  const ulf = w.agents.get("ulf")!;
  ulf.x = 8.5; ulf.y = 19.5; ulf.equip!.weapon = { item: "knife", dur: 20 };
  const uq = repairQuote(w, ulf, "weapon");
  check("на своїй станції — дешевше (лише матеріали)", !!uq && uq.self && uq.cost < Math.ceil(16 * 0.8 * 0.6), uq ? `${uq.cost}` : "");
  check("викинути річ зі слоту", discard(w, p, { slot: "weapon" }).ok && !p.equip?.weapon);
}

// 3) NPC workers: no tool — no work; the business hands one out from its till
{
  const w = new World();
  const thomas = w.agents.get("thomas")!;
  const job = w.businesses.get(thomas.jobBiz!)!;
  check("шахтар Томас має кайло від початку", toolFor(w, thomas, "ore") === "pickaxe" || !["mine", "quarry"].includes(job.kind), `${job.kind}: ${thomas.equip?.weapon?.item}`);
  delete thomas.equip!.weapon;
  job.treasury = 200;
  const ok = supplyTool(w, job, thomas);
  check("справа купує працівнику знаряддя з каси", ok && !!(thomas.equip as { weapon?: unknown }).weapon && job.treasury < 200, `${(thomas.equip as { weapon?: { item: string } }).weapon?.item}, каса ${job.treasury}`);
  delete thomas.equip!.weapon;
  job.treasury = 0; job.ownerId = "marcus";
  w.market.stock.pickaxe = 0; w.market.stock.axe = 0;
  const before = job.stock[job.product!] ?? 0;
  const area = w.map.areas[job.area];
  for (const id of job.workers) {
    const b = w.agents.get(id);
    if (!b) continue;
    if (b.equip) delete b.equip.weapon;
    b.inv.pickaxe = 0; b.inv.axe = 0;
    b.x = area.x + area.w / 2; b.y = area.y + area.h / 2;
    b.activity = { type: "work", label: "працює", biz: job.id, started: w.time };
  }
  onHour(w, 10);
  check("без знаряддя не працює", (job.stock[job.product!] ?? 0) === before && w.chronicle.some((e) => e.text.includes("не може працювати")), `${before} → ${job.stock[job.product!]}`);
}

// 4) Loans: the moneylender, a friend, overdue debts and debtors' prison
{
  const w = new World();
  const p = createPlayer(w, "p4", "Боржник", "tok", look, "m");
  p.coins = 0;
  const horst = w.agents.get("horst")!;
  const t = loanTerms(w, horst, p);
  check("лихвар позичає під відсотки", t.max > 0 && t.rate > 0.2, `до ${t.max}, ${Math.round(t.rate * 100)}%, ${t.days} дн.`);
  const r = borrow(w, horst, p, 30);
  check("позичив 30", r.ok && p.coins === 30 && (p.loans?.[0]?.owe ?? 0) > 30, r.reply);
  const lira = w.agents.get("lira")!;
  check("незнайома людина в борг не дає", loanTerms(w, lira, p).max === 0, loanTerms(w, lira, p).why);
  // overdue: penalty, gossip, then the guards
  const owe0 = p.loans![0].owe;
  w.time = p.loans![0].due + 1;
  onDayLoans(w);
  check("прострочений борг росте", p.loans![0].owe > owe0, `${owe0} → ${p.loans![0].owe}`);
  onDayLoans(w); onDayLoans(w);
  const guards = [...w.agents.values()].filter((g) => g.jobBiz === "guard");
  check("кредитор пішов до варти", guards.some((g) => g.goals.some((x) => x.id.startsWith(`arrest:${p.id}:debt#`))));
  p.coins = 20;
  jail(w, p, guards[0], "несплату боргу");
  check("у в'язниці стягують з гаманця", p.coins === 0 && horst.coins > 0, `борг ${p.loans?.[0]?.owe}`);
  p.coins = 200;
  const rr = repay(w, horst, p);
  check("борг віддано повністю", rr.ok && !(p.loans ?? []).length, rr.reply);
}

// 5) Crafting requirements: tools and a minimum skill
{
  const w = new World();
  const p = createPlayer(w, "p5", "Учень", "tok", look, "m");
  p.coins = 500;
  p.x = 8.5; p.y = 19.5; // by Ulf's anvil
  p.inv.iron = 10;
  const knife = recipeById("knife")!;
  const r1 = craftOnce(w, p, knife);
  check("без молота на ковадлі не кують", !r1.ok && /інструмент/i.test(r1.reason ?? ""), r1.reason);
  p.inv.hammer = 1;
  const r2 = craftOnce(w, p, knife);
  check("з молотом у сумці — кують", r2.ok && (p.inv.knife ?? 0) === 1, r2.reason);
  check("молот зношується від роботи", (p.worn?.hammer?.[0] ?? 100) < 100, JSON.stringify(p.worn));
  const sword = recipeById("sword")!;
  const r3 = craftOnce(w, p, sword);
  check("меч новачкові не дається (ковальство ≥ 35)", !r3.ok && /вміння/.test(r3.reason ?? ""), r3.reason);
  p.skills.smithing = 40;
  const r4 = craftOnce(w, p, sword);
  check("досвідчений коваль кує меч", r4.ok && (p.inv.sword ?? 0) === 1, r4.reason);
  // a hammer with one use left breaks after the next batch
  p.worn = { hammer: [100 / usesOf("hammer") * 0.5] };
  p.inv.hammer = 1;
  craftOnce(w, p, knife);
  check("зношений молот ламається", !(p.inv.hammer ?? 0));
}

// 6) NPCs: get the tool first, buy what they can't make yet
{
  const w = new World();
  const a = w.agents.get("kaya")!;
  a.coins = 400; a.inv = {};
  delete a.skills.smithing;
  w.market.stock.knife = 0;
  assignPlan(w, a, { item: "knife", qty: 1, use: { kind: "keep" }, payer: "self", label: "тест: ніж", priority: 0.9 });
  let ok = false;
  for (let i = 0; i < 2 * 1440 * 20 && !ok; i++) { w.tick(0.05); w.pendingTiles.length = 0; ok = (a.inv.knife ?? 0) > 0 || !a.craftPlan; }
  check("NPC спершу дістає молот, потім кує ніж", (a.inv.knife ?? 0) > 0 && hasItem(a, "hammer"), `ніж ${a.inv.knife ?? 0}, молот ${hasItem(a, "hammer")}, план ${a.craftPlan?.label ?? "—"}`);
  const b = w.agents.get("toren")!;
  b.coins = 400; b.inv = {}; b.skills.smithing = 0;
  w.market.stock.sword = 0;
  assignPlan(w, b, { item: "sword", qty: 1, use: { kind: "keep" }, payer: "self", label: "тест: меч", priority: 0.9 });
  for (let i = 0; i < 1440 * 20 && b.craftPlan; i++) { w.tick(0.05); w.pendingTiles.length = 0; }
  check("NPC без вміння меча не кує", !(b.inv.sword ?? 0), w.chronicle.filter((e) => e.text.includes("Торен кидає задум")).map((e) => e.text).slice(-1)[0] ?? "");
}

console.log(failures ? `\n${failures} перевірок не пройдено` : "\nУсі перевірки пройдено");
process.exit(failures ? 1 : 0);
