// Lodging and workshop fees (headless): owners and rents, NPCs paying and being evicted,
// players renting a bed / a whole house, sleeping at home vs. dozing, paying to use someone else's station.
// Usage: node scripts/housing-test.ts

import { World } from "../server/sim/world.ts";
import { createPlayer, playerAct, playerBiz } from "../server/sim/players.ts";
import { bedsUsed, residents } from "../server/sim/construction.ts";
import { adjustRents, bedPrice, closedToNewcomers, hasWorkshop, leaveLodging, livesFree, lodgingOffers, markNoBed, nightlyRent, onHourLodging, rentLodging, setLetting, workshopAt } from "../server/sim/housing.ts";
import { tickNeeds } from "../server/sim/needs.ts";
import { buildHour, commissionPlot, onDayHousing } from "../server/sim/construction.ts";
import { placeItem } from "../server/sim/crafting.ts";
import { craftOnce } from "../server/sim/crafting.ts";
import { recipeById } from "../shared/crafting.ts";
import { O, randomSpotIn } from "../shared/map.ts";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) failures++; };
const toHour = (w: World, h: number) => { const target = Math.ceil((w.time - h * 60) / 1440) * 1440 + h * 60 + 1; while (w.time < target) { w.tick(0.05); w.pendingTiles.length = 0; } };
const look = { body: "#445566", hair: "#221100", skin: "#ddaa88" };
const used = (w: World) => (a: string) => bedsUsed(w, a);
const put = (w: World, b: { x: number; y: number }, area: string) => { const s = randomSpotIn(w.map, w.map.areas[area]); b.x = s.x; b.y = s.y; };

// 1) Owners and nightly rent
{
  const w = new World();
  check("у кожного дому є власник", w.homes.tavern?.biz === "tavern" && w.homes.house_5?.owner === "horst", JSON.stringify(w.homes.house_5));
  const kaya = w.agents.get("kaya")!, horst = w.agents.get("horst")!;
  check("Кая платить за ліжко Горсту, Горст — ні", !livesFree(w, kaya, "house_5") && livesFree(w, horst, "house_5"));
  kaya.coins = 20;
  const k0 = kaya.coins, h0 = horst.coins, price = bedPrice(w, "house_5");
  nightlyRent(w);
  check("Кая заплатила за ніч", kaya.coins === k0 - price, `${k0} → ${kaya.coins}, ціна ${price}`);
  check("гроші отримав Горст", horst.coins === h0 + price, `${h0} → ${horst.coins}`);
  toHour(w, 21);
  check("о 21:00 плата знімається сама", horst.coins > h0 + price, `${horst.coins}`);
}

// 2) An NPC who can't pay runs up a debt and gets evicted to the tavern
{
  const w = new World();
  const kaya = w.agents.get("kaya")!;
  kaya.coins = 0; kaya.jobBiz = null;
  for (const b of w.businesses.values()) b.workers = b.workers.filter((x) => x !== kaya.id);
  for (let n = 0; n < 10 && kaya.home !== "tavern"; n++) { kaya.coins = 0; nightlyRent(w); }
  check("боржницю виселили в таверну", kaya.home === "tavern", `дім ${kaya.home}, борг ${kaya.flags.rentDebt}`);
  check("Горст пам'ятає борг", (w.agents.get("horst")!.relations[kaya.id]?.debt ?? 0) < 0 || (w.agents.get("horst")!.relations[kaya.id]?.trust ?? 0) < 0);
}

// 3) A player rents a bed in the tavern
{
  const w = new World();
  const p = createPlayer(w, "p1", "Мандрівник", "tok", look, "m");
  const offers = lodgingOffers(w, p, used(w));
  check("є ліжко в таверні в оренду", offers.some((o) => o.area === "tavern" && o.kind === "bed"), offers.map((o) => `${o.name}:${o.kind}:${o.price}`).join(", "));
  const far = rentLodging(w, p, "tavern", "bed", used(w));
  check("здалеку не винайняти", !far.ok);
  put(w, p, "tavern");
  const t0 = w.businesses.get("tavern")!.treasury, c0 = p.coins, beds0 = bedsUsed(w, "tavern");
  const r = rentLodging(w, p, "tavern", "bed", used(w));
  check("винайняв ліжко в таверні", r.ok && p.lodging?.area === "tavern", r.reason);
  check("перша ніч наперед — у касу таверни", p.coins === c0 - bedPrice(w, "tavern") && w.businesses.get("tavern")!.treasury === t0 + bedPrice(w, "tavern"));
  check("ліжко зайняте для NPC", bedsUsed(w, "tavern") === beds0 + 1);
  playerAct(w, p, "rest");
  check("вдома — повноцінний сон", p.busy?.kind === "rest" && (p.busy.rate ?? 1) === 1);
  put(w, p, "temple");
  playerAct(w, p, "rest");
  check("не вдома — лише дрімає", p.busy?.kind === "rest" && (p.busy.rate ?? 1) < 1);
  // can't pay → debt → evicted
  for (let n = 0; n < 4 && p.lodging; n++) { p.coins = 0; nightlyRent(w); }
  check("гравця виселили за несплату", !p.lodging);
}

