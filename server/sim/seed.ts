// Initial population and businesses of the vertical-slice district ("Каргат", Varon Dominion border town).
// Character design reflects the concept examples: Toren, Marcus, Thomas, Vael...

import type { Agent, Business, Personality, SocialClass, FactionId, Relation } from "./types.ts";
import { emptyRelation } from "./types.ts";
import type { Look } from "../../shared/protocol.ts";
import { getMap, randomSpotIn } from "../../shared/map.ts";
import { WORLD_START_MINUTE } from "../../shared/constants.ts";
import type { Skills } from "../../shared/skills.ts";

/** Starting skills reflect each character's past (any skill can still be learned by anyone). */
const START_SKILLS: Record<string, Skills> = {
  toren: { woodcutting: 60, building: 15 },
  marcus: { trading: 70 },
  thomas: { mining: 55, combat: 20 },
  lira: { cooking: 30, trading: 10 },
  horst: { trading: 40, combat: 30 },
  brana: { cooking: 60, trading: 35 },
  ulf: { smithing: 70, mining: 20 },
  irma: { farming: 65, herbalism: 20 },
  fern: { farming: 35 },
  cedric: { combat: 60 },
  daren: { combat: 35 },
  meilan: { herbalism: 50 },
  aldric: { trading: 30, building: 25 },
  kaya: { building: 20, woodcutting: 15 },
};

interface NpcDef {
  id: string;
  name: string;
  title: string;
  profession: string;
  cls: SocialClass;
  faction: FactionId;
  home: string;
  coins: number;
  p: Partial<Personality>;
  look: Look;
  goals?: string[];
  kind?: "npc" | "klumnog";
}

const FEMALE = new Set(["lira", "brana", "irma", "kaya"]);

const SKIN = ["#e0b48f", "#c99872", "#a8775a", "#8a5d43", "#f0c9a5"];

