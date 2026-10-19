// Player ↔ NPC dialogue (concept §25 "Dialogue", §33.2 Level 3).
// Dialogue never changes the world by itself — world-changing options (job offers, gifts)
// go through the engine. Free-form lines may use the LLM; templates are the fallback.

import type { World } from "./world.ts";
import type { Agent, Player } from "./types.ts";
import type { DialogLine, DialogMsg, DialogOption } from "../../shared/protocol.ts";
import { INTERACT_RANGE } from "../../shared/constants.ts";
import { adjustRel, attitude, factText, learnFact, newFact, rel, vg } from "./social.ts";
import { agentContext, requestJobDecision } from "./brain.ts";
import { askPrice, hasVacancy, mealPrice, sellBusiness } from "./economy.ts";
import { llmEnabled, llmText } from "../ai/llm.ts";
import { invAdd, ITEM_IDS, ITEMS, marketPrice } from "../../shared/items.ts";
import { hourOf } from "../../shared/time.ts";
import { canRomance, chemistry, decideProposal, engage, familySummary, isChild, reject } from "./family.ts";

type Send = (m: DialogMsg) => void;

const history = new Map<string, DialogLine[]>();
const told = new Map<string, Set<number>>();
let lineSeq = 1;
/** How long (game minutes) an NPC waits for the player's next words. Refreshed by every action and by client keep-alives. */
const TALK_HOLD = 30;
let clock = () => 0;

function hist(p: Player, a: Agent) {
  const k = `${p.id}:${a.id}`;
  let h = history.get(k);
  if (!h) { h = []; history.set(k, h); }
  return h;
}

function push(p: Player, a: Agent, who: string, text: string) {
  const h = hist(p, a);
  h.push({ who, text, id: lineSeq++, t: Math.floor(clock()), mine: who === p.name });
  if (h.length > 12) h.splice(0, h.length - 12);
}

function knownCrimesBy(a: Agent, pid: string) {
  return a.memories.filter((m) => m.fact?.type === "theft" && m.fact.actor === pid);
}

function options(w: World, p: Player, a: Agent): DialogOption[] {
  if (a.kind === "klumnog") {
    return [
      { id: "k_talk", label: "Звернутися до Клумнога" },
      { id: "k_herbs", label: "Піднести трави (3 шт.)" },
      { id: "k_magic", label: "Попросити поділитися давнім знанням" },
      { id: "bye", label: "Піти" },
    ];
  }
  const o: DialogOption[] = [
    { id: "news", label: "Що нового в Каргаті?" },
    { id: "about", label: "Розкажи про себе" },
    { id: "whereis", label: "Де мені знайти...?", arg: "person" },
  ];
  if (isChild(w, a)) { o.push({ id: "bye", label: "Бувай" }); return o; }
  if (offerable(w, p, a).length) o.push({ id: "offer", label: "Запропонувати роботу", arg: "wage" });
  if (sellable(w, p, a).length) o.push({ id: "buybiz", label: "Запропонувати викупити справу", arg: "buy" });
  o.push({ id: "gift", label: "Подарувати 5 срібла" });
  // Romance (player ↔ NPC only)
  if (a.spouse === p.id) o.push({ id: "hug", label: a.gender === "f" ? "Обійняти дружину" : "Обійняти чоловіка" });
  else if (a.partner === p.id && a.partnerStage === "engaged") o.push({ id: "wedding", label: "Ходімо до храму — час весілля" });
  else if (canRomance(w, p, a)) {
    o.push({ id: "flirt", label: "Зробити комплімент" });
    if (rel(a, p.id).affection >= 35) o.push({ id: "propose", label: "Освідчитися" });
  }
  o.push({ id: "bye", label: "Бувай" });
  return o;
}

/** Effective asking price: a price already named to this player stays valid for a game day. */
function effectiveAsk(w: World, a: Agent, p: Player, bizId: string): number | null {
  const b = w.businesses.get(bizId);
  if (!b) return null;
  const named = a.flags[`ask_${p.id}_${bizId}`], at = a.flags[`askAt_${p.id}_${bizId}`] ?? -1e9;
  if (named && w.time - at < 1440) return named;
  return askPrice(w, b, p.id).price;
}

function sellable(w: World, p: Player, a: Agent) {
  return [...w.businesses.values()]
    .filter((b) => b.ownerId === a.id)
    .map((b) => ({ id: b.id, name: b.name, ask: effectiveAsk(w, a, p, b.id) }));
}

function offerable(w: World, p: Player, a: Agent) {
  return [...w.businesses.values()]
    .filter((b) => b.ownerId === p.id && hasVacancy(b) && a.jobBiz !== b.id)
    .map((b) => ({ id: b.id, name: b.name, wage: b.wage }));
}

function msg(w: World, p: Player, a: Agent, pending = false): DialogMsg {
  const persons = [...w.agents.values(), ...w.players.values()]
    .filter((x) => x.id !== a.id && x.id !== p.id)
    .map((x) => ({ id: x.id, name: x.name }));
  return {
    t: "dialog", npcId: a.id, npcName: a.name, title: a.title,
    lines: [...hist(p, a)], options: options(w, p, a), persons, offerable: offerable(w, p, a), sellable: sellable(w, p, a), pending,
  };
}

