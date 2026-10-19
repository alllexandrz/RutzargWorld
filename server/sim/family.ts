// Family & population (concept §21): courtship → engagement → wedding → pregnancy → birth → childhood → adulthood.
// Same rules for NPC↔NPC and Player↔NPC couples (player↔player marriages are intentionally not supported).
// Intimacy is an implied event (fade-to-black); only its consequences are simulated.

import type { World } from "./world.ts";
import type { Agent, Being, Personality, SocialClass } from "./types.ts";
import { addGoal, adjustRel, attitude, learnFact, newFact, rel, removeGoal, witness } from "./social.ts";
import { hashString } from "../../shared/rng.ts";
import { areaContains, buildingAt, randomSpotIn } from "../../shared/map.ts";
import { dayOf, isHourBetween } from "../../shared/time.ts";

/** Game days from conception to birth (design decision: 20 for the prototype). */
export const PREGNANCY_DAYS = 20;
/** Game days of childhood before a born character becomes an adult agent (placeholder, see World Clock §13.3). */
export const CHILD_ADULT_DAYS = 30;
/** Game days of infancy (stays at home). */
export const INFANT_DAYS = 3;
/** Hard cap so the district never overpopulates (§21.4). */
export const POPULATION_CAP = 40;
const MAX_CHILDREN_PER_COUPLE = 3;
const CONCEPTION_CHANCE_PER_NIGHT = 0.2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function ageDays(w: World, b: Being): number | null {
  return b.bornAt === undefined ? null : (w.time - b.bornAt) / 1440;
}

export function isChild(w: World, b: Being): boolean {
  const age = ageDays(w, b);
  return age !== null && age < CHILD_ADULT_DAYS;
}

export function isInfant(w: World, b: Being): boolean {
  const age = ageDays(w, b);
  return age !== null && age < INFANT_DAYS;
}

/** Stable "spark" between two characters, 0..1. Some pairs are seeded by the story. */
const CHEMISTRY_SEED: Record<string, number> = {
  "lira|thomas": 0.9, "fern|kaya": 0.75, "brana|ulf": 0.7,
  "brana|lira": 0.1, // employer & employee: friends, not lovers
};
export function chemistry(a: string, b: string): number {
  const key = [a, b].sort().join("|");
  return CHEMISTRY_SEED[key] ?? (hashString(key) % 1000) / 1000;
}

function related(a: Being, b: Being): boolean {
  if (a.parents?.includes(b.id) || b.parents?.includes(a.id)) return true;
  return !!a.parents?.some((p) => b.parents?.includes(p)); // siblings
}

/** Can these two become a couple at all (hard constraints)? */
export function canRomance(w: World, a: Being, b: Being): boolean {
  if (a.id === b.id || a.kind === "klumnog" || b.kind === "klumnog") return false;
  if (a.kind === "player" && b.kind === "player") return false; // no player↔player marriages
  if (isChild(w, a) || isChild(w, b) || related(a, b)) return false;
  if (a.spouse || b.spouse) return a.spouse === b.id;
  if (a.partner && a.partner !== b.id) return false;
  if (b.partner && b.partner !== a.id) return false;
  return true;
}

export function canConceive(mother: Being, father: Being): boolean {
  return mother.gender === "f" && father.gender === "m";
}

function familyName(w: World, id: string | null | undefined) {
  return w.nameOf(id);
}

// ---------------------------------------------------------------------------
// Courtship (NPC↔NPC) — runs when two agents spend time talking together
// ---------------------------------------------------------------------------