const NPCS: NpcDef[] = [
  { id: "toren", name: "Торен", title: "Лісоруб", profession: "lumberjack", cls: "LABOR", faction: "varon", home: "house_1", coins: 12,
    p: { loyalty: 0.8, ambition: 0.4, greed: 0.4, courage: 0.3, lawfulness: 0.75, empathy: 0.6, sociability: 0.5 },
    look: { body: "#6e5a3a", hair: "#2b1d14", skin: SKIN[1] }, goals: ["Утримувати родину", "Віддати борг Горсту"] },
  { id: "marcus", name: "Маркус", title: "Торговець", profession: "merchant", cls: "MERCHANT", faction: "sylthar", home: "house_2", coins: 70,
    p: { loyalty: 0.4, ambition: 0.95, greed: 0.8, courage: 0.5, lawfulness: 0.55, empathy: 0.3, sociability: 0.7 },
    look: { body: "#2f4f7a", hair: "#4a3020", skin: SKIN[4] }, goals: ["Придбати власну справу", "Стати найбагатшим купцем Каргата"] },
  { id: "thomas", name: "Томас", title: "Шахтар", profession: "miner", cls: "LABOR", faction: "varon", home: "house_3", coins: 4,
    p: { loyalty: 0.6, ambition: 0.5, greed: 0.5, courage: 0.7, lawfulness: 0.25, empathy: 0.8, sociability: 0.6 },
    look: { body: "#5a4a40", hair: "#1a1a1a", skin: SKIN[2] }, goals: ["Допомогти Лірі з боргом", "Вибратися з бідності"] },
  { id: "lira", name: "Ліра", title: "Служниця таверни", profession: "barmaid", cls: "LABOR", faction: "varon", home: "tavern", coins: 6,
    p: { loyalty: 0.6, ambition: 0.5, greed: 0.3, courage: 0.4, lawfulness: 0.7, empathy: 0.8, sociability: 0.9 },
    look: { body: "#8a3b3b", hair: "#7a3a1a", skin: SKIN[0] }, goals: ["Виплатити борг Горсту"] },
  { id: "horst", name: "Горст", title: "Лихвар", profession: "moneylender", cls: "UNBOUND", faction: "karzin", home: "house_5", coins: 140,
    p: { loyalty: 0.2, ambition: 0.7, greed: 0.95, courage: 0.6, lawfulness: 0.2, empathy: 0.1, sociability: 0.4 },
    look: { body: "#2a2a2a", hair: "#555555", skin: SKIN[3] }, goals: ["Повернути борги з відсотками"] },
  { id: "brana", name: "Брана", title: "Власниця таверни", profession: "innkeeper", cls: "MERCHANT", faction: "varon", home: "tavern", coins: 40,
    p: { loyalty: 0.6, ambition: 0.5, greed: 0.5, courage: 0.5, lawfulness: 0.6, empathy: 0.6, sociability: 0.9 },
    look: { body: "#7a5a2a", hair: "#a0522d", skin: SKIN[0] }, goals: ["Тримати таверну повною"] },
  { id: "ulf", name: "Ульф", title: "Коваль", profession: "blacksmith", cls: "CRAFT", faction: "karzin", home: "house_7", coins: 55,
    p: { loyalty: 0.7, ambition: 0.5, greed: 0.4, courage: 0.7, lawfulness: 0.7, empathy: 0.4, sociability: 0.3 },
    look: { body: "#3a3a3a", hair: "#8a4a20", skin: SKIN[1] }, goals: ["Кувати найкращі інструменти в окрузі"] },
  { id: "irma", name: "Ірма", title: "Фермерка", profession: "farmer", cls: "LABOR", faction: "varon", home: "house_4", coins: 30,
    p: { loyalty: 0.7, ambition: 0.4, greed: 0.4, courage: 0.4, lawfulness: 0.8, empathy: 0.7, sociability: 0.5 },
    look: { body: "#6a7a3a", hair: "#c8a050", skin: SKIN[0] }, goals: ["Зібрати добрий врожай"] },
  { id: "fern", name: "Ферн", title: "Наймит на фермі", profession: "farmhand", cls: "LABOR", faction: "varon", home: "house_4", coins: 8,
    p: { loyalty: 0.5, ambition: 0.3, greed: 0.5, courage: 0.4, lawfulness: 0.6, empathy: 0.5, sociability: 0.95 },
    look: { body: "#7a6a4a", hair: "#d0b070", skin: SKIN[4] }, goals: ["Знати всі новини Каргата"] },
  { id: "cedric", name: "Седрік", title: "Капітан варти", profession: "guard_captain", cls: "MILITARY", faction: "varon", home: "house_6", coins: 45,
    p: { loyalty: 0.9, ambition: 0.6, greed: 0.3, courage: 0.85, lawfulness: 0.95, empathy: 0.4, sociability: 0.5 },
    look: { body: "#7a2020", hair: "#3a2a1a", skin: SKIN[1] }, goals: ["Тримати порядок у Каргаті"] },
  { id: "daren", name: "Дарен", title: "Вартовий", profession: "guard", cls: "MILITARY", faction: "varon", home: "house_6", coins: 20,
    p: { loyalty: 0.6, ambition: 0.4, greed: 0.6, courage: 0.6, lawfulness: 0.6, empathy: 0.4, sociability: 0.6 },
    look: { body: "#7a2020", hair: "#c0a080", skin: SKIN[2] }, goals: ["Відслужити зміну без проблем"] },
  { id: "meilan", name: "Отець Мейлан", title: "Жрець", profession: "priest", cls: "SCHOLAR", faction: "nemar", home: "temple", coins: 25,
    p: { loyalty: 0.7, ambition: 0.3, greed: 0.1, courage: 0.5, lawfulness: 0.85, empathy: 0.9, sociability: 0.6 },
    look: { body: "#d8d0b8", hair: "#bbbbbb", skin: SKIN[0] }, goals: ["Зберігати зв'язок із Клумногами"] },
  { id: "aldric", name: "Староста Альдрик", title: "Староста", profession: "reeve", cls: "ADMINISTRATIVE", faction: "varon", home: "residence", coins: 90,
    p: { loyalty: 0.8, ambition: 0.6, greed: 0.5, courage: 0.4, lawfulness: 0.75, empathy: 0.4, sociability: 0.5 },
    look: { body: "#4a2a5a", hair: "#9a9a9a", skin: SKIN[4] }, goals: ["Наповнювати міську скарбницю"] },
  { id: "kaya", name: "Кая", title: "Мандрівниця", profession: "drifter", cls: "UNBOUND", faction: "nemar", home: "house_5", coins: 5,
    p: { loyalty: 0.5, ambition: 0.6, greed: 0.5, courage: 0.6, lawfulness: 0.45, empathy: 0.5, sociability: 0.6 },
    look: { body: "#4a6a6a", hair: "#202020", skin: SKIN[3] }, goals: ["Знайти роботу в Каргаті"] },
  { id: "vael", name: "Ваель", title: "Клумног", profession: "klumnog", cls: "KLUMNOGI", faction: "none", home: "grove", coins: 0, kind: "klumnog",
    p: { loyalty: 0.5, ambition: 0.1, greed: 0, courage: 0.9, lawfulness: 0.9, empathy: 0.5, sociability: 0.15 },
    look: { body: "#6b4bd8", hair: "#b9a8ff", skin: "#3a2a7a" }, goals: ["Оберігати давнє знання", "Спостерігати за драторіанами"] },
];