function greeting(w: World, p: Player, a: Agent): string {
  const crimes = knownCrimesBy(a, p.id);
  const att = attitude(a, p.id);
  const r = a.relations[p.id];
  if (crimes.length) return a.jobBiz === "guard"
    ? `${p.name}! Я знаю, що ти накоїв. Не рипайся.`
    : `Тримайся від мене подалі, ${p.name}. Я знаю, що ти злодій.`;
  if (!r) return a.personality.sociability > 0.6 ? `О, нове обличчя! Я — ${a.name}, ${a.title.toLowerCase()}. А ти хто будеш?` : `${a.name}. ${a.title}. Чого тобі?`;
  if (att > 40) return `${p.name}! Радий тебе бачити, друже.`;
  if (att > 10) return `Привіт, ${p.name}.`;
  if (att < -30) return `Знову ти... Чого треба?`;
  return `А, ${p.name}. Слухаю.`;
}

function mood(a: Agent): string {
  if (a.hunger < 25) return "Живіт зводить від голоду";
  if (a.energy < 20) return "Ледве на ногах тримаюся";
  if (a.coins < 5) return "Грошей зовсім обмаль";
  if (a.social < 25) return "Самотньо якось";
  return "Та нічого, жити можна";
}

function aboutSelf(w: World, p: Player, a: Agent): string {
  const job = a.jobBiz ? w.businesses.get(a.jobBiz) : undefined;
  const jobTxt = job ? (job.ownerId === a.id ? `Тримаю «${job.name}».` : `Працюю в «${job.name}».`) : "Зараз без роботи.";
  const trust = rel(a, p.id).trust;
  const goal = a.goals[0];
  const goalTxt = goal && trust > 15 ? ` Скажу тобі чесно: ${goal.text.toLowerCase()} — ось що в мене на думці.` : "";
  if (isChild(w, a)) {
    const parents = (a.parents ?? []).map((id) => w.nameOf(id)).join(" і ");
    return `Я ${a.gender === "f" ? "мала" : "малий"}! ${parents ? `Мої батьки — ${parents}.` : ""} Коли виросту, буду ${["лицарем", "купцем", "ковалем", "магом"][a.name.length % 4]}!`;
  }
  return `${a.title}. ${jobTxt} ${mood(a)}.${familyTalk(w, a, p, true)}${goalTxt}`;
}

/** What a character says about their family. `short` = one sentence for "about me". */
function familyTalk(w: World, a: Agent, p: Player, short = false): string {
  const parts: string[] = [];
  if (a.spouse) parts.push(a.spouse === p.id ? `Я ${a.gender === "f" ? "щаслива" : "щасливий"} з тобою.` : `${a.gender === "f" ? "Мій чоловік" : "Моя дружина"} — ${w.nameOf(a.spouse)}.`);
  else if (a.partner) parts.push(a.partner === p.id ? (a.partnerStage === "engaged" ? "Скоро наше весілля!" : "Ми ж із тобою зустрічаємося.") : `${a.partnerStage === "engaged" ? (a.gender === "f" ? "Я заручена з" : "Я заручений з") : "Я зустрічаюся з"} ${w.nameOf(a.partner)}.`);
  if (a.pregnancy) parts.push("Я чекаю дитину!");
  else if (a.spouse && w.being(a.spouse)?.pregnancy) parts.push("Ми чекаємо дитину!");
  if (a.children?.length) parts.push(`${a.children.length > 1 ? "Мої діти" : "Моя дитина"}: ${a.children.map((c) => w.nameOf(c)).join(", ")}.`);
  if (!parts.length) return short ? "" : (rel(a, p.id).trust > 20 ? "Сім'ї в мене немає. Поки що." : "Не твоя справа.");
  return (short ? " " : "") + parts.join(" ");
}

function news(w: World, p: Player, a: Agent): string {
  const key = `${p.id}:${a.id}`;
  let set = told.get(key);
  if (!set) { set = new Set(); told.set(key, set); }
  const mems = a.memories
    .filter((m) => m.fact && m.fact.type !== "met" && !set!.has(m.id) && !(m.fact.actor === a.id && m.fact.type === "theft"))
    .sort((x, y) => (y.importance * y.confidence + y.t / 1e6) - (x.importance * x.confidence + x.t / 1e6));
  const pick = mems[0];
  if (!pick) return a.personality.sociability > 0.6 ? "Та все по-старому. Заходь увечері в таверну — там завжди щось почуєш." : "Нічого не знаю.";
  set.add(pick.id);
  const src = pick.source === "self" ? "Я сам(а) бачив(ла)" : `Мені ${w.nameOf(pick.source)} казав(ла)`;
  const unsure = pick.confidence < 0.55 ? " Але, може, й брешуть." : "";
  return `${factText(w, pick.fact!, a.id).replace(/\s*\(день.*\)$/, "")}. ${src}.${unsure}`;
}

