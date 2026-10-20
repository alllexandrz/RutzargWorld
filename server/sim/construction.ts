// Housing & town growth: residents need beds; overcrowding → people move; no free homes →
// the reeve commissions a new house; the builders' guild buys materials at the market and builds it.
// Immigrants arrive when there is work and no hands (concept §21.2, §21.4, §21A.9).

import type { World } from "./world.ts";
import type { Agent, Being, ConstructionProject, Personality, SocialClass } from "./types.ts";
import { applyPlot, bedsIn, randomSpotIn } from "../../shared/map.ts";
import { ITEMS, marketPrice, type ItemId } from "../../shared/items.ts";
import { SKILL_IDS, skillMult, type SkillId } from "../../shared/skills.ts";
import { learnFact, newFact, witness, addGoal } from "./social.ts";
import { isChild, POPULATION_CAP } from "./family.ts";
import { hasVacancy } from "./economy.ts";
import { skillLevel, trainSkill } from "./skillsys.ts";
import { bedPlanned, builderCrafts } from "./crafting.ts";

type ProjectKind = "house" | "mine" | "quarry";
const MATERIALS: Record<ProjectKind, Partial<Record<ItemId, number>>> = {
  house: { wood: 15, plank: 10, stone: 20, tools: 1, bed: 2 },
  mine: { wood: 30, stone: 10, tools: 2, lamp: 1 },
  quarry: { wood: 15, tools: 1 },
};
/** Builder-hours at skill multiplier 1.0 */
const WORK: Record<ProjectKind, number> = { house: 40, mine: 50, quarry: 30 };
/** Homes that are not private houses: people may live there but prefer a house. */
const SHARED_HOMES = new Set(["tavern", "temple", "residence"]);
const NON_HOMES = new Set(["grove", "jail"]);

// ---------------------------------------------------------------------------
// Housing accounting
// ---------------------------------------------------------------------------

export function residents(w: World, areaId: string): Agent[] {
  return [...w.agents.values()].filter((a) => a.home === areaId && a.kind === "npc");
}

/** Beds used: a married couple shares a bed, children sleep with their parents. */
export function bedsUsed(w: World, areaId: string): number {
  const res = residents(w, areaId);
  let n = 0;
  const counted = new Set<string>();
  for (const a of res) {
    if (counted.has(a.id) || isChild(w, a)) continue;
    counted.add(a.id);
    if (a.spouse && res.some((r) => r.id === a.spouse)) counted.add(a.spouse);
    n++;
  }
  return n;
}

export function homeAreas(w: World): string[] {
  return Object.values(w.map.areas)
    .filter((a) => a.building !== undefined && !NON_HOMES.has(a.id) && bedsIn(w.map, a.id) > 0)
    .map((a) => a.id);
}

/** Beds missing in a home (positive = overcrowded). */
export function bedsShort(w: World, areaId: string): number {
  return bedsUsed(w, areaId) - bedsIn(w.map, areaId);
}

function freeBeds(w: World, areaId: string): number {
  return bedsIn(w.map, areaId) - bedsUsed(w, areaId);
}

/** People who must leave an overcrowded home: grown-up children first, then the most recent arrivals. */
function excessOf(w: World, areaId: string): Agent[][] {
  const over = bedsUsed(w, areaId) - bedsIn(w.map, areaId);
  if (over <= 0) return [];
  const res = residents(w, areaId).filter((a) => !isChild(w, a));
  const units: Agent[][] = [];
  const seen = new Set<string>();
  for (const a of res) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const sp = a.spouse ? res.find((r) => r.id === a.spouse) : undefined;
    if (sp) seen.add(sp.id);
    // kids go with their parents
    const kids = [...w.agents.values()].filter((k) => k.home === areaId && isChild(w, k) && k.parents?.some((p) => p === a.id || p === sp?.id));
    units.push([a, ...(sp ? [sp] : []), ...kids]);
  }
  const score = (u: Agent[]) => (u[0].bornAt !== undefined ? 1e9 : 0) + (u[0].flags.movedAt ?? 0);
  units.sort((x, y) => score(y) - score(x));
  return units.slice(0, over);
}