export function courtship(w: World, a: Agent, b: Agent) {
  if (a.spouse || b.spouse || !canRomance(w, a, b)) return;
  const chem = chemistry(a.id, b.id);
  if (chem < 0.55) return; // no spark — just neighbours
  const gain = chem * 0.9;
  adjustRel(a, b.id, { affection: gain * (0.6 + a.personality.sociability * 0.6) });
  adjustRel(b, a.id, { affection: gain * (0.6 + b.personality.sociability * 0.6) });

  const ra = rel(a, b.id), rb = rel(b, a.id);
  if (!a.partner && ra.affection >= 55 && rb.affection >= 55 && ra.trust >= 20 && rb.trust >= 20) {
    a.partner = b.id; b.partner = a.id;
    a.partnerStage = b.partnerStage = "dating";
    a.flags[`dating_${b.id}`] = w.time; b.flags[`dating_${a.id}`] = w.time;
    const f = newFact(w, "courting", { actor: a.id, target: b.id, place: w.areaName(a.x, a.y) });
    learnFact(w, a, f, "self", 1); learnFact(w, b, f, "self", 1);
    witness(w, f, a.x, a.y, { exclude: [a.id, b.id] });
    w.say(a.id, `${b.name}... мені з тобою добре.`);
    w.log(`${a.name} і ${b.name} починають зустрічатися.`, "family");
    return;
  }
  // After a while together, the bolder one proposes.
  if (a.partner === b.id && a.partnerStage === "dating") {
    const since = a.flags[`dating_${b.id}`] ?? w.time;
    if (w.time - since < 3 * 1440 || ra.affection < 75 || rb.affection < 65) return;
    const proposer = a.personality.courage + a.personality.ambition >= b.personality.courage + b.personality.ambition ? a : b;
    const other = proposer === a ? b : a;
    // After a refusal, wait several days before asking again.
    if (dayOf(w.time) - (proposer.flags[`proposed_${other.id}`] ?? -99) < 5) return;
    proposer.flags[`proposed_${other.id}`] = dayOf(w.time);
    const d = decideProposal(w, other, proposer);
    w.say(proposer.id, `${other.name}, чи станеш ти ${other.gender === "f" ? "моєю дружиною" : "моїм чоловіком"}?`);
    if (d.accept) engage(w, proposer, other);
    else reject(w, proposer, other, d.reason);
  }
}

// ---------------------------------------------------------------------------
// Proposal decision (shared by NPC↔NPC and Player→NPC)
// ---------------------------------------------------------------------------

export interface ProposalDecision { accept: boolean; reason: string }

export function decideProposal(w: World, npc: Agent, suitor: Being): ProposalDecision {
  if (isChild(w, npc)) return { accept: false, reason: "Я ж іще дитина!" };
  if (npc.spouse) return { accept: false, reason: `Я вже в шлюбі з ${w.nameOf(npc.spouse)}.` };
  if (npc.partner && npc.partner !== suitor.id) return { accept: false, reason: `Моє серце належить ${w.nameOf(npc.partner)}.` };
  const crimes = npc.memories.some((m) => m.fact?.type === "theft" && m.fact.actor === suitor.id);
  if (crimes) return { accept: false, reason: "За злодія я не піду. Ніколи." };
  const r = rel(npc, suitor.id);
  const p = npc.personality;
  if (r.affection < 55) return { accept: false, reason: r.affection > 30 ? `Ти мені ${suitor.gender === "f" ? "симпатична" : "симпатичний"}, але ми ще так мало знайомі...` : "Що? Ні. Ми ж майже чужі люди." };
  if (r.trust < 30) return { accept: false, reason: "Я тобі ще не довіряю настільки." };
  // Practical considerations weigh in for greedy/ambitious characters.
  const prospects = (suitor.jobBiz || (suitor as { ownedBusinesses?: string[] }).ownedBusinesses?.length ? 0.15 : -0.1) + Math.min(0.2, suitor.coins / 500);
  const score = (r.affection - 55) / 30 + (r.trust - 30) / 60 + prospects * (p.greed + p.ambition) - r.fear / 60;
  if (score < 0.05) return { accept: false, reason: "Мені треба ще подумати. Не зараз." };
  return { accept: true, reason: "Так! Тисячу разів так!" };
}