// 4) A whole house
{
  const w = new World();
  // the town has an empty house: its people moved to the tavern
  for (const a of residents(w, "house_3")) a.home = "tavern";
  w.homes.house_3 = { owner: "town", bedRent: 2, houseRent: 8, tenant: null, rentable: true };
  const p = createPlayer(w, "p2", "Орендар", "tok", look, "f");
  p.coins = 100;
  put(w, p, "house_3");
  const r = rentLodging(w, p, "house_3", "house", used(w));
  check("винайняв цілий будинок", r.ok && w.homes.house_3.tenant === p.id, r.reason);
  check("будинок не пропонують іншим", !lodgingOffers(w, createPlayer(w, "p3", "Інший", "tok3", look, "m"), used(w)).some((o) => o.area === "house_3"));
  const t0 = w.townTreasury;
  nightlyRent(w);
  check("плата за будинок — громаді", w.townTreasury === t0 + 8, `${t0} → ${w.townTreasury}`);
  leaveLodging(w, p);
  check("з'їхав — будинок вільний", !w.homes.house_3.tenant && !p.lodging);
}

// 5) Workshop fees
{
  const w = new World();
  const p = createPlayer(w, "p4", "Майстер", "tok", look, "m");
  p.coins = 50;
  p.x = 8.5; p.y = 19.5; // next to Ulf's anvil (8,18)
  const ws = workshopAt(w, p, 8, 18);
  check("кузня — чужа майстерня з платою", !!ws && !ws.free && ws.fee > 0, ws ? `${ws.label}, ${ws.fee} срібла, ${ws.owner}` : "");
  const ulf = w.agents.get("ulf")!;
  check("для Ульфа — безкоштовно", !!workshopAt(w, ulf, 8, 18)?.free);
  p.inv.iron = 1;
  p.inv.hammer = 1; // forging needs a hammer
  const smithy = w.businesses.get("smithy")!;
  const s0 = smithy.treasury, c0 = p.coins;
  const r = craftOnce(w, p, recipeById("knife")!);
  check("кування в кузні: плата власнику", r.ok && p.coins === c0 - ws!.fee && smithy.treasury === s0 + ws!.fee, r.reason ?? `${c0}→${p.coins}`);
  p.coins = 0; p.inv.iron = 1;
  const r2 = craftOnce(w, p, recipeById("knife")!);
  check("без грошей — не працюєш у чужій кузні", !r2.ok && (p.inv.iron ?? 0) === 1, r2.reason);
  playerBiz(w, p, "craftFee", "smithy", 0);
  check("чужу ціну не змінити", smithy.craftFee === undefined || smithy.craftFee > 0);
  // a player owner sets the fee
  smithy.ownerId = p.id;
  playerBiz(w, p, "craftFee", "smithy", 7);
  check("власник встановлює плату", smithy.craftFee === 7 && workshopAt(w, ulf, 8, 18)?.free === true);
  check("таверна й кузня — майстерні в «Справах»", hasWorkshop(w, w.businesses.get("tavern")!) && hasWorkshop(w, smithy) && !hasWorkshop(w, w.businesses.get("guard")!));
  // outdoors is free
  const outside = workshopAt(w, p, 20, 50);
  check("надворі — безкоштовно", outside === null);
  void O;
}