function rel(partial: Partial<Relation>): Relation {
  return { ...emptyRelation(), ...partial };
}

export function createAgents(): Agent[] {
  const map = getMap();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const agents: Agent[] = NPCS.map((d) => {
    const p: Personality = {
      greed: 0.5, courage: 0.5, loyalty: 0.5, ambition: 0.5, lawfulness: 0.5, empathy: 0.5, sociability: 0.5, ...d.p,
    };
    const spot = randomSpotIn(map, map.areas[d.home], rnd);
    const a: Agent = {
      id: d.id, name: d.name, kind: d.kind ?? "npc", gender: FEMALE.has(d.id) ? "f" : "m", x: spot.x, y: spot.y, facing: 2, anim: "idle", look: d.look,
      coins: d.coins, inv: {}, hunger: 60 + rnd() * 30, energy: 70 + rnd() * 30,
      faction: d.faction, socialClass: d.cls, jailedUntil: null, jobBiz: null, skills: { ...(START_SKILLS[d.id] ?? {}) },
      title: d.title, profession: d.profession, home: d.home, personality: p, social: 60,
      relations: {}, memories: [], knownFacts: {}, lastSeen: {},
      goals: (d.goals ?? []).map((text, i) => ({ id: `${d.id}_g${i}`, text, priority: 0.8 - i * 0.2 })),
      activity: { type: "idle", label: "прокидається", started: WORLD_START_MINUTE },
      path: null, nextThinkAt: 0, nextGossipAt: 0, thinking: false,
      importance: "major", flags: {},
    };
    if (a.kind === "klumnog") { a.blessed = []; a.hunger = 100; a.energy = 100; }
    return a;
  });

  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const setRel = (a: string, b: string, r: Partial<Relation>) => { byId[a].relations[b] = rel(r); };

  // Social web — the seeds of emergent stories.
  setRel("thomas", "lira", { trust: 60, affection: 85, respect: 40 });
  setRel("lira", "thomas", { trust: 50, affection: 45, respect: 30 });
  setRel("lira", "horst", { trust: -30, fear: 40, debt: 40 });
  setRel("toren", "horst", { trust: -10, fear: 20, debt: 15 });
  setRel("horst", "lira", { trust: -10 });
  setRel("horst", "toren", { trust: 0 });
  setRel("brana", "lira", { trust: 50, affection: 40 });
  setRel("lira", "brana", { trust: 55, affection: 40 });
  setRel("fern", "irma", { trust: 40, affection: 30 });
  setRel("irma", "fern", { trust: 35 });
  setRel("cedric", "horst", { trust: -40, respect: -20 });
  setRel("cedric", "daren", { trust: 40, respect: 30 });
  setRel("daren", "cedric", { trust: 50, respect: 60, fear: 10 });
  setRel("marcus", "aldric", { trust: 20, respect: 40 });
  setRel("toren", "aldric", { trust: 40, respect: 40 });
  setRel("thomas", "aldric", { trust: 10 });
  setRel("meilan", "vael", { trust: 60, respect: 90 });
  setRel("vael", "meilan", { trust: 45, respect: 20 });
  setRel("ulf", "toren", { trust: 30, affection: 20 });
  setRel("toren", "ulf", { trust: 30, affection: 20 });
  setRel("kaya", "fern", { trust: 10 });
  return agents;
}

const ANY_WORKER: SocialClass[] = ["LABOR", "UNBOUND"];