export function engage(w: World, a: Being, b: Being) {
  a.partner = b.id; b.partner = a.id;
  a.partnerStage = b.partnerStage = "engaged";
  for (const x of [a, b]) { const ag = w.agents.get(x.id); if (ag) ag.flags.engagedAt = w.time; }
  const f = newFact(w, "engaged", { actor: a.id, target: b.id, place: w.areaName(a.x, a.y) });
  for (const x of [a, b]) {
    const ag = w.agents.get(x.id);
    if (ag) { learnFact(w, ag, f, "self", 1); addGoal(ag, `wedding:${x === a ? b.id : a.id}`, `Весілля з ${w.nameOf(x === a ? b.id : a.id)} у Храмі Світанку`, 0.85); }
  }
  witness(w, f, a.x, a.y, { exclude: [a.id, b.id] });
  w.say(b.id, "Так! Зустрінемося в Храмі Світанку — отець Мейлан нас обвінчає.");
  w.log(`${a.name} освідчується ${b.name} — і отримує згоду! Буде весілля.`, "family");
  for (const x of [a, b]) if (w.players.has(x.id)) { w.toast(x.id, `Заручини! Приходьте разом до Храму Світанку, щоб одружитися.`, "good"); w.selfChanged(x.id); }
}

export function reject(w: World, suitor: Being, npc: Agent, reason: string) {
  const f = newFact(w, "rejected", { actor: suitor.id, target: npc.id });
  learnFact(w, npc, f, "self", 1);
  const sa = w.agents.get(suitor.id);
  if (sa) { learnFact(w, sa, f, "self", 1); adjustRel(sa, npc.id, { affection: -12, trust: -3 }); }
  witness(w, f, npc.x, npc.y, { exclude: [suitor.id, npc.id] });
  w.say(npc.id, reason);
  // A refusal over crimes ends the relationship.
  if (reason.startsWith("За злодія") && npc.partner === suitor.id) {
    npc.partner = suitor.partner = null;
    npc.partnerStage = suitor.partnerStage = undefined;
    w.log(`${npc.name} розриває стосунки з ${suitor.name}.`, "family");
  }
  w.log(`${npc.name} відмовляє ${suitor.name}: «${reason}»`, "family");
}

// ---------------------------------------------------------------------------
// Wedding
// ---------------------------------------------------------------------------

export function marry(w: World, a: Being, b: Being) {
  a.spouse = b.id; b.spouse = a.id;
  a.partner = b.partner = null;
  a.partnerStage = b.partnerStage = undefined;
  const f = newFact(w, "married", { actor: a.id, target: b.id, place: "Храм Світанку" });
  for (const x of [a, b]) {
    const other = x === a ? b : a;
    const ag = w.agents.get(x.id);
    if (ag) { learnFact(w, ag, f, "self", 1); removeGoal(ag, `wedding:${other.id}`); adjustRel(ag, other.id, { affection: 10, trust: 10 }); }
  }
  witness(w, f, a.x, a.y, { exclude: [a.id, b.id] });
  const priest = w.agents.get("meilan");
  if (priest && !w.isJailed(priest)) {
    learnFact(w, priest, f, "self", 1);
    w.say(priest.id, `Перед світанком і людьми оголошую вас подружжям: ${a.name} і ${b.name}!`);
  }
  // Moving in together: the one living in a shared place (tavern/temple/residence) or with less money moves.
  const aa = w.agents.get(a.id), ab = w.agents.get(b.id);
  if (aa && ab) {
    const shared = (h: string) => ["tavern", "temple", "residence", "grove"].includes(h);
    const mover = shared(aa.home) && !shared(ab.home) ? aa : shared(ab.home) && !shared(aa.home) ? ab : aa.coins <= ab.coins ? aa : ab;
    const stayer = mover === aa ? ab : aa;
    mover.home = stayer.home;
  }
  w.log(`Весілля в Храмі Світанку: ${a.name} і ${b.name} тепер подружжя!`, "family");
  for (const x of [a, b]) if (w.players.has(x.id)) { w.toast(x.id, `Ви одружені! Ваш дім — дім ${w.nameOf((x === a ? b : a).id)}.`, "good"); w.selfChanged(x.id); }
}

function inTemple(w: World, b: Being) {
  return areaContains(w.map.areas.temple, b.x, b.y);
}

