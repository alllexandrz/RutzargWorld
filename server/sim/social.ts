// Memory, perception, relationships and gossip.
// Key rule from the concept: World Truth ≠ Character Beliefs.
// Characters only know what they witnessed or were told — and both can be wrong.

import type { Agent, Being, Fact, FactType, Memory, Relation } from "./types.ts";
import { emptyRelation } from "./types.ts";
import type { World } from "./world.ts";
import { PERCEPTION_RADIUS } from "../../shared/constants.ts";
import { buildingAt } from "../../shared/map.ts";
import { fmtClock, dayOf } from "../../shared/time.ts";
import { courtship } from "./family.ts";

const MAX_MEMORIES = 60;

export const FACT_IMPORTANCE: Record<FactType, number> = {
  theft: 0.8, jailed: 0.9, released: 0.5, hired: 0.4, quit: 0.55, fired: 0.6, unpaid: 0.6,
  bought_business: 0.7, debt_threat: 0.55, debt_paid: 0.4, gift: 0.3, wage_raise: 0.35,
  job_offer: 0.3, blessing: 0.95, met: 0.1,
  courting: 0.6, engaged: 0.75, rejected: 0.55, married: 0.9, pregnant: 0.7, birth: 0.85, grew_up: 0.5,
  moved: 0.35, house_started: 0.55, house_built: 0.7, arrived: 0.45,
  election_called: 0.7, candidate: 0.55, elected: 0.95, coup: 1, coup_failed: 0.9, conspiracy: 0.85, embezzle: 0.85,
  privatized: 0.6, tax_change: 0.6, donation: 0.5, vote_buying: 0.7, pardon: 0.6,
  resisted: 0.75,
};

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export function rel(a: Agent, otherId: string): Relation {
  let r = a.relations[otherId];
  if (!r) { r = emptyRelation(); a.relations[otherId] = r; }
  return r;
}

const clamp = (v: number) => Math.max(-100, Math.min(100, v));

export function adjustRel(a: Agent, otherId: string, d: Partial<Relation>) {
  if (otherId === a.id) return;
  const r = rel(a, otherId);
  if (d.trust) r.trust = clamp(r.trust + d.trust);
  if (d.affection) r.affection = clamp(r.affection + d.affection);
  if (d.respect) r.respect = clamp(r.respect + d.respect);
  if (d.fear) r.fear = clamp(r.fear + d.fear);
  if (d.debt) r.debt = Math.max(0, r.debt + d.debt);
}

/** Overall attitude -100..100 used for quick checks. */
export function attitude(a: Agent, otherId: string): number {
  const r = a.relations[otherId];
  if (!r) return 0;
  return clamp(r.trust * 0.5 + r.affection * 0.35 + r.respect * 0.15);
}

// ---------------------------------------------------------------------------
// Fact → text
// ---------------------------------------------------------------------------

/** Pick verb form by grammatical gender of the being. */
export function vg(w: World, id: string | undefined, masc: string, fem: string): string {
  const b = id ? w.being(id) : undefined;
  return b?.gender === "f" ? fem : masc;
}