function moveUnit(w: World, unit: Agent[], to: string, reason: string) {
  const place = w.map.areas[to]?.name ?? to;
  for (const a of unit) {
    a.home = to;
    a.flags.movedAt = w.time;
  }
  const head = unit[0];
  const f = newFact(w, "moved", { actor: head.id, place });
  for (const a of unit) learnFact(w, a, f, "self", 1);
  witness(w, f, head.x, head.y, { exclude: unit.map((a) => a.id) });
  w.log(`${unit.map((a) => a.name).join(", ")} ${unit.length > 1 ? "переїжджають" : "переїжджає"}: ${place} (${reason}).`, "housing");
}

/** Everyone who currently lacks a proper bed (overcrowding), grouped by family unit. */
export function housingNeeds(w: World): Agent[][] {
  const out: Agent[][] = [];
  for (const h of homeAreas(w)) out.push(...excessOf(w, h));
  return out;
}

function findFreeHome(w: World, unitSize: number, avoid: string): string | null {
  const homes = homeAreas(w).filter((h) => h !== avoid && freeBeds(w, h) >= 1);
  homes.sort((a, b) => Number(SHARED_HOMES.has(a)) - Number(SHARED_HOMES.has(b)) || freeBeds(w, b) - freeBeds(w, a));
  void unitSize;
  return homes[0] ?? null;
}

// ---------------------------------------------------------------------------
// Construction projects
// ---------------------------------------------------------------------------

export function activeProject(w: World): ConstructionProject | null {
  return w.projects[0] ?? null;
}

/** Price of a project: materials at current market prices + builders' labour. */
export function estimateCost(w: World, kind: ProjectKind = "house"): number {
  let c = 0;
  for (const [item, n] of Object.entries(MATERIALS[kind]) as [ItemId, number][]) c += marketPrice(item, w.marketStock(item)) * n;
  const builders = w.businesses.get("builders");
  return Math.round(c + (builders?.wage ?? 11) * WORK[kind] / 9 * 1.2);
}

export function startProject(w: World, plotId: string, by: string) {
  const plot = w.map.plots.find((x) => x.id === plotId)!;
  const kind = plot.kind;
  const p: ConstructionProject = {
    plotId, kind, startedAt: w.time, required: { ...MATERIALS[kind] }, delivered: {}, progress: 0, work: WORK[kind], commissionedBy: by,
  };
  w.projects.push(p);
  applyPlot(w.map, plotId, "site");
  w.listener?.plotsChanged();
  const builders = w.businesses.get("builders");
  if (builders) builders.area = plotId;
  const what = kind === "mine" ? "шахту" : kind === "quarry" ? "кар'єр" : "новий будинок";
  const f = newFact(w, "house_started", { actor: by === "town" ? "aldric" : by, place: `${what} «${plot.name}»` });
  const ald = w.agents.get("aldric");
  if (ald) {
    learnFact(w, ald, f, "self", 1);
    if (by === "town") w.say(ald.id, kind === "house" ? "Місту бракує даху над головою. Будуємо новий дім!" : `На поверхні все вибрали — будуємо ${what}!`);
  }
  for (const id of builders?.workers ?? []) { const b = w.agents.get(id); if (b) learnFact(w, b, f, "aldric", 1); }
  const mats = (Object.entries(MATERIALS[kind]) as [ItemId, number][]).map(([i, n]) => `${ITEMS[i].name.toLowerCase()} ${n}`).join(", ");
  w.log(`${by === "town" ? "Староста Альдрик" : w.nameOf(by)} замовляє ${what} (${plot.name}). Потрібно: ${mats}.`, "housing");
}

/** A player pays the builders' guild to build a mine/quarry on a deposit; the result will be theirs. */
export function commissionPlot(w: World, buyer: Being, plotId: string): { ok: boolean; reason: string } {
  const plot = w.map.plots.find((x) => x.id === plotId);
  if (!plot || plot.kind === "house") return { ok: false, reason: "Тут можна будувати лише шахту чи кар'єр." };
  if (w.map.plotStage[plotId] !== "empty" || w.projects.some((x) => x.plotId === plotId)) return { ok: false, reason: "Ця ділянка вже зайнята." };
  const cost = estimateCost(w, plot.kind);
  if (buyer.coins < cost) return { ok: false, reason: `Потрібно ${cost} срібла (матеріали + праця будівельників).` };
  buyer.coins -= cost;
  const guild = w.businesses.get("builders");
  if (guild) guild.treasury += cost;
  startProject(w, plotId, buyer.id);
  return { ok: true, reason: `Замовлено за ${cost} срібла. Будівельна артіль закупить матеріали й збудує.` };
}