/** Called while an engaged agent waits in the temple. */
export function tryWedding(w: World, a: Agent): boolean {
  if (!a.partner || a.partnerStage !== "engaged" || !inTemple(w, a)) return false;
  const other = w.being(a.partner);
  if (!other || w.isJailed(other)) return false;
  if (other.kind === "player" && !w.players.get(other.id)?.online) return false;
  if (!inTemple(w, other)) return false;
  marry(w, a, other);
  return true;
}

// ---------------------------------------------------------------------------
// Pregnancy & birth
// ---------------------------------------------------------------------------

const triedTonight = new Map<string, number>();

function homeBuildingOf(w: World, b: Being): number | null {
  const ag = w.agents.get(b.id);
  if (ag) { const area = w.map.areas[ag.home]; return area?.building ?? null; }
  const sp = b.spouse ? w.agents.get(b.spouse) : undefined; // a player's home is their NPC spouse's home
  if (sp) return w.map.areas[sp.home]?.building ?? null;
  return null;
}

function together(w: World, a: Being, b: Being): boolean {
  if (a.kind === "player" && !w.players.get(a.id)?.online) return false;
  if (b.kind === "player" && !w.players.get(b.id)?.online) return false;
  if (w.isJailed(a) || w.isJailed(b)) return false;
  const ba = buildingAt(w.map, a.x, a.y), bb = buildingAt(w.map, b.x, b.y);
  if (!ba || !bb || ba.id !== bb.id) return false;
  return homeBuildingOf(w, a) === ba.id || homeBuildingOf(w, b) === ba.id;
}

function population(w: World) {
  return w.agents.size;
}

/** Night-time: married couples at home together may conceive (implied, fade-to-black). */
export function onHourFamily(w: World, hour: number) {
  if (!(hour >= 22 || hour < 6)) return;
  const day = dayOf(w.time - 6 * 60); // one "night" = 22:00..06:00
  const seen = new Set<string>();
  for (const a of [...w.agents.values(), ...w.players.values()]) {
    if (!a.spouse || seen.has(a.id)) continue;
    const b = w.being(a.spouse);
    if (!b) continue;
    seen.add(a.id); seen.add(b.id);
    const mother = a.gender === "f" ? a : b, father = mother === a ? b : a;
    if (!canConceive(mother, father) || mother.pregnancy) continue;
    const key = [a.id, b.id].sort().join("|");
    if (triedTonight.get(key) === day) continue;
    if (!together(w, a, b)) continue;
    triedTonight.set(key, day);
    const shared = (mother.children ?? []).filter((c) => (father.children ?? []).includes(c)).length;
    if (shared >= MAX_CHILDREN_PER_COUPLE || population(w) >= POPULATION_CAP) continue;
    if (Math.random() > CONCEPTION_CHANCE_PER_NIGHT) continue;
    conceive(w, mother, father);
  }
}

export function conceive(w: World, mother: Being, father: Being) {
  mother.pregnancy = { father: father.id, since: w.time, dueAt: w.time + PREGNANCY_DAYS * 1440 };
  const f = newFact(w, "pregnant", { actor: father.id, target: mother.id });
  for (const x of [mother, father]) { const ag = w.agents.get(x.id); if (ag) learnFact(w, ag, f, "self", 1); }
  w.log(`${mother.name} чекає дитину від ${father.name}. Пологи — за ${PREGNANCY_DAYS} днів.`, "family");
  for (const x of [mother, father]) if (w.players.has(x.id)) {
    w.toast(x.id, x === mother ? `Ти вагітна! Дитина народиться приблизно через ${PREGNANCY_DAYS} ігрових днів.` : `${mother.name} чекає від тебе дитину!`, "good");
    w.selfChanged(x.id);
  }
}

const BOY_NAMES = ["Арвен", "Бран", "Дейн", "Ерік", "Гален", "Ілан", "Корін", "Лорн", "Мірек", "Ніл", "Орін", "Рейн", "Сівен", "Таріс", "Вілм"];
const GIRL_NAMES = ["Аділь", "Бета", "Цілла", "Дара", "Ельва", "Фрея", "Гвен", "Іда", "Йора", "Квіна", "Лейла", "Міра", "Нора", "Олена", "Сільва"];