export function factText(w: World, f: Fact, viewer?: string): string {
  const n = (id?: string) => (id && id === viewer ? "я" : w.nameOf(id));
  const acc = (id?: string) => (id && id === viewer ? "мене" : w.nameOf(id));
  const dat = (id?: string) => (id && id === viewer ? "мені" : w.nameOf(id));
  const when = `(${fmtDay(f.t)})`;
  const biz = f.biz ? w.businesses.get(f.biz)?.name ?? f.biz : "";
  const actorV = (m: string, fe: string) => (f.actor === viewer ? (w.being(viewer!)?.gender === "f" ? fe : m) : vg(w, f.actor, m, fe));
  switch (f.type) {
    case "theft":
      return `${n(f.actor)} ${actorV("обікрав", "обікрала")} ${acc(f.target)} на ${f.amount ?? "?"} срібла${f.place ? ` — ${f.place}` : ""} ${when}`;
    case "jailed":
      return `${n(f.target)} — за ґратами! ${n(f.actor)} ${actorV("заарештував", "заарештувала")} за крадіжку ${when}`;
    case "released":
      return `${n(f.target)} ${vg(w, f.target, "вийшов", "вийшла")} з в'язниці ${when}`;
    case "hired":
      return `${n(f.target)} тепер ${f.target === viewer ? "працюю" : "працює"} на «${biz}» (${n(f.actor)}) за ${f.amount} срібла/день ${when}`;
    case "quit":
      return `${n(f.actor)} ${actorV("покинув", "покинула")} роботу в «${biz}» ${when}`;
    case "fired":
      return `${n(f.actor)} ${actorV("звільнив", "звільнила")} ${acc(f.target)} з «${biz}» ${when}`;
    case "unpaid":
      return `«${biz}» не ${f.target === viewer ? "заплатила мені" : `заплатила ${dat(f.target)}`} платню ${when}`;
    case "bought_business":
      return `${n(f.actor)} ${actorV("купив", "купила")} «${biz}» за ${f.amount} срібла ${when}`;
    case "debt_threat":
      return `${n(f.actor)} ${actorV("погрожував", "погрожувала")} ${dat(f.target)} через борг ${when}`;
    case "debt_paid":
      return `${n(f.actor)} ${actorV("віддав", "віддала")} борг ${dat(f.target)} — ${f.amount} срібла ${when}`;
    case "gift":
      return `${n(f.actor)} ${actorV("подарував", "подарувала")} ${dat(f.target)} ${f.amount} срібла ${when}`;
    case "wage_raise":
      return `«${biz}» підняла платню до ${f.amount} срібла ${when}`;
    case "job_offer":
      return `${n(f.actor)} ${actorV("запропонував", "запропонувала")} ${dat(f.target)} роботу за ${f.amount} срібла ${when}`;
    case "blessing":
      return `Клумног ${n(f.actor)} ${actorV("благословив", "благословила")} ${acc(f.target)} ${when}`;
    case "met":
      return `${n(f.actor)} ${actorV("познайомився", "познайомилася")} з ${n(f.target)} ${when}`;
    case "courting":
      return `${n(f.actor)} і ${n(f.target)} — тепер пара, їх бачать разом ${when}`;
    case "engaged":
      return `${n(f.actor)} ${actorV("освідчився", "освідчилася")} ${dat(f.target)} — і отримав(ла) згоду! Буде весілля ${when}`;
    case "rejected":
      return `${n(f.target)} ${vg(w, f.target, "відмовив", "відмовила")} ${dat(f.actor)}, коли ${f.actor === viewer ? "я освідчувався(лась)" : "той(та) освідчувався(лась)"} ${when}`;
    case "married":
      return `${n(f.actor)} і ${n(f.target)} одружилися в Храмі Світанку ${when}`;
    case "pregnant":
      return `${n(f.target)} ${f.target === viewer ? "чекаю" : "чекає"} дитину від ${w.nameOf(f.actor)} ${when}`;
    case "birth":
      return `У ${n(f.actor)} і ${n(f.target)} народилася дитина — ${w.nameOf(f.biz)} ${when}`;
    case "grew_up":
      return `${n(f.actor)} ${actorV("подорослішав", "подорослішала")} і тепер шукає свій шлях ${when}`;
    case "moved":
      return `${n(f.actor)} ${actorV("переїхав", "переїхала")} — ${f.place} ${when}`;
    case "house_started":
      return `Староста замовив новий будинок: ${f.place} — у місті бракує житла ${when}`;
    case "house_built":
      return `Збудовано новий будинок: ${f.place} ${when}`;
    case "arrived":
      return `До Каргата ${actorV("прибув", "прибула")} ${actorV("переселенець", "переселенка")} ${n(f.actor)}, ${vg(w, f.actor, "шукає", "шукає")} роботу ${when}`;
    case "election_called":
      return `${f.place === "recall" ? "Громада зібрала підписи — дострокові вибори старости" : "Настав час виборів старости"}, голосування до ${f.amount !== undefined ? fmtDay(f.amount) : "завтра"} ${when}`;
    case "candidate":
      return `${n(f.actor)} ${actorV("висунувся", "висунулася")} на виборах старости ${when}`;
    case "elected":
      return `${n(f.actor)} ${actorV("обраний", "обрана")} старостою Каргата (${f.amount ?? "?"}% голосів) ${when}`;
    case "coup":
      return `${n(f.actor)} силою ${actorV("захопив", "захопила")} владу! Варта на ${vg(w, f.actor, "його", "її")} боці, ${n(f.target)} більше не староста ${when}`;
    case "coup_failed":
      return `${n(f.actor)} ${actorV("намагався", "намагалася")} захопити владу, але варта не підтримала ${when}`;
    case "conspiracy":
      return `${n(f.actor)} ${actorV("підбивав", "підбивала")} варту на змову проти старости ${when}`;
    case "embezzle":
      return `Староста ${n(f.actor)} ${actorV("взяв", "взяла")} з міської скарбниці ${f.amount} срібла собі ${when}`;
    case "privatized":
      return `${n(f.actor)} ${actorV("викупив", "викупила")} у громади «${biz}» за ${f.amount} срібла ${when}`;
    case "tax_change":
      return `Староста встановив податок для справ: ${f.amount}% від виручки ${when}`;
    case "donation":
      return `${n(f.actor)} ${actorV("пожертвував", "пожертвувала")} громаді ${f.amount} срібла ${when}`;
    case "vote_buying":
      return `${n(f.actor)} ${actorV("купував", "купувала")} голоси перед виборами — ${actorV("дав", "дала")} гроші ${dat(f.target)} ${when}`;
    case "resisted":
      return `${n(f.actor)} ${actorV("відбився", "відбилася")} від вартового ${w.nameOf(f.target)} і не ${actorV("дався", "далася")} заарештувати ${when}`;
    case "pardon":
      return `Староста ${n(f.actor)} ${actorV("помилував", "помилувала")} ${acc(f.target)} ${when}`;
  }
}