function completeProject(w: World, p: ConstructionProject) {
  w.projects = w.projects.filter((x) => x !== p);
  applyPlot(w.map, p.plotId, "built");
  w.listener?.plotsChanged();
  const builders = w.businesses.get("builders");
  if (builders) builders.area = activeProject(w)?.plotId ?? "warehouse";
  const plot = w.map.plots.find((x) => x.id === p.plotId)!;
  if (plot.kind !== "house") return openExtraction(w, p, plot.id);
  const f = newFact(w, "house_built", { place: plot.name, actor: builders?.workers[0] });
  const c = { x: plot.x + 2.5, y: plot.y + 2.5 };
  witness(w, f, c.x, c.y);
  for (const id of builders?.workers ?? []) { const b = w.agents.get(id); if (b) { learnFact(w, b, f, "self", 1); w.say(b.id, "Готово! Міцний дім — на століття."); } }
  w.log(`Збудовано новий будинок: ${plot.name}!`, "housing");
  // settle those who need a home most
  for (const unit of housingNeeds(w)) {
    if (freeBeds(w, p.plotId) < 1) break;
    moveUnit(w, unit, p.plotId, "новий дім");
  }
}

/** A finished mine/quarry becomes a business owned by whoever commissioned it. */
function openExtraction(w: World, p: ConstructionProject, plotId: string) {
  const plot = w.map.plots.find((x) => x.id === plotId)!;
  const mine = plot.kind === "mine";
  const owner = p.commissionedBy;
  const id = `biz_${plotId}`;
  w.businesses.set(id, {
    id, name: `${mine ? "Шахта" : "Кар'єр"} «${plot.name}»`, kind: mine ? "mine" : "quarry",
    ownerId: owner, forSale: null, wage: mine ? 11 : 10, maxWorkers: 3, workers: [], area: plotId,
    product: mine ? "ore" : "stone", inputs: {}, rate: mine ? 1.3 : 1.6, treasury: owner === "town" ? 50 : 0, stock: {},
    allowedClasses: ["LABOR", "UNBOUND"], workHours: [7, 17], unpaidDays: {}, hoursWorked: {}, vacancyDays: 0,
    jobTitle: mine ? "Шахтар" : "Каменяр", deposit: plotId,
  });
  const pl = w.players.get(owner);
  if (pl) { pl.ownedBusinesses.push(id); w.toast(pl.id, `${mine ? "Шахта" : "Кар'єр"} «${plot.name}» збудовано — тепер це твоя справа! Найми людей і поклади гроші в касу.`, "good"); w.selfChanged(pl.id); }
  const f = newFact(w, "house_built", { place: `${mine ? "шахта" : "кар'єр"} «${plot.name}»`, actor: owner === "town" ? "aldric" : owner });
  witness(w, f, plot.x + 2.5, plot.y + 2.5);
  w.log(`Відкрито ${mine ? "шахту" : "кар'єр"} «${plot.name}» (власник: ${w.nameOf(owner)}). Запас: ${w.res.deposits[plotId] ?? 0}.`, "housing");
}

/** Builders' hourly work. Called from economy.onHour for each working builder. */
export function buildHour(w: World, builderId: string) {
  const p = activeProject(w);
  const b = w.being(builderId);
  if (!p || !b) return;
  // Progress cannot outrun the materials on site.
  let matFrac = 1;
  for (const [item, need] of Object.entries(p.required) as [ItemId, number][]) matFrac = Math.min(matFrac, (p.delivered[item] ?? 0) / need);
  const step = skillMult(skillLevel(b, "building")) / p.work;
  if (p.progress + 1e-6 >= matFrac) {
    if (Math.random() < 0.15) w.say(b.id, "Без матеріалів не збудуєш... Чекаємо на деревину й камінь.");
    return;
  }
  p.progress = Math.min(matFrac, p.progress + step);
  trainSkill(w, b, "building", 1);
  if (p.progress >= 0.999) completeProject(w, p);
}