export function createBusinesses(): Business[] {
  const base = (b: Partial<Business> & Pick<Business, "id" | "name" | "kind" | "area" | "jobTitle">): Business => ({
    ownerId: "town", forSale: null, wage: 8, maxWorkers: 3, workers: [], product: null, inputs: {}, rate: 1,
    treasury: 40, stock: {}, allowedClasses: ANY_WORKER, workHours: [8, 17], unpaidDays: {}, hoursWorked: {},
    vacancyDays: 0, ...b,
  });
  return [
    base({ id: "sawmill_north", name: "Північна лісопилка", kind: "lumber", area: "sawmill_north", jobTitle: "Лісоруб",
      product: "wood", rate: 1.5, wage: 8, maxWorkers: 3, workers: ["toren"], treasury: 50 }),
    base({ id: "sawmill_old", name: "Стара лісопилка", kind: "lumber", area: "sawmill_old", jobTitle: "Лісоруб",
      ownerId: null, forSale: 120, product: "wood", rate: 1.5, wage: 8, maxWorkers: 3, treasury: 0 }),
    base({ id: "mine", name: "Шахта Каргат", kind: "mine", area: "mine", jobTitle: "Шахтар",
      product: "ore", rate: 1.2, wage: 10, maxWorkers: 4, workers: ["thomas"], treasury: 60, deposit: "karg_ore" }),
    base({ id: "quarry", name: "Каменоломня", kind: "quarry", area: "mine", jobTitle: "Каменяр",
      product: "stone", rate: 1.5, wage: 9, maxWorkers: 2, treasury: 40, deposit: "karg_stone" }),
    base({ id: "builders", name: "Будівельна артіль", kind: "construction", area: "warehouse", jobTitle: "Будівельник",
      wage: 11, maxWorkers: 3, allowedClasses: ["LABOR", "CRAFT", "UNBOUND"], workHours: [7, 18], treasury: 60 }),
    base({ id: "farm", name: "Ферма Ірми", kind: "farm", area: "farm", jobTitle: "Наймит",
      ownerId: "irma", product: "grain", rate: 2, wage: 7, maxWorkers: 3, workers: ["irma", "fern"], treasury: 30 }),
    base({ id: "smithy", name: "Кузня Ульфа", kind: "smithy", area: "smithy", jobTitle: "Підмайстер",
      ownerId: "ulf", product: "tools", inputs: { wood: 1, ore: 2 }, rate: 0.5, wage: 9, maxWorkers: 2,
      workers: ["ulf"], allowedClasses: ["CRAFT", "LABOR"], treasury: 40, stock: { wood: 2, ore: 4 } }),
    base({ id: "tavern", name: "Таверна «Іржавий кухоль»", kind: "tavern", area: "tavern", jobTitle: "Служник",
      ownerId: "brana", product: "meal", inputs: { grain: 0.5 }, rate: 2, wage: 7, maxWorkers: 3,
      workers: ["brana", "lira"], workHours: [7, 23], allowedClasses: ["LABOR", "UNBOUND", "MERCHANT"],
      treasury: 35, stock: { meal: 12, grain: 6 } }),
    base({ id: "guard", name: "Міська варта", kind: "guard", area: "market", jobTitle: "Вартовий",
      wage: 10, maxWorkers: 3, workers: ["cedric", "daren"], allowedClasses: ["MILITARY"], workHours: [8, 22], treasury: 60 }),
    base({ id: "temple", name: "Храм Світанку", kind: "temple", area: "temple", jobTitle: "Послушник",
      wage: 5, maxWorkers: 1, workers: ["meilan"], allowedClasses: ["SCHOLAR"], workHours: [6, 12], treasury: 20 }),
    base({ id: "admin", name: "Управа", kind: "admin", area: "residence", jobTitle: "Писар",
      wage: 12, maxWorkers: 1, workers: ["aldric"], allowedClasses: ["ADMINISTRATIVE"], workHours: [9, 16], treasury: 40 }),
    base({ id: "trade", name: "Торгова лавка Маркуса", kind: "trade", area: "market", jobTitle: "Прикажчик",
      ownerId: "marcus", wage: 6, maxWorkers: 1, workers: ["marcus"], allowedClasses: ["MERCHANT"], workHours: [8, 18], treasury: 10 }),
  ];
}

/** Owners who are listed as workers don't take wages. */
export function isOwnerWorker(b: Business, id: string): boolean {
  return b.ownerId === id;
}