function pickName(w: World, gender: "m" | "f"): string {
  const list = gender === "f" ? GIRL_NAMES : BOY_NAMES;
  const used = new Set([...w.agents.values(), ...w.players.values()].map((b) => b.name));
  const free = list.filter((n) => !used.has(n));
  return free.length ? free[Math.floor(Math.random() * free.length)] : `${list[Math.floor(Math.random() * list.length)]} ${w.agents.size}`;
}

function blend(c1: string, c2: string): string {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [a, b] = [p(c1), p(c2)];
  const t = 0.3 + Math.random() * 0.4;
  return "#" + a.map((v, i) => Math.round(v * t + b[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
}

function inheritPersonality(a?: Personality, b?: Personality): Personality {
  const keys: (keyof Personality)[] = ["greed", "courage", "loyalty", "ambition", "lawfulness", "empathy", "sociability"];
  const out = {} as Personality;
  for (const k of keys) {
    const base = ((a?.[k] ?? 0.5) + (b?.[k] ?? 0.5)) / 2;
    out[k] = Math.round(Math.max(0.05, Math.min(0.95, base + (Math.random() - 0.5) * 0.3)) * 100) / 100;
  }
  return out;
}

export function giveBirth(w: World, mother: Being) {
  const preg = mother.pregnancy!;
  mother.pregnancy = null;
  const father = w.being(preg.father);
  const ma = w.agents.get(mother.id), fa = father ? w.agents.get(father.id) : undefined;
  const gender: "m" | "f" = Math.random() < 0.5 ? "m" : "f";
  const home = ma?.home ?? fa?.home ?? "tavern";
  const near = mother.kind === "player" && !w.players.get(mother.id)?.online ? randomSpotIn(w.map, w.map.areas[home]) : { x: mother.x, y: mother.y };
  const classes: SocialClass[] = [mother.socialClass, father?.socialClass ?? mother.socialClass].filter((c) => c !== "KLUMNOGI");
  const id = `child_${w.factSeq++}`;
  const child: Agent = {
    id, name: pickName(w, gender), kind: "npc", gender, x: near.x, y: near.y, facing: 2, anim: "sleep",
    look: {
      body: ["#7a6a5a", "#5a6a7a", "#7a5a5a", "#5a7a5a"][Math.floor(Math.random() * 4)],
      hair: Math.random() < 0.5 ? mother.look.hair : father?.look.hair ?? mother.look.hair,
      skin: blend(mother.look.skin, father?.look.skin ?? mother.look.skin),
    },
    coins: 0, inv: {}, hunger: 100, energy: 100, faction: mother.faction === "none" ? "varon" : mother.faction,
    socialClass: classes[Math.floor(Math.random() * classes.length)] ?? "LABOR",
    jailedUntil: null, jobBiz: null, skills: {}, title: "Немовля", profession: "child", home,
    personality: inheritPersonality(ma?.personality, fa?.personality), social: 80,
    relations: {}, memories: [], knownFacts: {}, lastSeen: {}, goals: [],
    activity: { type: "idle", label: "спить у колисці", started: w.time },
    path: null, nextThinkAt: 0, nextGossipAt: w.time + 1e9, thinking: false, importance: "minor", flags: {},
    bornAt: w.time, parents: [mother.id, ...(father ? [father.id] : [])], children: [],
  };
  w.agents.set(id, child);
  for (const parent of [mother, father]) {
    if (!parent) continue;
    parent.children = [...(parent.children ?? []), id];
    child.relations[parent.id] = { trust: 80, affection: 90, respect: 60, fear: 0, debt: 0 };
    const pa = w.agents.get(parent.id);
    if (pa) pa.relations[id] = { trust: 70, affection: 95, respect: 10, fear: 0, debt: 0 };
  }
  const f = newFact(w, "birth", { actor: mother.id, target: father?.id, biz: id });
  for (const x of [ma, fa]) if (x) learnFact(w, x, f, "self", 1);
  witness(w, f, child.x, child.y, { exclude: [mother.id, father?.id ?? ""] });
  w.log(`У ${mother.name}${father ? ` і ${father.name}` : ""} народилася дитина — ${child.gender === "f" ? "донька" : "син"} ${child.name}!`, "family");
  for (const x of [mother, father]) if (x && w.players.has(x.id)) {
    w.toast(x.id, `Народилася дитина — ${child.gender === "f" ? "донька" : "син"} ${child.name}!`, "good");
    w.selfChanged(x.id);
  }
}

function growUp(w: World, a: Agent) {
  const titles: Record<string, [string, string]> = {
    LABOR: ["Юний робітник", "Юна робітниця"], CRAFT: ["Учень ремісника", "Учениця ремісника"],
    MERCHANT: ["Юний купець", "Юна купчиха"], MILITARY: ["Новобранець", "Новобранка"],
    SCHOLAR: ["Учень", "Учениця"], ADMINISTRATIVE: ["Писарчук", "Писарка"], UNBOUND: ["Волоцюга", "Волоцюжка"],
  };
  const t = titles[a.socialClass] ?? titles.LABOR;
  a.title = a.gender === "f" ? t[1] : t[0];
  a.profession = "youth";
  a.importance = "major";
  a.nextGossipAt = w.time + 30;
  a.coins += 5;
  a.goals = [{ id: `${a.id}_g0`, text: "Знайти свою справу в житті", priority: 0.7 }];
  const f = newFact(w, "grew_up", { actor: a.id });
  learnFact(w, a, f, "self", 1);
  witness(w, f, a.x, a.y, { exclude: [a.id] });
  for (const pid of a.parents ?? []) { const p = w.agents.get(pid); if (p) learnFact(w, p, f, "self", 1); }
  w.log(`${a.name} подорослішав(ла) і тепер — ${a.title.toLowerCase()}.`, "family");
}

/** Per game-minute family bookkeeping: births, growing up, weddings with players. */
export function tickFamily(w: World) {
  for (const b of [...w.agents.values(), ...w.players.values()]) {
    if (b.pregnancy && w.time >= b.pregnancy.dueAt) giveBirth(w, b);
  }
  for (const a of w.agents.values()) {
    if (a.bornAt === undefined || a.profession !== "child") continue;
    const age = (w.time - a.bornAt) / 1440;
    if (age >= CHILD_ADULT_DAYS) growUp(w, a);
    else if (age >= INFANT_DAYS && a.title === "Немовля") a.title = a.gender === "f" ? "Дівчинка" : "Хлопчик";
  }
}

/** Short family summary for UI / dialogue. */
export function familySummary(w: World, b: Being): string[] {
  const out: string[] = [];
  if (b.spouse) out.push(`${b.gender === "f" ? "Чоловік" : "Дружина"}: ${familyName(w, b.spouse)}`);
  else if (b.partner) out.push(`${b.partnerStage === "engaged" ? "Заручини з" : "Зустрічається з"}: ${familyName(w, b.partner)}`);
  if (b.pregnancy) out.push(`Вагітність: ще ${Math.max(0, Math.ceil((b.pregnancy.dueAt - w.time) / 1440))} дн.`);
  if (b.children?.length) out.push(`Діти: ${b.children.map((c) => familyName(w, c)).join(", ")}`);
  if (b.parents?.length) out.push(`Батьки: ${b.parents.map((c) => familyName(w, c)).join(", ")}`);
  const age = ageDays(w, b);
  if (age !== null && age < CHILD_ADULT_DAYS) out.push(`Вік: ${Math.floor(age)} дн. (дорослішає на ${CHILD_ADULT_DAYS}-й)`);
  return out;
}

export function isWeddingHours(w: World) {
  return isHourBetween(w.time, 8, 20);
}

/** NPC couples wait a day between engagement and wedding (to prepare, and so the town hears about it). */
export function weddingReady(w: World, a: Agent, partner: Being): boolean {
  if (partner.kind === "player") return true;
  return w.time - (a.flags.engagedAt ?? 0) >= 1440;
}

export function attitudeToward(a: Agent, id: string) {
  return attitude(a, id);
}