/** The guild buys missing materials at the market (the town pays for municipal houses). */
function buyMaterials(w: World) {
  const p = activeProject(w);
  const guild = w.businesses.get("builders");
  if (!p || !guild) return;
  for (const [item, need] of Object.entries(p.required) as [ItemId, number][]) {
    const missing = need - (p.delivered[item] ?? 0);
    if (missing <= 0) continue;
    // crafted materials the market doesn't have → a builder makes them
    if (builderCrafts(w, item, missing, p.plotId)) continue;
    const qty = Math.min(missing, 6, w.marketStock(item));
    if (qty <= 0) continue;
    let cost = 0;
    for (let i = 0; i < qty; i++) cost += marketPrice(item, w.marketStock(item) - i);
    if (guild.treasury < cost && p.commissionedBy === "town") {
      const top = Math.min(w.townTreasury, cost - guild.treasury + 10);
      w.townTreasury -= top; guild.treasury += top;
    }
    if (guild.treasury < cost) continue;
    guild.treasury -= cost;
    w.townTreasury += cost;
    w.market.stock[item] = w.marketStock(item) - qty;
    p.delivered[item] = (p.delivered[item] ?? 0) + qty;
  }
}

// ---------------------------------------------------------------------------
// Immigration
// ---------------------------------------------------------------------------

const M_NAMES = ["Ґорід", "Ведран", "Остап", "Ярен", "Богдар", "Святобор", "Радим", "Зорян", "Велимир", "Добромир"];
const F_NAMES = ["Мирослава", "Ведана", "Злата", "Ярина", "Любава", "Огняна", "Радослава", "Милена", "Зоряна", "Весна"];