// 6) A full tavern: benches; NPCs without a bed sleep worse
{
  const w = new World();
  const p = createPlayer(w, "p6", "Пізній", "tok", look, "m");
  p.coins = 100;
  // the tavern fills up with newcomers
  const movers = [...w.agents.values()].filter((a) => a.kind === "npc" && a.home !== "tavern" && !a.spouse && a.bornAt === undefined && a.profession !== "reeve").slice(0, 7);
  for (const a of movers) a.home = "tavern";
  markNoBed(w);
  const offers = lodgingOffers(w, p, used(w));
  check("ліжок у таверні немає — є лава", !offers.some((o) => o.area === "tavern" && o.kind === "bed") && offers.some((o) => o.kind === "bench"), offers.filter((o) => o.area === "tavern").map((o) => `${o.kind}:${o.price}`).join(","));
  const noBed = [...w.agents.values()].filter((a) => a.flags.noBed);
  check("зайві в таверні сплять без ліжка", noBed.length > 0, noBed.map((a) => a.name).join(", "));
  const a = noBed[0];
  a.anim = "sleep"; a.energy = 10;
  const b = movers.find((m) => !m.flags.noBed)!;
  b.anim = "sleep"; b.energy = 10;
  tickNeeds(w, 60);
  check("на лаві сон гірший", a.energy < b.energy, `${a.energy.toFixed(1)} < ${b.energy.toFixed(1)}`);
  put(w, p, "tavern");
  const r = rentLodging(w, p, "tavern", "bench", used(w));
  check("гравець платить за місце на лаві", r.ok && p.lodging?.kind === "bench", r.reason);
  playerAct(w, p, "rest");
  check("сон на лаві гірший за ліжко", (p.busy?.rate ?? 1) < 1 && (p.busy?.rate ?? 0) > 0.4);
  // demand: prices go up when full, down when empty
  const t0 = bedPrice(w, "tavern");
  adjustRents(w);
  check("місць немає — ліжко дорожчає", bedPrice(w, "tavern") === t0 + 1, `${t0} → ${bedPrice(w, "tavern")}`);
  for (const m of movers) m.home = "house_1";
  leaveLodging(w, p);
  markNoBed(w);
  adjustRents(w); adjustRents(w);
  check("місць багато — дешевшає", bedPrice(w, "tavern") < t0 + 1, `${bedPrice(w, "tavern")}`);
}

// 7) Camping and one's own house
{
  const w = new World();
  const p = createPlayer(w, "p7", "Будівник", "tok", look, "f");
  p.coins = 2000;
  // a camp outside the walls: own bed
  p.x = 60.5; p.y = 30.5;
  p.inv.bed = 1;
  let spot: { x: number; y: number } | null = null;
  for (let y = 28; y < 34 && !spot; y++) for (let x = 58; x < 64 && !spot; x++) if (placeItem(w, p, "bed", x, y).ok) spot = { x, y };
  check("ліжко поставлено за мурами", !!spot);
  if (spot) { p.x = spot.x + 0.5; p.y = spot.y + 1.5; }
  playerAct(w, p, "rest");
  check("табір: сон кращий за землю, гірший за дім", p.busy?.camp === true && (p.busy.rate ?? 0) > 0.4 && (p.busy.rate ?? 1) < 1, `${p.busy?.rate}`);
  // a camp in the street → the guard wakes you
  const g = w.agents.get("daren")!;
  put(w, p, "market");
  p.busy = { kind: "rest", label: "Ночує в таборі", start: Date.now(), dur: 1e9, rate: 0.7, camp: true };
  g.x = p.x + 1; g.y = p.y; g.anim = "idle";
  onHourLodging(w, 2);
  check("у місті на вулиці варта будить", !p.busy);
  // commission a house at the residence → it's yours
  const plot = w.map.plots.find((x) => x.kind === "house" && w.map.plotStage[x.id] === "empty")!;
  const r = commissionPlot(w, p, plot.id);
  check("будинок замовлено", r.ok, r.reason);
  const proj = w.projects.find((x) => x.plotId === plot.id)!;
  for (const [it, n] of Object.entries(proj.required)) proj.delivered[it as "wood"] = n as number;
  proj.progress = 0.998;
  w.projects = [proj, ...w.projects.filter((x) => x !== proj)];
  buildHour(w, "toren");
  check("дім збудовано — власник гравець", w.homes[plot.id]?.owner === p.id && p.lodging?.kind === "own" && p.lodging.area === plot.id, JSON.stringify(w.homes[plot.id]));
  check("свій дім не здається, поки не дозволиш", closedToNewcomers(w, plot.id));
  const lr = setLetting(w, p, plot.id, true, 5);
  check("здаю ліжка по 5", lr.ok && !closedToNewcomers(w, plot.id) && bedPrice(w, plot.id) === 5);
  const lodger = w.agents.get("kaya")!;
  lodger.home = plot.id; lodger.coins = 50;
  const c0 = p.coins;
  nightlyRent(w);
  check("мешканка платить власнику-гравцю", p.coins === c0 + 5, `${c0} → ${p.coins}`);
}

// 8) A well-off lodger NPC commissions a house of their own
{
  const w = new World();
  const kaya = w.agents.get("kaya")!;
  kaya.coins = 5000; kaya.personality.ambition = 0.9;
  onDayHousing(w);
  check("заможна NPC замовляє власний дім", w.projects.some((x) => x.commissionedBy === kaya.id), w.projects.map((x) => x.commissionedBy).join(","));
}

console.log(failures ? `\n${failures} перевірок не пройдено` : "\nУсі перевірки пройдено");
process.exit(failures ? 1 : 0);
