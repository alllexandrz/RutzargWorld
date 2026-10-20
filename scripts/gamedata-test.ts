// Game data exchange (headless): export → validate → apply round trip, edits, new items, rejected data.
// With a server URL also checks the HTTP API: node scripts/gamedata-test.ts [http://localhost:8787]

import { applyGameData, exportGameData, validateGameData, type GameData } from "../shared/gamedata.ts";
import { ITEMS, ITEM_IDS, type ItemId } from "../shared/items.ts";
import { RECIPE_BY_OUT, RECIPES } from "../shared/crafting.ts";
import { TOOL_FOR } from "../shared/gear.ts";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) failures++; };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const base = exportGameData("test");
const probs = validateGameData(base);
check("вбудовані дані без помилок", !probs.some((p) => p.level === "error"), probs.filter((p) => p.level === "error").map((p) => `${p.where}: ${p.text}`).join("; "));
check("експорт має довідник для редактора", !!base.reference?.skills.length && !!base.reference.stations.length && !!base.reference.constants.gatherBaseMinutes);

// round trip
const before = JSON.stringify(exportGameData("x").items);
applyGameData(clone(base));
check("застосування без змін нічого не міняє", JSON.stringify(exportGameData("x").items) === before);

// an edit
const d: GameData = clone(base);
d.items.find((x) => x.id === "axe")!.basePrice = 30;
d.recipes.find((r) => r.out === "plank")!.qty = 3;
(d.gatherTools as Record<string, string[]>).herbs = ["knife"];
applyGameData(d);
check("ціну сокири змінено в грі", ITEMS.axe.basePrice === 30);
check("рецепт дошок змінено (і RECIPE_BY_OUT теж)", RECIPES.find((r) => r.out === "plank")!.qty === 3 && RECIPE_BY_OUT.plank!.qty === 3);
check("правила добування змінено", JSON.stringify(TOOL_FOR.herbs) === JSON.stringify(["knife"]));

// a new item with a recipe
const n: GameData = clone(d);
n.items.push({ id: "rope" as ItemId, name: "Мотузка", basePrice: 6, targetStock: 10, dailyExport: 2, color: "#b09a6a", group: "material" });
n.recipes.push({ id: "rope", out: "rope" as ItemId, qty: 1, inputs: { herbs: 3 }, station: "hand", skill: "tailoring", minutes: 12 });
const added = applyGameData(n);
check("нова річ з'являється в грі", added.includes("rope") && (ITEM_IDS as string[]).includes("rope") && !!RECIPE_BY_OUT["rope" as ItemId]);

// rejected: errors are reported, nothing applied
const bad: GameData = clone(n);
bad.items.find((x) => (x.id as string) === "rope")!.basePrice = 0;
bad.recipes.push({ id: "loop_a", out: "plank", qty: 1, inputs: { wall_wood: 1 }, station: "hand", skill: "carpentry", minutes: 1 });
const errs = validateGameData(bad).filter((p) => p.level === "error");
check("помилки знаходяться (ціна 0, коло в рецептах)", errs.some((e) => e.text.includes("ціна")) && errs.some((e) => e.text.includes("Замкнене коло")), errs.map((e) => e.text).join("; "));
let threw = false;
try { applyGameData(bad); } catch { threw = true; }
check("дані з помилками не застосовуються", threw && ITEMS["rope" as ItemId].basePrice === 6);
const placeable: GameData = clone(n);
placeable.items.push({ id: "statue" as ItemId, name: "Статуя", basePrice: 50, targetStock: 2, dailyExport: 0, color: "#aaaaaa", group: "placeable", obj: 999 });
check("річ, що ставиться, без об'єкта мапи — помилка", validateGameData(placeable).some((p) => p.level === "error" && p.where.includes("statue")));
const removed: GameData = clone(n);
removed.items = removed.items.filter((x) => x.id !== "bed");
check("видалення вбудованої речі — лише попередження", validateGameData(removed).some((p) => p.level === "warning" && p.where.includes("bed")) && !validateGameData(removed).some((p) => p.level === "error"));

const reqBad: GameData = clone(n);
reqBad.recipes.find((r) => r.out === "hammer")!.tools = ["hammer"];
reqBad.recipes.find((r) => r.out === "sword")!.minSkill = 150;
const re = validateGameData(reqBad).filter((p) => p.level === "error").map((p) => p.text);
check("помилки вимог: інструмент для себе самого, навичка > 100", re.some((t) => t.includes("власного виготовлення")) && re.some((t) => t.includes("0–100")), re.join("; "));

// HTTP API (optional)
const url = process.argv[2];
if (url) {
  const g = await fetch(`${url}/api/gamedata`);
  const live = (await g.json()) as GameData;
  check("GET /api/gamedata", g.ok && live.items.length > 30, `${live.items.length} речей`);
  const noHeader = await fetch(`${url}/api/gamedata`, { method: "POST", body: JSON.stringify(live) });
  check("POST без заголовка редактора відхиляється", noHeader.status === 400);
  const edited: GameData = clone(live);
  edited.items.find((x) => x.id === "plank")!.basePrice += 1;
  const p = await fetch(`${url}/api/gamedata`, { method: "POST", headers: { "x-rutzarg-editor": "1", "content-type": "application/json" }, body: JSON.stringify(edited) });
  const after = (await (await fetch(`${url}/api/gamedata`)).json()) as GameData;
  check("POST з localhost застосовує дані", p.ok && after.items.find((x) => x.id === "plank")!.basePrice === live.items.find((x) => x.id === "plank")!.basePrice + 1);
  const broken: GameData = clone(live);
  broken.items[0].basePrice = -1;
  const pb = await fetch(`${url}/api/gamedata`, { method: "POST", headers: { "x-rutzarg-editor": "1" }, body: JSON.stringify(broken) });
  check("POST з помилками → 422 і список проблем", pb.status === 422 && Array.isArray(((await pb.json()) as { problems?: unknown[] }).problems));
  // restore
  await fetch(`${url}/api/gamedata`, { method: "POST", headers: { "x-rutzarg-editor": "1" }, body: JSON.stringify(live) });
}

console.log(failures ? `\n${failures} перевірок не пройдено` : "\nУсі перевірки пройдено");
process.exit(failures ? 1 : 0);
