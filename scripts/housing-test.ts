// Lodging and workshop fees (headless): owners and rents, NPCs paying and being evicted,
// players renting a bed / a whole house, sleeping at home vs. dozing, paying to use someone else's station.
// Usage: node scripts/housing-test.ts

import { World } from "../server/sim/world.ts";
import { createPlayer, playerAct, playerBiz } from "../server/sim/players.ts";
import { bedsUsed, residents } from "../server/sim/construction.ts";
import { bedPrice, hasWorkshop, leaveLodging, livesFree, lodgingOffers, nightlyRent, rentLodging, workshopAt } from "../server/sim/housing.ts";
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

console.log(failures ? `\n${failures} перевірок не пройдено` : "\nУсі перевірки пройдено");
process.exit(failures ? 1 : 0);
