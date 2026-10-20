// Equipment scenarios (headless): putting things on, wear and tear, tools at work,
// resisting arrest, NPCs getting the tool for their trade, the character sheet.
// Usage: node scripts/gear-test.ts

import { World } from "../server/sim/world.ts";
import { createPlayer } from "../server/sim/players.ts";
import { equipItem, resistArrest, statsOf, toolBonus, unequip, wearOut } from "../server/sim/gear.ts";
import { craftOnce } from "../server/sim/crafting.ts";
import { recipeById } from "../shared/crafting.ts";
import { charInfo } from "../server/sim/charsheet.ts";
import { newFact, learnFact } from "../server/sim/social.ts";
import { jail } from "../server/sim/brain.ts";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) failures++; };
const run = (w: World, minutes: number, until?: () => boolean) => {
  for (let i = 0; i < minutes * 20; i++) { w.tick(0.05); w.pendingTiles.length = 0; if (until && i % 20 === 0 && until()) return true; }
  return until ? until() : true;
};

// 1) Everyone starts dressed; a player can craft clothes and put them on
{
  const w = new World();
  const dressed = [...w.agents.values()].filter((a) => a.kind === "npc").every((a) => a.equip?.body);
  check("усі NPC одягнені на старті", dressed);
  check("сторожа озброєна", !!w.agents.get("cedric")?.equip?.weapon && !!w.agents.get("daren")?.equip?.weapon,
    `${w.agents.get("cedric")?.equip?.weapon?.item}, ${w.agents.get("daren")?.equip?.weapon?.item}`);
  const p = createPlayer(w, "p1", "Тест", "tok", { body: "#445566", hair: "#221100", skin: "#ddaa88" }, "m");
  check("гравець з'являється в сорочці й штанях", p.equip?.body?.item === "shirt" && p.equip?.legs?.item === "trousers");
  p.inv.herbs = 8;
  for (let i = 0; i < 4; i++) craftOnce(w, p, recipeById("cloth")!);
  const r = craftOnce(w, p, recipeById("cap")!);
  check("полотно з трав → шапка", r.ok && p.inv.cap === 1, r.reason ?? "");
  const before = statsOf(p).presence;
  check("шапку вдягнуто", equipItem(w, p, "cap").ok && p.equip?.head?.item === "cap" && !p.inv.cap);
  check("вигляд зріс", statsOf(p).presence > before, `${before} → ${statsOf(p).presence}`);
  // worn copies remember their wear
  wearOut(w, p, "head", 40);
  unequip(w, p, "head");
  equipItem(w, p, "cap");
  check("знята річ пам'ятає знос", p.equip?.head?.dur === 60, `стан ${p.equip?.head?.dur}`);
  // a new copy is preferred over the worn one
  p.inv.cloth = 1;
  craftOnce(w, p, recipeById("cap")!);
  unequip(w, p, "head");
  equipItem(w, p, "cap");
  check("з двох шапок вдягається нова", p.equip?.head?.dur === 100 && p.worn?.cap?.[0] === 60, JSON.stringify(p.worn));
  wearOut(w, p, "head", 100);
  check("зношена вщент річ зникає", !p.equip?.head);
}

// 2) Tools speed up work and wear out
{
  const w = new World();
  const p = createPlayer(w, "p2", "Лісоруб", "tok", { body: "#445566", hair: "#221100", skin: "#ddaa88" }, "m");
  check("без сокири бонусу немає", toolBonus(p, "wood") === 0);
  p.inv.axe = 1;
  equipItem(w, p, "axe");
  check("сокира пришвидшує рубку", toolBonus(p, "wood") > 0.5 && toolBonus(p, "ore") === 0, `+${Math.round(toolBonus(p, "wood") * 100)}%`);
  // NPC lumberjack with an axe works faster than without
  const toren = w.agents.get("toren")!;
  check("лісоруб Торен має сокиру", toren.equip?.weapon?.item === "axe");
}

// 3) An armed, armoured suspect may fight off a guard; an unarmed one can't
{
  const w = new World();
  const guard = w.agents.get("daren")!;
  const p = createPlayer(w, "p3", "Буян", "tok", { body: "#445566", hair: "#221100", skin: "#ddaa88" }, "m");
  p.x = guard.x; p.y = guard.y;
  let resisted = false;
  for (let i = 0; i < 30 && !resisted; i++) resisted = resistArrest(w, p, guard);
  check("неозброєний не відбивається", !resisted, `сила ${statsOf(p).power} проти ${statsOf(guard).power}`);
  p.inv.sword = 1; p.inv.chainmail = 1; p.inv.shield = 1; p.inv.helmet = 1;
  for (const it of ["sword", "chainmail", "shield", "helmet"] as const) equipItem(w, p, it);
  const power = statsOf(p).power;
  resistArrest(w, p, guard);
  check("бійка зношує спорядження", (p.equip?.body?.dur ?? 100) < 100, `кольчуга ${p.equip?.body?.dur}%`);
  let n = 0;
  for (let i = 0; i < 20; i++) {
    for (const it of ["sword", "chainmail", "shield", "helmet"] as const) { p.inv[it] = 1; delete p.worn; equipItem(w, p, it); }
    if (resistArrest(w, p, guard)) n++;
  }
  check("в обладунках і з мечем відбивається від вартового", n > 0, `${n} з 20, сила ${power} проти ${statsOf(guard).power}`);
  check("про спротив знають", [...w.agents.values()].some((a) => a.memories.some((m) => m.fact?.type === "resisted")));
}

// 4) NPCs get the tool their job needs (buy or make it)
{
  const w = new World();
  const thomas = w.agents.get("thomas")!;
  thomas.coins += 80;
  delete thomas.equip!.weapon;
  if (!thomas.jobBiz) thomas.jobBiz = "mine";
  const job = w.businesses.get(thomas.jobBiz)!;
  const want = job.kind === "lumber" ? "axe" : job.kind === "farm" ? "sickle" : "pickaxe";
  const ok = run(w, 2 * 1440, () => thomas.equip?.weapon?.item === want);
  check(`NPC дістає знаряддя для роботи (${job.name} → ${want})`, ok, thomas.craftPlan?.label ?? thomas.activity.label);
}

// 5) Character sheet: reputation and rumours come from NPC memories
{
  const w = new World();
  const p = createPlayer(w, "p5", "Відомий", "tok", { body: "#445566", hair: "#221100", skin: "#ddaa88" }, "m");
  const lira = w.agents.get("lira")!, brana = w.agents.get("brana")!;
  const f = newFact(w, "donation", { actor: p.id, amount: 50 });
  learnFact(w, lira, f, "self", 1);
  learnFact(w, brana, f, lira.id, 0.8);
  const c = charInfo(w, p);
  check("аркуш: знають про пожертву", c.rumors.some((r) => r.text.includes("пожертвував") && r.n >= 2), JSON.stringify(c.rumors));
  check("аркуш: репутація з ставлення NPC", c.reputation.known >= 2 && c.reputation.respect > 0, JSON.stringify(c.reputation));
  jail(w, p, w.agents.get("daren")!, "бійку");
  check("аркуш: остання відсидка", charInfo(w, p).lastJailed !== null);
}

console.log(failures ? `\n${failures} перевірок не пройдено` : "\nУсі перевірки пройдено");
process.exit(failures ? 1 : 0);