function fmtDay(t: number): string {
  return `день ${dayOf(t)}, ${fmtClock(t)}`;
}

/** Short gossip line spoken aloud. */
export function gossipLine(w: World, f: Fact, listener: string): string {
  const txt = factText(w, f, undefined).replace(/\s*\(день.*\)$/, "");
  const openers = ["Чув?", "Кажуть,", "Між нами:", "Ти знаєш?", "Подейкують,"];
  void listener;
  return `${openers[(f.key.length + Math.floor(w.time)) % openers.length]} ${txt}.`;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function newFact(w: World, type: FactType, data: Omit<Fact, "key" | "type" | "t"> & { t?: number }): Fact {
  return { key: `${type}#${w.factSeq++}`, type, t: data.t ?? Math.floor(w.time), ...data };
}

export function addMemory(w: World, a: Agent, m: Omit<Memory, "id" | "t">): Memory {
  const mem: Memory = { id: w.memorySeq++, t: Math.floor(w.time), ...m };
  a.memories.push(mem);
  if (mem.fact) a.knownFacts[mem.fact.key] = mem.id;
  if (a.memories.length > MAX_MEMORIES) {
    // forget the least important / oldest memory
    let worst = 0, worstScore = Infinity;
    for (let i = 0; i < a.memories.length; i++) {
      const mm = a.memories[i];
      const age = (w.time - mm.t) / 1440;
      const score = mm.importance * mm.confidence + Math.abs(mm.emotional) * 0.3 - age * 0.05;
      if (score < worstScore) { worstScore = score; worst = i; }
    }
    const [gone] = a.memories.splice(worst, 1);
    if (gone.fact) delete a.knownFacts[gone.fact.key];
  }
  return mem;
}

export function knows(a: Agent, factKey: string): boolean {
  return factKey in a.knownFacts;
}

/** Character learns a fact (by witnessing it or by being told). */
export function learnFact(w: World, a: Agent, f: Fact, source: string, confidence: number): boolean {
  if (knows(a, f.key)) return false;
  // Klumnogi don't care about everyday gossip unless it concerns trust-relevant deeds
  const importance = FACT_IMPORTANCE[f.type];
  const involvesMe = f.actor === a.id || f.target === a.id;
  const sourceTxt = source === "self" ? "" : ` [від: ${w.nameOf(source)}]`;
  addMemory(w, a, {
    text: factText(w, f, a.id) + sourceTxt,
    subjects: [f.actor, f.target].filter((x): x is string => !!x),
    importance: involvesMe ? Math.min(1, importance + 0.2) : importance,
    emotional: emotionalOf(f, a.id),
    confidence,
    source,
    fact: f,
  });
  if (source !== "self" && source !== a.id) adjustRel(a, source, { trust: 0.5, affection: 0.3 });
  reactToFact(w, a, f, confidence, source === "self");
  return true;
}

function emotionalOf(f: Fact, me: string): number {
  switch (f.type) {
    case "theft": return f.target === me ? -0.9 : -0.4;
    case "jailed": return f.target === me ? -1 : -0.3;
    case "gift": return f.target === me ? 0.6 : 0.1;
    case "unpaid": return f.target === me ? -0.7 : -0.2;
    case "debt_threat": return f.target === me ? -0.8 : -0.3;
    case "blessing": return 0.5;
    default: return 0;
  }
}

/** Relationship changes + new intentions caused by learning a fact. */
function reactToFact(w: World, a: Agent, f: Fact, c: number, witnessed: boolean) {
  const actor = f.actor, target = f.target;
  switch (f.type) {
    case "theft": {
      if (!actor || actor === a.id) break;
      const victimIsMe = target === a.id;
      const lovesVictim = target ? rel(a, target).affection > 30 : false;
      adjustRel(a, actor, {
        trust: -(victimIsMe ? 60 : lovesVictim ? 35 : 22) * c,
        respect: -10 * c,
        fear: victimIsMe ? 8 : 0,
      });
      const suspect = w.being(actor);
      if (!suspect || w.isJailed(suspect)) break;
      const alreadyServed = (suspect.lastJailedAt ?? -1) >= f.t; // checked against the jail register
      if (a.jobBiz === "guard" && c >= 0.45 && !alreadyServed) {
        addGoal(a, `arrest:${actor}:${f.key}`, `Заарештувати ${w.nameOf(actor)} (крадіжка)`, 0.95);
      } else if (witnessed && a.kind === "npc" && a.personality.lawfulness > 0.55 && a.jobBiz !== "guard") {
        addGoal(a, `report:${f.key}`, `Повідомити варту про крадіжку (${w.nameOf(actor)})`, 0.7);
      }
      break;
    }
    case "jailed":
      if (target && actor && rel(a, target).affection > 40) adjustRel(a, actor, { trust: -8 * c });
      if (target === a.id) adjustRel(a, actor ?? "", { trust: -30, fear: 20 });
      // case closed for guards
      for (const g of a.goals) if (g.id.startsWith(`arrest:${target}:`)) g.priority = 0;
      a.goals = a.goals.filter((g) => g.priority > 0);
      break;
    case "gift":
      if (target === a.id && actor) adjustRel(a, actor, { trust: Math.min(25, (f.amount ?? 1) * 2), affection: Math.min(20, f.amount ?? 1) });
      else if (actor) adjustRel(a, actor, { respect: 2 * c });
      break;
    case "unpaid": {
      const b = f.biz ? w.businesses.get(f.biz) : undefined;
      const owner = b?.ownerId === "town" ? w.politics.reeve : b?.ownerId;
      if (owner && target === a.id) adjustRel(a, owner, { trust: -15 });
      else if (owner) adjustRel(a, owner, { respect: -4 * c });
      break;
    }
    case "debt_threat":
      if (target === a.id && actor) adjustRel(a, actor, { fear: 15, trust: -10 });
      else if (target && actor && rel(a, target).affection > 40) {
        adjustRel(a, actor, { trust: -15 * c });
        addGoal(a, `help:${target}`, `Допомогти ${w.nameOf(target)} з боргом`, 0.6 + a.personality.empathy * 0.3);
      }
      break;
    case "bought_business":
      if (actor) adjustRel(a, actor, { respect: 10 * c });
      break;
    case "married":
    case "engaged":
    case "courting": {
      // Jealousy: someone who loved one of the pair (without being loved back) takes it badly.
      for (const [lover, other] of [[f.actor, f.target], [f.target, f.actor]] as const) {
        if (!lover || !other || a.id === lover || a.id === other) continue;
        if (rel(a, lover).affection > 60 && (w.agents.get(lover)?.relations[a.id]?.affection ?? 0) < 50) {
          adjustRel(a, other, { trust: -15 * c, affection: -10 * c });
          adjustRel(a, lover, { affection: -8 * c });
        }
      }
      break;
    }
    case "blessing":
      if (target) adjustRel(a, target, { respect: 30 * c, trust: 10 * c });
      break;
    // ---- politics: how ordinary people feel about it ----
    case "elected":
      if (actor) adjustRel(a, actor, { respect: 12 * c });
      break;
    case "coup":
      if (!actor) break;
      adjustRel(a, actor, { fear: 25 * c, trust: -(10 + a.personality.lawfulness * 30) * c, respect: (a.personality.lawfulness < 0.4 ? 5 : -10) * c });
      if (target === a.id) { adjustRel(a, actor, { trust: -60, affection: -40 }); addGoal(a, "regain_power", "Повернути владу в Каргаті", 0.85); }
      break;
    case "coup_failed":
    case "conspiracy":
      if (actor && actor !== a.id) adjustRel(a, actor, { trust: -15 * c * (0.5 + a.personality.lawfulness) });
      if (f.type === "conspiracy" && actor && a.jobBiz === "guard" && actor !== a.id && c >= 0.5 && !w.isJailed(w.being(actor) ?? a))
        addGoal(a, `arrest:${actor}:${f.key}`, `Заарештувати ${w.nameOf(actor)} (змова)`, 0.9);
      break;
    case "embezzle":
      if (actor && actor !== a.id) adjustRel(a, actor, { trust: -30 * c, respect: -20 * c });
      break;
    case "donation":
      if (actor && actor !== a.id) adjustRel(a, actor, { respect: Math.min(20, (f.amount ?? 0) / 5) * c, trust: 4 * c });
      break;
    case "vote_buying":
      if (actor && actor !== a.id && target !== a.id) adjustRel(a, actor, { trust: -12 * c * a.personality.lawfulness * 2 });
      break;
    case "privatized":
      if (actor && actor !== a.id) adjustRel(a, actor, { respect: 6 * c });
      break;
    case "resisted":
      if (actor && actor !== a.id) adjustRel(a, actor, { fear: 8 * c, trust: -8 * c * (0.5 + a.personality.lawfulness) });
      break;
    default:
      break;
  }
}

export function addGoal(a: Agent, id: string, text: string, priority: number) {
  const g = a.goals.find((x) => x.id === id);
  if (g) { g.priority = Math.max(g.priority, priority); return; }
  a.goals.push({ id, text, priority });
  a.goals.sort((x, y) => y.priority - x.priority);
  if (a.goals.length > 8) a.goals.length = 8;
}

export function removeGoal(a: Agent, id: string) {
  a.goals = a.goals.filter((g) => g.id !== id);
}

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

/** Can `a` see position (x,y)? Same building or both outdoors, within radius. */
export function canSee(w: World, a: Being, x: number, y: number, radius = PERCEPTION_RADIUS): boolean {
  if (a.anim === "sleep") return false;
  const d = Math.hypot(a.x - x, a.y - y);
  if (d > radius) return false;
  const ba = buildingAt(w.map, a.x, a.y), bb = buildingAt(w.map, x, y);
  return (ba?.id ?? -1) === (bb?.id ?? -1);
}

/** Beings (excluding the given ids) able to see a spot. */
export function observersOf(w: World, x: number, y: number, exclude: string[], radius = PERCEPTION_RADIUS): Being[] {
  const out: Being[] = [];
  for (const b of w.presentBeings()) {
    if (exclude.includes(b.id) || w.isJailed(b)) continue;
    if (canSee(w, b, x, y, radius)) out.push(b);
  }
  return out;
}

/**
 * An event happens at (x,y). Every agent who can see it may form a memory.
 * Distant witnesses are less confident and may misidentify the actor.
 * Returns the list of agents who noticed.
 */
export function witness(w: World, f: Fact, x: number, y: number, opts: { exclude?: string[]; noticeChance?: number } = {}): Agent[] {
  const noticed: Agent[] = [];
  const exclude = opts.exclude ?? [];
  for (const a of w.agents.values()) {
    if (exclude.includes(a.id) || w.isJailed(a)) continue;
    if (!canSee(w, a, x, y)) continue;
    const d = Math.hypot(a.x - x, a.y - y);
    const notice = (opts.noticeChance ?? 1) * (d < 3 ? 1 : 1 - (d - 3) / (PERCEPTION_RADIUS - 2));
    if (Math.random() > notice) continue;
    let fact = f;
    let confidence = Math.max(0.3, 1 - d / (PERCEPTION_RADIUS + 3));
    // Misidentification: far away witness blames somebody else standing nearby.
    if (d > 4 && f.actor && Math.random() < 0.25) {
      const others = observersOf(w, x, y, [f.actor, a.id, f.target ?? ""], 4).filter((b) => b.kind !== "klumnog");
      if (others.length) {
        const wrong = others[Math.floor(Math.random() * others.length)];
        fact = { ...f, actor: wrong.id, key: `${f.key}~${a.id}` };
        confidence *= 0.8;
      }
    }
    if (learnFact(w, a, fact, "self", confidence)) noticed.push(a);
  }
  return noticed;
}

// ---------------------------------------------------------------------------
// Periodic social tick: last-seen tracking + gossip
// ---------------------------------------------------------------------------

export function tickSocial(w: World, gdt: number) {
  void gdt;
  const beings = [...w.presentBeings()];
  const agents = [...w.agents.values()];
  for (const a of agents) {
    if (a.anim === "sleep") continue;
    // last seen
    for (const b of beings) {
      if (b.id === a.id) continue;
      if (canSee(w, a, b.x, b.y, 9)) a.lastSeen[b.id] = { area: w.areaIdAt(b.x, b.y), t: Math.floor(w.time) };
    }
  }

  // gossip between nearby, awake agents
  for (const a of agents) {
    if (w.time < a.nextGossipAt || a.anim === "sleep" || w.isJailed(a)) continue;
    if (a.activity.type === "steal" || a.activity.type === "arrest") continue;
    let partner: Agent | null = null;
    for (const b of agents) {
      if (b === a || b.anim === "sleep" || w.isJailed(b)) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 2.6) continue;
      if (!canSee(w, a, b.x, b.y, 3)) continue;
      partner = b;
      break;
    }
    if (!partner) continue;
    a.nextGossipAt = w.time + 25 + (1 - a.personality.sociability) * 60 + Math.random() * 20;
    // Klumnogi only exchange words with those they trust.
    if (a.kind === "klumnog" || partner.kind === "klumnog") {
      const k = a.kind === "klumnog" ? a : partner;
      const other = k === a ? partner : a;
      if (rel(k, other.id).trust < 40) continue;
    }
    a.social = Math.min(100, a.social + 15);
    partner.social = Math.min(100, partner.social + 10);
    if (!a.relations[partner.id]) {
      adjustRel(a, partner.id, { trust: 3 });
    } else adjustRel(a, partner.id, { trust: 0.5, affection: 0.3 });

    courtship(w, a, partner);
    const fact = pickGossip(w, a, partner);
    if (fact) {
      const conf = (a.memories.find((m) => m.fact?.key === fact.key)?.confidence ?? 0.6) * 0.85;
      // Gossip is shared about others — characters keep their own crimes to themselves.
      learnFact(w, partner, fact, a.id, conf);
      w.say(a.id, gossipLine(w, fact, partner.id));
    } else if (Math.random() < 0.25) {
      w.say(a.id, smallTalk(w, a, partner));
    }
  }
}

function pickGossip(w: World, a: Agent, listener: Agent): Fact | null {
  let best: Fact | null = null, bestScore = 0.15;
  for (const m of a.memories) {
    const f = m.fact;
    if (!f || knows(listener, f.key)) continue;
    if (f.actor === a.id && (f.type === "theft")) continue; // don't confess
    if (f.type === "met") continue;
    const age = (w.time - m.t) / 1440;
    const score = m.importance * m.confidence * (1 / (1 + age)) * (0.5 + a.personality.sociability);
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return best;
}

const SMALL_TALK = [
  "Гарна сьогодні погода, га?", "Ціни на ринку знову скачуть.", "Кажуть, у лісі неспокійно.",
  "Ох і втомився я сьогодні.", "Треба б зайти до таверни ввечері.", "Варта знову ганяє бродяг.",
];

function smallTalk(w: World, a: Agent, b: Agent): string {
  void w;
  const att = attitude(a, b.id);
  if (att > 40) return `${b.name}, радий тебе бачити!`;
  if (att < -30) return `Хм. ${b.name}...`;
  return SMALL_TALK[Math.floor(Math.random() * SMALL_TALK.length)];
}
