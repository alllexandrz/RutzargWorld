// Town politics scenarios (headless): elections, recall petition, coup, privatisation, taxes, corruption.
// Usage: node scripts/politics-test.ts

import { World } from "../server/sim/world.ts";
import { createPlayer } from "../server/sim/players.ts";
import { adjustRel } from "../server/sim/social.ts";
import { adults, attemptCoup, castVote, conspire, guards, privatePrice, privatise, registerCandidate, startElection } from "../server/sim/politics.ts";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) failures++; };
const run = (w: World, minutes: number, until?: () => boolean) => {
  for (let i = 0; i < minutes * 20; i++) { w.tick(0.05); w.pendingTiles.length = 0; if (until && i % 200 === 0 && until()) return true; }
  return until ? until() : true;
};
const pol = (w: World) => w.chronicle.filter((e) => e.kind === "politics").map((e) => e.text);
const look = { body: "#000", hair: "#000", skin: "#000" };

// 1) A regular election happens on schedule and is decided by NPC votes
{
  const w = new World();
  const ok = run(w, 7 * 1440, () => pol(w).some((t) => t.startsWith("Підсумки виборів")));
  check("вибори за розкладом відбулися", ok, pol(w).filter((t) => /вибор|висува|Підсумки/.test(t)).slice(0, 4).join(" | "));
}

// 2) A liked player runs and wins; the reeve's salary is paid
{
  const w = new World();
  const p = createPlayer(w, "p1", "Обраний", "t", look, "m");
  p.coins = 100;
  for (const a of adults(w)) { adjustRel(a, p.id, { trust: 70, affection: 40 }); adjustRel(a, "aldric", { trust: -40 }); }
  startElection(w, "term");
  check("гравець висунувся", registerCandidate(w, p).ok && p.coins === 75);
  castVote(w, p, p.id);
  run(w, 2 * 1440, () => w.politics.reeve === p.id);
  check("гравець обраний старостою", w.politics.reeve === p.id, pol(w).at(-1));
  const before = p.coins;
  run(w, 1440);
  check("старості платять", p.coins > before, `${before} → ${p.coins}`);
  check("Альдрик більше не староста", !w.agents.get("aldric")!.name.startsWith("Староста") && w.agents.get("aldric")!.jobBiz !== "admin", w.agents.get("aldric")!.name);
}

// 3) Unhappy town → recall petition → early election
{
  const w = new World();
  for (const a of adults(w)) adjustRel(a, "aldric", { trust: -90, affection: -60 });
  const ok = run(w, 3 * 1440, () => !!w.politics.election && w.politics.election.reason === "recall");
  check("петиція → дострокові вибори", ok, `підписів ${w.politics.petition.length}; ${pol(w).filter((t) => t.includes("Петицію")).join("")}`);
}

// 4) Coup: with the guard → power (low legitimacy); without → jail
{
  const w = new World();
  const p = createPlayer(w, "p2", "Узурпатор", "t", look, "f");
  p.coins = 200;
  for (const g of guards(w)) { adjustRel(g, p.id, { trust: 80, affection: 50 }); adjustRel(g, "aldric", { trust: -40 }); }
  const joined = guards(w).map((g) => conspire(w, p, g, 20).joined);
  check("вартові приєдналися до змови", joined.every(Boolean), `${joined.filter(Boolean).length}/${joined.length}`);
  const r = attemptCoup(w, p);
  check("переворот удався", r.ok && w.politics.reeve === p.id && w.politics.how === "coup" && w.politics.legitimacy <= 20, `легітимність ${w.politics.legitimacy}`);
  const scared = adults(w).filter((a) => (a.relations[p.id]?.fear ?? 0) > 10).length;
  check("місто боїться узурпатора", scared > adults(w).length / 2, `${scared}/${adults(w).length}`);
  check("скинутий хоче повернути владу", w.agents.get("aldric")!.goals.some((g) => g.id === "regain_power"));

  const w2 = new World();
  const q = createPlayer(w2, "p3", "Невдаха", "t", look, "m");
  const r2 = attemptCoup(w2, q);
  check("переворот без варти → в'язниця", !r2.ok && w2.isJailed(q) && w2.politics.reeve === "aldric");
}

// 5) Loyal guard reports a conspiracy → arrest
{
  const w = new World();
  const p = createPlayer(w, "p4", "Змовник", "t", look, "m");
  const g = guards(w).sort((x, y) => y.personality.lawfulness - x.personality.lawfulness)[0];
  adjustRel(g, "aldric", { trust: 60 });
  const r = conspire(w, p, g, 0);
  check("лояльний вартовий відмовив і доніс", !r.joined && guards(w).some((x) => x.goals.some((gg) => gg.id.startsWith(`arrest:${p.id}:`))), r.reply);
  run(w, 300, () => w.isJailed(p));
  check("змовника заарештовано", w.isJailed(p));
}

// 6) Privatisation: a trusted buyer pays the town
{
  const w = new World();
  const p = createPlayer(w, "p5", "Покупець", "t", look, "m");
  const b = w.businesses.get("sawmill_north")!;
  check("незнайомцю не продають", privatePrice(w, b, p.id).price === null);
  adjustRel(w.agents.get("aldric")!, p.id, { trust: 30 });
  const pr = privatePrice(w, b, p.id).price!;
  p.coins = pr;
  const t0 = w.townTreasury;
  const r = privatise(w, b, p, pr);
  check("викуп справи громади", r.ok && b.ownerId === p.id && w.townTreasury === t0 + pr && p.ownedBusinesses.includes(b.id), `ціна ${pr}`);
}

// 7) Taxes on private revenue; a crooked NPC reeve gets caught eventually
{
  const w = new World();
  const al = w.agents.get("aldric")!;
  al.personality.greed = 0.9; al.personality.lawfulness = 0.1;
  w.townTreasury = 1000;
  run(w, 4 * 1440);
  const taxed = [...w.businesses.values()].reduce((n, b) => n + (b.ledger ?? []).reduce((m, d) => m + (d.tax ?? 0), 0), 0);
  check("податок збирається", taxed > 0, `зібрано ${taxed}, ставка ${Math.round(w.politics.taxRate * 100)}%`);
  const stole = w.chronicle.some((e) => e.text.includes("бере зі скарбниці"));
  check("жадібний староста краде з казни", stole);
  const known = adults(w).filter((a) => a.memories.some((m) => m.fact?.type === "embezzle")).length;
  check("про крадіжку з казни дізнаються", known > 0, `знають: ${known}`);
}

console.log(failures ? `\n${failures} перевірок не пройшло` : "\nУсі перевірки пройдено");
process.exit(failures ? 1 : 0);