function whereIs(w: World, a: Agent, targetId: string, p: Player): string {
  if (targetId === a.id) return "Я тут, перед тобою!";
  const name = w.nameOf(targetId);
  // Belief: jailed / released, by the latest relevant fact the character knows.
  let jailed: number | null = null, released: number | null = null;
  for (const m of a.memories) {
    if (m.fact?.target !== targetId) continue;
    if (m.fact.type === "jailed") jailed = Math.max(jailed ?? 0, m.fact.t);
    if (m.fact.type === "released") released = Math.max(released ?? 0, m.fact.t);
  }
  const thief = knownCrimesBy(a, targetId).length > 0 && targetId !== p.id;
  const warn = thief ? ` І тримайся від ${vg(w, targetId, "нього", "неї")} подалі — ${vg(w, targetId, "злодій", "злодійка")}.` : "";
  if (jailed !== null && (released === null || released < jailed))
    return `Ти не чув? ${name} — за ґратами в резиденції старости.${warn}`;
  const seen = a.lastSeen[targetId];
  if (!seen) return `${name}? Давно не бачив. Не знаю.${warn}`;
  const ago = Math.round((w.time - seen.t) / 60);
  const area = w.map.areas[seen.area]?.name ?? "десь за містом";
  return `${ago <= 0 ? "Щойно бачив" : `Бачив ${ago} год. тому`} — ${area}.${warn}`;
}

const SAY_SYSTEM = (a: Agent) =>
  (a.kind === "klumnog"
    ? `Ти — ${a.name}, Клумног: древня ефірна істота, згусток енергії, хранитель давньої магії. ` +
      `Ти говориш рідко, коротко, загадково, починаючи з "..."; не цікавишся політикою драторіан; ` +
      `ніколи не даєш знання просто так і не обіцяєш навчання. `
    : "") +
  `Ти граєш роль персонажа ${a.name} у темній фентезійній грі Rutzarg. Відповідай ЛИШЕ українською, ` +
  `1-2 короткими реченнями, від першої особи, у стилі середньовічного містечка. ` +
  `Ти знаєш лише те, що є в контексті; не вигадуй подій, предметів чи обіцянок, яких немає. ` +
  `Говори живо й у своєму характері (жадібний — торгується й хитрує, добрий — привітний), не повторюй дослівно свої попередні репліки. ` +
  `ВАЖЛИВО: на словах ти НЕ можеш укладати угоди, продавати чи купувати майно, брати чи давати гроші — у грі для цього є офіційні дії. ` +
  `Якщо мова про продаж твого майна, називай ЛИШЕ ціну з розділу «ТВОЄ МАЙНО ТА УГОДИ» (можеш хвалити товар, відмовляти від нижчої ціни), ` +
  `і порадь зробити офіційну пропозицію. Ніколи не вигадуй інших цін. Якщо про угоди не питають — не згадуй їх.`;

// ---------------------------------------------------------------------------
// Free-text replies without an LLM: a small rule-based responder that answers
// strictly from the character's own knowledge (memory, relations, job, needs).
// ---------------------------------------------------------------------------