function immigrate(w: World) {
  const gender: "m" | "f" = Math.random() < 0.5 ? "m" : "f";
  const used = new Set([...w.agents.values()].map((a) => a.name));
  const pool = (gender === "f" ? F_NAMES : M_NAMES).filter((n) => !used.has(n));
  if (!pool.length) return;
  const r = Math.random();
  const cls: SocialClass = r < 0.5 ? "LABOR" : r < 0.8 ? "UNBOUND" : "CRAFT";
  const rnd = () => Math.round((0.2 + Math.random() * 0.6) * 100) / 100;
  const personality: Personality = { greed: rnd(), courage: rnd(), loyalty: rnd(), ambition: rnd(), lawfulness: rnd(), empathy: rnd(), sociability: rnd() };
  const skill = SKILL_IDS[Math.floor(Math.random() * SKILL_IDS.length)] as SkillId;
  const spot = randomSpotIn(w.map, w.map.areas.gate);
  const home = findFreeHome(w, 1, "") ?? "tavern";
  const id = `npc_${w.factSeq++}`;
  const a: Agent = {
    id, name: pool[Math.floor(Math.random() * pool.length)], kind: "npc", gender, x: spot.x, y: spot.y, facing: 4, anim: "idle",
    look: {
      body: ["#5a5040", "#40505a", "#5a4040", "#4a5a40", "#6a5a4a"][Math.floor(Math.random() * 5)],
      hair: ["#2a1a10", "#5a3a20", "#1a1a1a", "#8a6a3a", "#aaaaaa"][Math.floor(Math.random() * 5)],
      skin: ["#e0b48f", "#c99872", "#a8775a", "#8a5d43", "#f0c9a5"][Math.floor(Math.random() * 5)],
    },
    coins: 10 + Math.floor(Math.random() * 15), inv: {}, hunger: 70, energy: 80,
    faction: (["varon", "sylthar", "karzin", "nemar"] as const)[Math.floor(Math.random() * 4)], socialClass: cls,
    jailedUntil: null, jobBiz: null, skills: { [skill]: 15 + Math.floor(Math.random() * 25) },
    title: gender === "f" ? "Переселенка" : "Переселенець", profession: "settler", home,
    personality, social: 50, relations: {}, memories: [], knownFacts: {}, lastSeen: {},
    goals: [{ id: `${id}_g0`, text: "Знайти роботу й дах над головою в Каргаті", priority: 0.8 }],
    activity: { type: "idle", label: "озирається біля брами", started: w.time },
    path: null, nextThinkAt: 0, nextGossipAt: w.time + 30, thinking: false, importance: "major", flags: { movedAt: w.time },
  };
  w.agents.set(id, a);
  const f = newFact(w, "arrived", { actor: id, place: "Східна брама" });
  learnFact(w, a, f, "self", 1);
  witness(w, f, a.x, a.y, { exclude: [id] });
  w.log(`До Каргата прибуває ${gender === "f" ? "переселенка" : "переселенець"} ${a.name} (${cls}, вміє: ${skill}) — шукає роботу. Житло: ${w.map.areas[home]?.name ?? home}.`, "housing");
  if (home === "tavern") addGoal(a, `${id}_home`, "Знайти власне житло", 0.5);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function onHourHousing(w: World, hour: number) {
  if (hour >= 7 && hour <= 18) buyMaterials(w);
  if (hour !== 7) return;
  // 1) move people out of overcrowded homes into free beds
  for (const unit of housingNeeds(w)) {
    if (bedPlanned(w, unit[0].home)) continue; // someone at home is making a bed — stay
    const to = findFreeHome(w, unit.length, unit[0].home);
    if (to && freeBeds(w, to) >= 1) moveUnit(w, unit, to, "у колишньому домі тісно");
  }
  // 2) still not enough beds → commission a house on the next free plot
  const waiting = housingNeeds(w).filter((u) => !bedPlanned(w, u[0].home)).length;
  if (waiting > 0 && !w.projects.some((x) => (x.kind ?? "house") === "house")) {
    const plot = w.map.plots.find((p) => p.kind === "house" && w.map.plotStage[p.id] === "empty" && !w.projects.some((x) => x.plotId === p.id));
    if (plot && w.townTreasury >= estimateCost(w) * 0.6) startProject(w, plot.id, "town");
  }
}

/** The town opens a new mine/quarry when the market runs short and a deposit is free. */
function considerExtraction(w: World) {
  for (const [item, kind] of [["ore", "mine"], ["stone", "quarry"]] as const) {
    if (w.marketStock(item) > ITEMS[item].targetStock * 0.3) continue;
    if (w.projects.some((x) => x.kind === kind)) continue;
    // still digging somewhere with plenty left? then wait
    const active = [...w.businesses.values()].filter((b) => b.product === item && b.deposit && (w.res.deposits[b.deposit] ?? 0) > 100);
    if (active.length >= 2) continue;
    const plot = w.map.plots.find((p) => p.kind === kind && w.map.plotStage[p.id] === "empty" && !w.projects.some((x) => x.plotId === p.id));
    if (!plot || w.townTreasury < estimateCost(w, kind) * 1.2) continue;
    const cost = estimateCost(w, kind);
    w.townTreasury -= cost;
    const guild = w.businesses.get("builders");
    if (guild) guild.treasury += cost;
    startProject(w, plot.id, "town");
  }
}

export function onDayHousing(w: World) {
  considerExtraction(w);
  if (w.agents.size >= POPULATION_CAP) return;
  let vacancies = 0;
  for (const b of w.businesses.values()) if (b.ownerId && b.kind !== "temple" && b.kind !== "admin" && hasVacancy(b)) vacancies += b.maxWorkers - b.workers.length;
  const unemployed = [...w.agents.values()].filter((a) => a.kind === "npc" && !a.jobBiz && !isChild(w, a) && a.profession !== "moneylender").length;
  if (vacancies - unemployed <= 0) return;
  // Word gets around: with no free beds in town, fewer settlers come.
  const free = homeAreas(w).reduce((n, h) => n + Math.max(0, freeBeds(w, h)), 0);
  const housingFactor = free > 0 ? 1 : activeProject(w) ? 0.15 : 0.3;
  if (Math.random() < Math.min(0.75, 0.25 + (vacancies - unemployed) * 0.1) * housingFactor) immigrate(w);
}

/** Plot states for clients. */
export function plotStates(w: World) {
  return w.map.plots.map((p) => {
    const pr = w.projects.find((x) => x.plotId === p.id);
    return {
      id: p.id, stage: w.map.plotStage[p.id], progress: pr ? Math.round(pr.progress * 100) : null,
      materials: pr ? (Object.entries(pr.required) as [ItemId, number][]).map(([i, n]) => `${ITEMS[i].name} ${pr.delivered[i] ?? 0}/${n}`).join(", ") : null,
      kind: p.kind, name: p.name, resource: p.resource ?? null,
      remaining: p.amount !== undefined ? Math.round(w.res.deposits[p.id] ?? 0) : null,
      cost: p.kind !== "house" && w.map.plotStage[p.id] === "empty" && !pr ? estimateCost(w, p.kind) : null,
      queued: !!pr && w.projects[0] !== pr,
      by: pr ? w.nameOf(pr.commissionedBy) : null,
    };
  });
}