/** Find characters mentioned in free text, tolerant to Ukrainian case endings ("Томаса", "Лірі"). */
function mentionedPeople(w: World, text: string, exclude: string[]): string[] {
  const t = text.toLowerCase();
  const words = t.split(/[^\p{L}']+/u).filter(Boolean);
  const out: string[] = [];
  for (const b of [...w.agents.values(), ...w.players.values()]) {
    if (exclude.includes(b.id)) continue;
    const parts = b.name.toLowerCase().split(/\s+/);
    const key = parts[parts.length - 1]; // "Отець Мейлан" → "мейлан"
    const stem = key.length > 4 ? key.slice(0, -1) : key.length > 3 ? key.slice(0, -1) : key;
    if (words.some((wd) => wd === key || (stem.length >= 3 && wd.startsWith(stem) && wd.length <= key.length + 3))) out.push(b.id);
  }
  return out;
}

function opinionOf(w: World, a: Agent, id: string, p: Player): string {
  const name = w.nameOf(id);
  if (id === p.id) return opinionOfPlayer(w, a, p);
  const r = a.relations[id];
  const crimes = knownCrimesBy(a, id);
  const latest = [...a.memories].reverse().find((m) => m.subjects.includes(id) && m.fact && m.fact.type !== "met");
  const story = latest ? ` Чув, що ${factText(w, latest.fact!, a.id).replace(/\s*\(день.*\)$/, "").replace(/^./, (c) => c.toLowerCase())}.` : "";
  if (crimes.length) return `${name}? ${vg(w, id, "Злодій", "Злодійка")}, ось хто. Тримайся подалі.${story}`;
  if (!r) return `${name}? Майже не знаю ${vg(w, id, "його", "її")}.${story}`;
  if (r.affection > 50) return `${name}... ${vg(w, id, "Він", "Вона")} для мене багато значить.${story}`;
  if (r.fear > 30) return `Про ${name} краще не говорити вголос.${story}`;
  if (r.trust > 30) return `${name} — ${vg(w, id, "надійна людина", "надійна жінка")}, я ${vg(w, id, "йому", "їй")} довіряю.${story}`;
  if (r.trust < -20) return `${name}? Не довіряю я ${vg(w, id, "йому", "їй")}.${story}`;
  return `${name}? Та нічого поганого не скажу.${story}`;
}

function opinionOfPlayer(w: World, a: Agent, p: Player): string {
  void w;
  const att = attitude(a, p.id);
  if (knownCrimesBy(a, p.id).length) return "Я знаю, що ти зробив. Не прикидайся.";
  if (att > 40) return "Ти добра людина. Таких у Каргаті небагато.";
  if (att > 10) return "Ти начебто нормальний. Побачимо.";
  if (att < -20) return "Чесно? Ти мені не подобаєшся.";
  return "Я тебе ще не знаю, чужинцю.";
}

function dealTalk(w: World, p: Player, a: Agent): string {
  const own = sellable(w, p, a);
  if (!own.length) return a.id === "aldric" ? "Майно громади не продається. А вільні справи оформлюються тут, у резиденції." : "Я нічим таким не володію.";
  const s0 = own[0];
  if (s0.ask === null) return askPrice(w, w.businesses.get(s0.id)!, p.id).reason;
  a.flags[`ask_${p.id}_${s0.id}`] = s0.ask;
  a.flags[`askAt_${p.id}_${s0.id}`] = w.time;
  return `За «${s0.name}» хочу ${s0.ask} срібла. Згоден — оформимо як слід: дай офіційну пропозицію («Запропонувати викупити справу»).`;
}

function jobTalk(w: World, a: Agent): string {
  const job = a.jobBiz ? w.businesses.get(a.jobBiz) : undefined;
  if (!job) return a.kind === "npc" && a.profession !== "moneylender" ? "Роботи зараз немає. Якщо маєш щось чесне — я слухаю!" : "Я сам собі господар.";
  if (job.ownerId === a.id) return `Тримаю «${job.name}». ${job.workers.length < job.maxWorkers ? `Шукаю людей, плачу ${job.wage} на день.` : "Людей вистачає."}`;
  const unpaid = job.unpaidDays[a.id] ?? 0;
  if (unpaid) return `Працюю в «${job.name}»... та вже ${unpaid} дн. без платні. Довго не терпітиму.`;
  return `Працюю в «${job.name}» за ${job.wage} срібла на день. ${job.wage >= 11 ? "Жаловатися гріх." : "Могли б платити й більше."}`;
}

function moneyTalk(w: World, p: Player, a: Agent): string {
  const debt = Object.entries(a.relations).find(([, r]) => r.debt > 0);
  const trust = rel(a, p.id).trust;
  if (debt && trust > 15) return `Скажу тобі по секрету: я винен ${w.nameOf(debt[0])} ${debt[1].debt} срібла. Не знаю, як віддам.`;
  if (debt) return "Гроші... не питай краще.";
  if (a.coins < 10) return "Гаманець майже порожній. Живу від платні до платні.";
  if (a.coins > 100) return "Не скаржуся. Але гроші люблять тишу.";
  return "На хліб вистачає.";
}

function crimeTalk(w: World, a: Agent): string {
  const m = [...a.memories].reverse().find((x) => x.fact && (x.fact.type === "theft" || x.fact.type === "jailed") && x.fact.actor !== a.id);
  if (!m) return "Злодіїв у нас, слава світанку, небагато. Варта пильнує.";
  return `${factText(w, m.fact!, a.id).replace(/\s*\(день.*\)$/, "")}. ${m.confidence < 0.55 ? "Хоча, може, й брешуть." : ""}`.trim();
}

function marketTalk(w: World): string {
  const items = ITEM_IDS.map((id) => ({ id, price: marketPrice(id, w.marketStock(id)), ratio: w.marketStock(id) / ITEMS[id].targetStock }));
  const scarce = items.sort((x, y) => x.ratio - y.ratio)[0];
  const glut = items.sort((x, y) => y.ratio - x.ratio)[0];
  return `Зараз бракує: ${ITEMS[scarce.id].name.toLowerCase()} (${scarce.price} срібла). А ${ITEMS[glut.id].name.toLowerCase()} — хоч греблю гати, дешево.`;
}

function templateReply(w: World, p: Player, a: Agent, text: string): string {
  const t = text.toLowerCase();
  const people = mentionedPeople(w, text, [a.id]);
  const asksWhere = /(^|\s)(де|куди|знайти|шукаю|бачив)/.test(t);
  if (people.length) {
    const who = people[0];
    return asksWhere ? whereIs(w, a, who, p) : opinionOf(w, a, who, p);
  }
  if (/(^|\s)(ти|тебе)\b.*(думаєш|ставишся)|про мене/.test(t)) return opinionOfPlayer(w, a, p);
  if (/бувай|до побачення|прощав/.test(t)) return "Бувай. Ще побачимося.";
  if (/дяку|спасиб/.test(t)) return "Нема за що.";
  if (/приві|здоров|вітаю|добр(ий|ого) (день|ранок|вечір)/.test(t)) return greeting(w, p, a);
  if (/як справи|як ти|як живеш|що робиш/.test(t)) return `${mood(a)}.${a.goals[0] && rel(a, p.id).trust > 15 ? ` Думаю тільки про одне: ${a.goals[0].text.toLowerCase()}.` : ""}`;
  if (/хто ти|як тебе звати|твоє ім|чим займаєшся/.test(t)) return `Я ${a.name}. ${aboutSelf(w, p, a)}`;
  if (/сім'|сімей|дружин|чоловік|діт|дитин|кохан|весілл|шлюб|одруж|вагітн|наречен/.test(t)) return familyTalk(w, a, p);
  if (/прод|купи|скільки|ціна|викуп/.test(t) && /лав|справ|ферм|кузн|таверн|лісопил|шахт|бізнес|підприєм|маєт/.test(t)) return dealTalk(w, p, a);
  if (/робот|праці|працю|найм|платн|заробі/.test(t)) return jobTalk(w, a);
  if (/крад|злоді|вкрав|поцуп|арешт|в'язниц|тюрм|варт/.test(t)) return crimeTalk(w, a);
  if (/новин|чув|плітк|що нового|що сталося|що чути/.test(t)) return news(w, p, a);
  if (/гро(ш|ш)|срібл|борг|позич/.test(t)) return moneyTalk(w, p, a);
  if (/ціна|ціни|ринок|купити|продати|торг/.test(t)) return marketTalk(w);
  if (/голод|їжа|їсти|таверн|юшк|пиво/.test(t)) return a.hunger < 35 ? "Сам би поїв... В таверні Брани годують непогано." : `Таверна «Іржавий кухоль» — миска юшки за ${mealPrice(w)} срібла.`;
  if (/клумног|магі|ваель|гай|ефір/.test(t)) return a.profession === "priest"
    ? "Клумноги не терплять поспіху й брехні. Іди до гаю на південному заході, але з чистими руками — вони дізнаються про твої вчинки."
    : "Клумноги? Краще не лізь до тих ефірних. Отець Мейлан про них знає більше.";
  if (/фракці|варон|домініон|сілтар|карзін|немар/.test(t)) return "Каргат належить Домініону Варон. А що там далі, у великій політиці, — не нашого розуму справа.";
  if (t.trim().endsWith("?")) return ["Не знаю, що тобі відповісти.", "Гарне питання. Тільки не до мене.", "Хтозна...", "Спитай когось іншого."][Math.floor(Math.random() * 4)];
  return ["Хм. Цікаво.", "Ну-ну.", "Можливо.", "Ти дивно говориш, чужинцю.", "Ага."][Math.floor(Math.random() * 5)];
}

/** Klumnog free-text without an LLM — cryptic, but still reacts to the topic. */
function klumnogReply(w: World, p: Player, a: Agent, text: string): string {
  const t = text.toLowerCase();
  if (/магі|знання|навч|сил|світл/.test(t)) return klumnogTalk(w, p, a, "k_magic").startsWith("...Добре")
    ? "...Попроси, як належить. Не словами в повітря." : "...Знання не дається тому, хто лише просить.";
  if (/хто ти|що ти|клумног/.test(t)) return "...Ми були тут до ваших міст. Будемо й після.";
  if (/вибач|пробач|каюсь/.test(t)) { adjustRel(a, p.id, { trust: 1 }); return "...Слова легкі. Вчинки важать більше."; }
  if (/мейлан|жрец|храм/.test(t)) return "...Мейлан приходить на світанку. Він приносить вісті з міста — і про тебе теж.";
  return klumnogTalk(w, p, a, "k_talk");
}

// ---------------------------------------------------------------------------
// Klumnog dialogue — trust is built through history, not a counter of quests
// ---------------------------------------------------------------------------

function klumnogTalk(w: World, p: Player, a: Agent, opt: string): string {
  const r = rel(a, p.id);
  const crimes = knownCrimesBy(a, p.id);
  if (crimes.length) return "...Від тебе пахне чужим сріблом, драторіанине. Ефір відвертається від тебе.";
  const blessed = a.blessed?.includes(p.id);
  if (opt === "k_herbs") {
    if ((p.inv.herbs ?? 0) < 3) return "...Ти простягаєш порожні руки. Трави ростуть у цьому гаю — якщо ти вмієш дивитися.";
    invAdd(p.inv, "herbs", -3);
    const last = p.lastTalkReward["vael_herbs"] ?? 0;
    if (Date.now() - last > 90_000) { adjustRel(a, p.id, { respect: 8, trust: 6 }); p.lastTalkReward["vael_herbs"] = Date.now(); }
    else adjustRel(a, p.id, { respect: 1 });
    w.selfChanged(p.id);
    return r.trust > 25 ? "...Ти пам'ятаєш про гай. Це добре." : "...Ефір приймає дар. Але дар — ще не довіра.";
  }
  if (opt === "k_magic") {
    if (blessed) return "...Ти вже несеш частку світла. Більшого — не зараз.";
    if (r.trust >= 40 && r.respect >= 40) {
      a.blessed = [...(a.blessed ?? []), p.id];
      p.blessing = true;
      const f = newFact(w, "blessing", { actor: a.id, target: p.id, place: "Гай Клумногів" });
      learnFact(w, a, f, "self", 1);
      const priest = w.agents.get("meilan");
      if (priest) learnFact(w, priest, f, a.id, 0.9);
      w.log(`Клумног Ваель благословляє ${p.name}. Таке трапляється раз на покоління.`, "magic");
      w.selfChanged(p.id);
      return "...Добре. Візьми крихту давнього світла. Воно не дасть тобі втомитися так швидко, як іншим. Не змарнуй.";
    }
    if (r.trust < 10) return "...Я не знаю тебе. Знання не дається тому, кого не знаєш.";
    return "...Ти на шляху. Але шлях довгий. Повертайся. Приходь із тишею, не з проханнями.";
  }
  // talk
  const last = p.lastTalkReward["vael_talk"] ?? 0;
  if (Date.now() - last > 60_000) { adjustRel(a, p.id, { trust: 3, respect: 1 }); p.lastTalkReward["vael_talk"] = Date.now(); }
  if (blessed) return "...Світло в тобі ще горить. Я пам'ятаю.";
  if (r.trust > 30) return "...Ти знову тут. Ефір пам'ятає твої кроки.";
  if (r.trust > 10) return "...Ти повертаєшся. Цікаво.";
  return "...(Згусток світла повільно обертається, ніби розглядаючи тебе.)";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function playerTalk(w: World, p: Player, npcId: string, opt: string, extra: { arg?: string; wage?: number; bizId?: string; price?: number }, send: Send) {
  const a = w.agents.get(npcId);
  if (!a) return;
  clock = () => w.time;
  if (opt === "keep") {
    // The dialog window is still open on the client: the NPC keeps waiting for the player.
    if (a.activity.type === "talk_player" && a.activity.target === p.id && Math.hypot(a.x - p.x, a.y - p.y) <= INTERACT_RANGE + 2)
      a.activity.until = w.time + TALK_HOLD;
    return;
  }
  if (Math.hypot(a.x - p.x, a.y - p.y) > INTERACT_RANGE + 0.5) { w.toast(p.id, "Підійди ближче, щоб поговорити.", "bad"); return; }
  if (a.anim === "sleep") { w.toast(p.id, `${a.name} спить.`, "info"); return; }
  if (w.isJailed(p) && !w.isJailed(a)) { /* talking through the bars is allowed */ }

  // NPC pauses to talk (same "busy with someone" state other systems can see)
  if (a.activity.type !== "arrest" && a.activity.type !== "steal") {
    a.activity = { type: "talk_player", label: `розмовляє з ${p.name}`, started: a.activity.type === "talk_player" ? a.activity.started : w.time, target: p.id, until: w.time + TALK_HOLD };
    a.path = null;
  }
  if (!a.relations[p.id]) {
    adjustRel(a, p.id, { trust: 2 });
    const f = newFact(w, "met", { actor: a.id, target: p.id });
    learnFact(w, a, f, "self", 1);
  }
  if (opt === "bye") {
    // Conversation over: the NPC goes back to its business. No dialog reply — the client
    // has already closed the window; the farewell is spoken as a normal speech bubble.
    hist(p, a).length = 0;
    w.say(a.id, a.kind === "klumnog" ? "...(Світло тьмяніє.)" : "Бувай.");
    a.activity.until = w.time;
    return;
  }

  if (a.kind === "klumnog") {
    if (opt === "say" && extra.arg) {
      const said = extra.arg.slice(0, 200);
      push(p, a, p.name, said);
      return llmSay(w, p, a, said, send, () => klumnogReply(w, p, a, said));
    }
    push(p, a, a.name, klumnogTalk(w, p, a, opt === "open" ? "k_talk" : opt));
    send(msg(w, p, a));
    return;
  }

  const hostile = knownCrimesBy(a, p.id).length > 0 || rel(a, p.id).trust < -40;
  switch (opt) {
    case "open":
      push(p, a, a.name, greeting(w, p, a));
      break;
    case "news":
      push(p, a, p.name, "Що нового в Каргаті?");
      push(p, a, a.name, hostile ? "Нічого тобі не скажу." : news(w, p, a));
      if (!hostile) rewardChat(p, a);
      break;
    case "about":
      push(p, a, p.name, "Розкажи про себе.");
      push(p, a, a.name, hostile ? "Не твоя справа." : aboutSelf(w, p, a));
      break;
    case "whereis": {
      const t = extra.arg ?? "";
      push(p, a, p.name, `Де ${w.nameOf(t)}?`);
      push(p, a, a.name, hostile ? "Шукай сам." : whereIs(w, a, t, p));
      break;
    }
    case "buybiz": {
      const b = w.businesses.get(extra.bizId ?? "");
      if (!b || b.ownerId !== a.id) break;
      const offer = Math.max(0, Math.floor(extra.price ?? 0));
      push(p, a, p.name, `Пропоную ${offer} срібла за «${b.name}».`);
      const r = askPrice(w, b, p.id);
      const ask = effectiveAsk(w, a, p, b.id);
      if (r.price === null || ask === null) { push(p, a, a.name, r.reason); break; }
      if (offer > p.coins) { push(p, a, a.name, `У тебе ж немає ${offer} срібла. Приходь, коли будуть гроші.`); break; }
      if (offer >= ask) {
        const res = sellBusiness(w, b, p, offer);
        if (!res.ok) { push(p, a, a.name, res.reason); break; }
        adjustRel(a, p.id, { trust: 5, respect: 5 });
        push(p, a, a.name, `По руках! «${b.name}» тепер твоя. Каса й товар — разом зі справою. Бережи її.`);
        delete a.flags[`ask_${p.id}_${b.id}`];
        w.toast(p.id, `Ти купив «${b.name}» за ${offer} срібла! Керуй нею в «Справах» (B).`, "good");
        break;
      }
      const haggled = a.flags[`haggled_${p.id}_${b.id}`] ?? -1e9;
      if (offer >= ask * 0.85 && w.time - haggled > 1440) {
        // One concession per day, if the offer is close.
        const counter = Math.max(offer + 1, Math.round(ask * 0.95));
        a.flags[`haggled_${p.id}_${b.id}`] = w.time;
        a.flags[`ask_${p.id}_${b.id}`] = counter;
        a.flags[`askAt_${p.id}_${b.id}`] = w.time;
        push(p, a, a.name, `Мало. Але для тебе — ${counter} срібла, і ні мідяком менше. Ця ціна в силі до завтра.`);
      } else {
        a.flags[`ask_${p.id}_${b.id}`] = ask;
        a.flags[`askAt_${p.id}_${b.id}`] = w.time;
        push(p, a, a.name, offer < ask * 0.5 ? `Смієшся? «${b.name}» коштує щонайменше ${ask} срібла.` : `Ні. Моя ціна — ${ask} срібла.`);
      }
      break;
    }
    case "flirt": {
      push(p, a, p.name, "(робиш комплімент)");
      if (hostile) { push(p, a, a.name, "Облиш ці лестощі."); break; }
      if (a.spouse) { push(p, a, a.name, `Я ${a.gender === "f" ? "заміжня" : "одружений"}, якщо ти не помітив(ла).`); adjustRel(a, p.id, { trust: -2 }); break; }
      if (a.partner && a.partner !== p.id) { push(p, a, a.name, `Дякую... але моє серце вже належить ${w.nameOf(a.partner)}.`); break; }
      const last = p.lastTalkReward[`flirt_${a.id}`] ?? 0;
      const chem = chemistry(p.id, a.id);
      if (Date.now() - last > 40_000) {
        p.lastTalkReward[`flirt_${a.id}`] = Date.now();
        const gain = Math.round(2 + 7 * chem * (0.5 + a.personality.sociability));
        adjustRel(a, p.id, { affection: chem < 0.2 ? -1 : gain, trust: 0.5 });
      }
      const aff = rel(a, p.id).affection;
      push(p, a, a.name,
        chem < 0.2 ? "Гм. Не треба цього." :
        aff > 60 ? `Ти завжди знаєш, що сказати... Я ${a.gender === "f" ? "рада" : "радий"}, коли ти поруч.` :
        aff > 35 ? "Ох... приємно чути. Ти теж нічого." :
        aff > 15 ? `Ха, дякую. Ти ${p.gender === "f" ? "смілива" : "сміливий"}.` : "Ми ж ледве знайомі. Але... дякую.");
      break;
    }
    case "propose": {
      push(p, a, p.name, `${a.name}, чи станеш ти ${a.gender === "f" ? "моєю дружиною" : "моїм чоловіком"}?`);
      if (!canRomance(w, p, a)) { push(p, a, a.name, a.spouse ? "Я вже в шлюбі." : "Це неможливо."); break; }
      if (p.spouse) { push(p, a, a.name, "Ти ж уже в шлюбі! Як тобі не соромно?"); adjustRel(a, p.id, { trust: -10 }); break; }
      const d = decideProposal(w, a, p);
      if (d.accept) {
        push(p, a, a.name, `${d.reason} Чекатиму тебе в Храмі Світанку — отець Мейлан нас обвінчає.`);
        engage(w, p, a);
      } else {
        push(p, a, a.name, d.reason);
        reject(w, p, a, d.reason);
        adjustRel(a, p.id, { affection: -3 });
      }
      break;
    }
    case "wedding": {
      push(p, a, p.name, "Ходімо до храму. Час!");
      push(p, a, a.name, "Іду! Зустрінемося в Храмі Світанку.");
      a.nextThinkAt = w.time; // re-plan now: the wedding goal takes over
      a.activity.until = w.time;
      break;
    }
    case "hug": {
      push(p, a, p.name, "(обіймаєш)");
      const last = p.lastTalkReward[`hug_${a.id}`] ?? 0;
      if (Date.now() - last > 60_000) { p.lastTalkReward[`hug_${a.id}`] = Date.now(); adjustRel(a, p.id, { affection: 3, trust: 1 }); a.social = Math.min(100, a.social + 20); }
      const fam = familySummary(w, a).filter((l) => l.startsWith("Вагітність") || l.startsWith("Діти"));
      push(p, a, a.name, rel(a, p.id).affection > 60 ? `Я ${a.gender === "f" ? "сумувала" : "сумував"} за тобою.${fam.length ? " " + fam.join(". ") + "." : ""}` : "Ну-ну, не при людях...");
      break;
    }
    case "gift": {
      if (p.coins < 5) { push(p, a, a.name, "У тебе ж самого порожньо в гаманці."); break; }
      p.coins -= 5; a.coins += 5;
      const f = newFact(w, "gift", { actor: p.id, target: a.id, amount: 5 });
      learnFact(w, a, f, "self", 1);
      push(p, a, p.name, "Ось, візьми 5 срібла.");
      push(p, a, a.name, a.coins < 15 ? "Дякую! Ти навіть не уявляєш, як це вчасно." : "О, дякую. Не забуду.");
      w.selfChanged(p.id);
      break;
    }
    case "offer": {
      const b = w.businesses.get(extra.bizId ?? "");
      if (!b || b.ownerId !== p.id) break;
      if (extra.wage && extra.wage !== b.wage) b.wage = Math.max(1, Math.min(50, Math.floor(extra.wage)));
      push(p, a, p.name, `Пропоную тобі роботу в «${b.name}» за ${b.wage} срібла на день.`);
      if (hostile) { push(p, a, a.name, "Працювати на злодія? Ніколи."); break; }
      send(msg(w, p, a, true));
      requestJobDecision(w, a, { bizId: b.id, wage: b.wage, from: p.id }, (d) => {
        const line = d.action === "ACCEPT" ? `Згода! ${d.reason} Завтра зранку буду на місці.`
          : d.action === "NEGOTIATE" ? `${d.reason} Погоджуся за ${d.counterWage} срібла на день.`
          : `Ні, дякую. ${d.reason}`;
        push(p, a, a.name, line);
        if (d.action === "ACCEPT") adjustRel(a, p.id, { trust: 5 });
        send(msg(w, p, a));
        w.selfChanged(p.id);
      });
      return;
    }
    case "say": {
      const text = (extra.arg ?? "").slice(0, 200);
      if (!text) break;
      push(p, a, p.name, text);
      if (hostile) { push(p, a, a.name, "Не хочу з тобою говорити."); break; }
      rewardChat(p, a);
      return llmSay(w, p, a, text, send, () => templateReply(w, p, a, text));
    }
  }
  send(msg(w, p, a));
}

function rewardChat(p: Player, a: Agent) {
  const last = p.lastTalkReward[a.id] ?? 0;
  if (Date.now() - last > 45_000) { adjustRel(a, p.id, { trust: 1.5, affection: 0.5 }); p.lastTalkReward[a.id] = Date.now(); }
}

/**
 * Engine-side guarantee: an LLM may only quote real prices. Any sum of money in the reply that is
 * neither the NPC's actual asking price nor a number the player said is replaced by the asking price.
 */
function groundPrices(w: World, p: Player, a: Agent, reply: string, playerText: string): string {
  const own = sellable(w, p, a).filter((x) => x.ask !== null);
  if (!own.length) return reply;
  const ask = own[0].ask!;
  const allowed = new Set<number>([...own.map((x) => x.ask!), ...(playerText.match(/\d+/g) ?? []).map(Number)]);
  return reply.replace(/(\d+)(\s*(?:срібл|монет|срібняк))/gi, (all, num: string, rest: string) => (allowed.has(Number(num)) ? all : `${ask}${rest}`));
}

/** Facts about deals the engine allows — grounds the LLM so it can't invent prices or sales. */
function dealContext(w: World, p: Player, a: Agent): string {
  const own = sellable(w, p, a);
  // A price once named stays fixed for a game day (the deal button will show the same number).
  for (const s0 of own) if (s0.ask !== null && !a.flags[`ask_${p.id}_${s0.id}`]) { a.flags[`ask_${p.id}_${s0.id}`] = s0.ask; a.flags[`askAt_${p.id}_${s0.id}`] = w.time; }
  const lines = own.map((s0) => s0.ask === null
    ? `- «${s0.name}»: не продаєш цьому співрозмовнику (${askPrice(w, w.businesses.get(s0.id)!, p.id).reason})`
    : `- «${s0.name}»: ти ПОГОДИШСЯ продати її ${p.name}, якщо він офіційно запропонує ${s0.ask} срібла або більше. Менше ${s0.ask} — відмовляєш.`);
  if (a.id === "aldric") lines.push("- Майно громади (шахта, варта, лісопилка громади) не продається.");
  const mine = [...w.businesses.values()].filter((b) => b.ownerId === p.id).map((b) => b.name);
  return `ТВОЄ МАЙНО ТА УГОДИ:\n${lines.join("\n") || "- ти не володієш підприємствами"}\n` +
    `ГРОШІ СПІВРОЗМОВНИКА (ти бачиш приблизно): ${p.coins > 200 ? "багатий" : p.coins > 60 ? "заможний" : "небагатий"}${mine.length ? `; володіє: ${mine.join(", ")}` : ""}`;
}

function llmSay(w: World, p: Player, a: Agent, text: string, send: Send, fallback: () => string) {
  if (!llmEnabled()) {
    push(p, a, a.name, fallback());
    send(msg(w, p, a));
    return;
  }
  send(msg(w, p, a, true));
  // Prices enter the prompt only when the conversation is actually about a deal.
  const recent = [text, ...hist(p, a).slice(-4).map((l) => l.text)].join(" ").toLowerCase();
  const aboutDeal = /прод|купи|ціна|ціну|скільки|викуп|монет|срібл|гроші|угод|домовил/.test(recent);
  const ctx = agentContext(w, a, [p.id]) + (aboutDeal ? "\n" + dealContext(w, p, a) : "");
  const convo = hist(p, a).slice(-6).map((l) => `${l.who}: ${l.text}`).join("\n");
  const time = `Зараз ${Math.floor(hourOf(w.time))}:00, ${w.areaName(a.x, a.y)}.`;
  llmText(SAY_SYSTEM(a), `${ctx}\n${time}\nСПІВРОЗМОВНИК: ${p.name} (драторіанин-мандрівник)\nРОЗМОВА:\n${convo}\n\nТвоя відповідь:`, 0).then((r) => {
    if (r && aboutDeal) r = groundPrices(w, p, a, r, text);
    push(p, a, a.name, r && r.length > 1 ? r : fallback());
    if (a.activity.type === "talk_player" && a.activity.target === p.id) a.activity.until = w.time + TALK_HOLD;
    send(msg(w, p, a));
  });
}
