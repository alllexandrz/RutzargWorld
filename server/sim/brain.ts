// NPC Brain — concept §33.2:
//   Level 0  Simulation (movement, needs)        → here + needs.ts
//   Level 1  Utility AI (cheap everyday choices)  → think()
//   Level 2  LLM reasoning for important events   → requestJobDecision() (optional LLM)
//   Level 3  Dialogue                              → dialogue.ts
// AI chooses *intent*; the engine validates and executes it.

import type { World } from "./world.ts";
import type { Activity, ActivityType, Agent, Being, Business } from "./types.ts";
import { NPC_SPEED } from "../../shared/constants.ts";
import { findPath } from "../../shared/path.ts";
import { areaContains, doorOutside, randomSpotIn } from "../../shared/map.ts";
import { facingFromDir } from "../../shared/move.ts";
import { hourOf, isHourBetween, dayOf } from "../../shared/time.ts";
import { addGoal, adjustRel, attitude, canSee, learnFact, newFact, rel, removeGoal, witness, factText } from "./social.ts";
import { buyBusiness, buyMeal, hasVacancy, hire, leaveJob, marketBuy, mealPrice, ownerPerson } from "./economy.ts";
import { llmEnabled, llmJson } from "../ai/llm.ts";
import { canWorkAt, SKILL_OF, skillLevel } from "./skillsys.ts";
import { familySummary, isChild, isInfant, isWeddingHours, tryWedding, weddingReady } from "./family.ts";

const JAIL_MINUTES = 6 * 60;

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

function goTo(w: World, a: Agent, x: number, y: number): boolean {
  const p = findPath(w.map, a, { x, y });
  if (!p) return false;
  a.path = p;
  return true;
}

function goToArea(w: World, a: Agent, areaId: string): boolean {
  const area = w.map.areas[areaId];
  if (!area) return false;
  if (areaContains(area, a.x, a.y) && !a.path) return true;
  // Some spots inside an area can be unreachable (e.g. the locked jail cell inside the residence).
  for (let i = 0; i < 6; i++) {
    const s = randomSpotIn(w.map, area);
    if (w.map.areas.jail && areaContains(w.map.areas.jail, s.x, s.y)) continue;
    if (goTo(w, a, s.x, s.y)) return true;
  }
  return false;
}

function inArea(w: World, a: Being, areaId: string): boolean {
  const area = w.map.areas[areaId];
  return !!area && areaContains(area, a.x, a.y);
}

function moveAlongPath(a: Agent, dt: number) {
  if (!a.path || a.path.length === 0) { a.path = null; return; }
  let budget = NPC_SPEED * dt * (a.energy < 10 || a.hunger < 5 ? 0.7 : 1);
  while (budget > 0 && a.path && a.path.length) {
    const wp = a.path[0];
    const dx = wp.x - a.x, dy = wp.y - a.y;
    const d = Math.hypot(dx, dy);
    a.facing = facingFromDir(dx, dy, a.facing);
    if (d <= budget) {
      a.x = wp.x; a.y = wp.y;
      budget -= d;
      a.path.shift();
    } else {
      a.x += (dx / d) * budget;
      a.y += (dy / d) * budget;
      budget = 0;
    }
  }
  if (a.path && a.path.length === 0) a.path = null;
}

function setActivity(w: World, a: Agent, type: ActivityType, label: string, extra: Partial<Activity> = {}) {
  a.activity = { type, label, started: w.time, ...extra };
}

function faceTowards(a: Agent, b: { x: number; y: number }) {
  a.facing = facingFromDir(b.x - a.x, b.y - a.y, a.facing);
}

// ---------------------------------------------------------------------------
// Main per-tick update
// ---------------------------------------------------------------------------

export function tickAgents(w: World, dt: number) {
  for (const a of w.agents.values()) {
    if (a.jailedUntil !== null) {
      if (w.time >= a.jailedUntil) release(w, a);
      else { a.anim = "jail"; a.path = null; continue; }
    }
    moveAlongPath(a, dt);
    updateActivity(w, a);
    if (a.path) a.anim = "walk";
    if (w.time >= a.nextThinkAt && !a.thinking) think(w, a);
  }
}

// ---------------------------------------------------------------------------
// Level 1: utility decisions
// ---------------------------------------------------------------------------

interface Option { type: ActivityType; score: number; label: string; data?: Partial<Activity> }

function think(w: World, a: Agent) {
  a.nextThinkAt = w.time + 8 + Math.random() * 6; // re-evaluate every ~10 game minutes
  if (a.kind === "klumnog") return thinkKlumnog(w, a);
  if (a.activity.type === "talk_player" && a.activity.until && w.time < a.activity.until) {
    // Urgent needs end the conversation politely; otherwise the NPC keeps listening.
    const urgent = a.hunger < 8 || a.energy < 5 || a.goals.some((g) => g.id.startsWith("arrest:") && g.priority > 0.9);
    if (!urgent) return;
    w.say(a.id, a.hunger < 8 ? "Вибач, я ледве на ногах від голоду — мушу йти." : a.energy < 5 ? "Вибач, падаю з ніг. Поговоримо потім." : "Вибач, служба кличе!");
    const pid = a.activity.target;
    if (pid) w.toast(pid, `${a.name} перериває розмову й іде геть.`, "info");
  }

  // Unpaid wages → consider quitting (an "important" decision, resolved deterministically here)
  if (a.jobBiz) {
    const b = w.businesses.get(a.jobBiz);
    const unpaid = b?.unpaidDays[a.id] ?? 0;
    if (b && b.ownerId !== a.id && unpaid >= 2 + Math.round(a.personality.loyalty * 2)) {
      w.say(a.id, `Без платні я не працюю. Прощавай, «${b.name}»!`);
      leaveJob(w, a, "quit");
      removeGoal(a, "unpaid");
    }
  }

  const opts = evaluateOptions(w, a);
  opts.sort((x, y) => y.score - x.score);
  const best = opts[0];
  // Keep doing the current thing if it is still (nearly) the best — avoids jitter.
  if (best.type === a.activity.type && (a.activity.target ?? "") === (best.data?.target ?? "") && best.type !== "wander") return;
  startActivity(w, a, best);
}

/** Children: sleep, eat at home (parents pay), play near a parent. No work, no crime, no romance. */
function childOptions(w: World, a: Agent): Option[] {
  const night = isHourBetween(w.time, 21, 7);
  const opts: Option[] = [];
  if (a.hunger < 45) opts.push({ type: "eat", label: "біжить додому поїсти", score: 1.1 - a.hunger / 100, data: { area: a.home, data: { home: 1 } } });
  if (isInfant(w, a)) {
    opts.push({ type: "sleep", label: "спить у колисці", score: 0.8 });
    return opts;
  }
  opts.push({ type: "sleep", label: "спить", score: (night ? 0.9 : 0) + (1 - a.energy / 100) * 0.6 - (a.energy > 90 ? 0.6 : 0) });
  const parent = (a.parents ?? []).map((id) => w.agents.get(id)).find((p) => p && !w.isJailed(p) && p.anim !== "sleep");
  opts.push({ type: "play", label: parent ? `грається біля ${parent.name}` : "грається", score: 0.5, data: { target: parent?.id } });
  return opts;
}

function evaluateOptions(w: World, a: Agent): Option[] {
  if (isChild(w, a)) return childOptions(w, a);
  const p = a.personality;
  const h = hourOf(w.time);
  const opts: Option[] = [{ type: "wander", score: 0.15, label: "прогулюється" }];
  const job = a.jobBiz ? w.businesses.get(a.jobBiz) : undefined;
  const price = mealPrice(w);

  // Sleep
  const night = isHourBetween(w.time, 22, 6);
  opts.push({ type: "sleep", label: "спить", score: (night ? 0.85 : 0) + (1 - a.energy / 100) * 0.6 - (a.energy > 90 ? 0.6 : 0) });

  // Eat
  if (a.hunger < 45) {
    const recentlyFailed = w.time - (a.flags.eatFailAt ?? -1e9) < 60;
    const urgency = ((1 - a.hunger / 100) * 1.1 + (a.hunger < 15 ? 0.4 : 0)) * (recentlyFailed ? 0.3 : 1);
    if (a.coins >= price || (a.inv.meal ?? 0) > 0) opts.push({ type: "eat", label: "йде поїсти", score: urgency });
    else if ((a.flags.charityDay ?? 0) !== dayOf(w.time))
      opts.push({ type: "eat", label: "просить їжі в храмі", score: urgency * 0.9, data: { area: "temple", data: { charity: 1 } } });
  }

  // Work
  if (job) {
    const [h0, h1] = job.workHours;
    if (h >= h0 && h < h1) {
      const unpaid = job.unpaidDays[a.id] ?? 0;
      opts.push({ type: "work", label: `працює (${job.name})`, score: 0.7 + p.loyalty * 0.15 - unpaid * 0.15, data: { biz: job.id } });
    }
  } else if (a.kind === "npc" && a.profession !== "moneylender" && h >= 7 && h < 17) {
    const vac = findVacancy(w, a);
    if (vac) opts.push({ type: "seek_job", label: `шукає роботу (${vac.name})`, score: 0.65 + (a.coins < 15 ? 0.2 : 0), data: { biz: vac.id } });
  }

  // Socialize (evening at the tavern, or daytime at the market for very social people)
  const evening = isHourBetween(w.time, 18, 22.5);
  const lonely = 1 - a.social / 100;
  if (evening) opts.push({ type: "socialize", label: "відпочиває в таверні", score: 0.4 + p.sociability * 0.3 + lonely * 0.3, data: { area: "tavern" } });
  else if (!night) opts.push({ type: "socialize", label: "пліткує на ринку", score: 0.1 + p.sociability * 0.2 + lonely * 0.25, data: { area: "market" } });

  // Goal-driven options
  for (const g of a.goals) {
    if (g.id.startsWith("wedding:")) {
      const who = g.id.slice("wedding:".length);
      const other = w.being(who);
      if (!other || a.partner !== who || a.partnerStage !== "engaged") { removeGoal(a, g.id); continue; }
      const otherReady = other.kind !== "player" || !!w.players.get(other.id)?.online;
      if (isWeddingHours(w) && otherReady && weddingReady(w, a, other))
        opts.push({ type: "wedding", label: `чекає ${other.name} у храмі на весілля`, score: g.priority, data: { target: who } });
      continue;
    }
    if (g.id.startsWith("arrest:")) {
      const [, suspect] = g.id.split(":");
      const s = w.being(suspect);
      if (!s || w.isJailed(s) || (s.kind === "player" && !w.players.get(s.id)?.online)) continue;
      opts.push({ type: "arrest", label: `переслідує ${s.name}`, score: g.priority * (night ? 0.6 : 1), data: { target: suspect, data: { goal: g.id } } });
    } else if (g.id.startsWith("report:")) {
      if (night) continue;
      opts.push({ type: "report", label: "біжить до варти", score: g.priority, data: { data: { goal: g.id } } });
    } else if (g.id.startsWith("help:")) {
      const [, who] = g.id.split(":");
      const debtor = w.agents.get(who);
      if (!debtor || night) continue;
      const debt = Math.max(0, ...Object.values(debtor.relations).map((r) => r.debt));
      if (debt <= 0) { removeGoal(a, g.id); continue; }
      const affordable = Math.min(a.coins - 3, debt);
      if (affordable >= 5) {
        opts.push({ type: "give", label: `несе гроші для ${debtor.name}`, score: g.priority, data: { target: who, data: { amount: affordable, goal: g.id } } });
      } else if (p.lawfulness < 0.45) {
        // Desperation + love + low lawfulness → theft (emergent story from concept §16)
        opts.push({ type: "steal", label: "щось задумав...", score: g.priority * (1 - p.lawfulness) * 1.2, data: { data: { reason: g.id } } });
      }
    }
  }

  // Hungry and broke → borrow from the moneylender (and get into debt — a classic story engine)
  const lender = [...w.agents.values()].find((x) => x.profession === "moneylender" && !w.isJailed(x));
  if (lender && lender.id !== a.id && a.hunger < 40 && a.coins < price && !night && lender.coins > 30 &&
      (a.relations[lender.id]?.debt ?? 0) < 45 && (a.flags.borrowDay ?? 0) !== dayOf(w.time))
    opts.push({ type: "borrow", label: `іде позичити грошей у ${lender.name}`, score: 0.55 + (1 - a.hunger / 100) * 0.4 - a.personality.lawfulness * 0.1, data: { target: lender.id } });

  // Hungry, broke, low lawfulness → theft
  if (a.hunger < 25 && a.coins < price && p.lawfulness < 0.5 && !night)
    opts.push({ type: "steal", label: "щось задумав...", score: (1 - p.lawfulness) * (1 - a.hunger / 100) });

  // Moneylender collects debts
  if (a.profession === "moneylender" && h >= 10 && h < 18) {
    const debtor = [...w.agents.values()].find((d) => d.relations[a.id]?.debt > 0 && (a.flags[`collect_${d.id}`] ?? 0) !== dayOf(w.time) && !w.isJailed(d));
    if (debtor) opts.push({ type: "collect_debt", label: `іде по борг до ${debtor.name}`, score: 0.6 + p.greed * 0.2, data: { target: debtor.id } });
  }

  // Ambitious merchants buy businesses (concept §11)
  if (p.ambition > 0.7 && h >= 9 && h < 17) {
    const forSale = [...w.businesses.values()].find((b) => b.forSale !== null && a.coins >= b.forSale + 10);
    if (forSale) opts.push({ type: "buy_business", label: `іде купувати «${forSale.name}»`, score: 0.8 + p.ambition * 0.1, data: { biz: forSale.id } });
  }

  // Priest visits the Klumnog at dawn
  if (a.profession === "priest" && isHourBetween(w.time, 6, 7.5) && (a.flags.groveDay ?? 0) !== dayOf(w.time))
    opts.push({ type: "pray", label: "йде до гаю Клумногів", score: 0.9, data: { area: "grove" } });

  return opts;
}

function findVacancy(w: World, a: Agent): Business | null {
  let best: Business | null = null, bestScore = -Infinity;
  for (const b of w.businesses.values()) {
    if (!hasVacancy(b) || !canWorkAt(b, a)) continue;
    const owner = ownerPerson(b);
    const sk = SKILL_OF[b.kind];
    // People prefer work they're good at (their skill makes them more productive and respected).
    const score = b.wage + (owner ? attitude(a, owner) / 20 : 0) - (b.kind === "mine" ? (1 - a.personality.courage) * 3 : 0) + (sk ? skillLevel(a, sk) / 15 : 0);
    if (score > bestScore) { bestScore = score; best = b; }
  }
  return best;
}

function startActivity(w: World, a: Agent, o: Option) {
  const prevType = a.activity.type;
  setActivity(w, a, o.type, o.label, o.data);
  a.anim = "idle";
  switch (o.type) {
    case "sleep": goToArea(w, a, a.home); break;
    case "eat": {
      if ((a.inv.meal ?? 0) > 0 && !o.data?.data) { a.inv.meal!--; a.hunger = Math.min(100, a.hunger + 65); setActivity(w, a, "idle", "їсть"); a.anim = "eat"; break; }
      goToArea(w, a, o.data?.area ?? "tavern");
      break;
    }
    case "work": {
      const b = w.businesses.get(o.data!.biz!)!;
      goToArea(w, a, b.kind === "guard" ? patrolArea() : b.area);
      break;
    }
    case "seek_job": goToArea(w, a, w.businesses.get(o.data!.biz!)!.area); break;
    case "socialize": goToArea(w, a, o.data?.area ?? "tavern"); break;
    case "buy_business": goToArea(w, a, "residence"); break;
    case "wedding": goToArea(w, a, "temple"); break;
    case "play": {
      const parent = o.data?.target ? w.agents.get(o.data.target) : undefined;
      if (parent) goTo(w, a, parent.x + (Math.random() - 0.5) * 2, parent.y + (Math.random() - 0.5) * 2);
      else goToArea(w, a, Math.random() < 0.5 ? a.home : "market");
      break;
    }
    case "pray": goToArea(w, a, "grove"); w.log(`${a.name} іде до гаю Клумногів на світанкову розмову з Ваелем.`, "intent"); break;
    case "report": {
      const guard = nearestGuard(w, a);
      if (guard) { a.activity.target = guard.id; goTo(w, a, guard.x, guard.y); } else goToArea(w, a, "residence");
      break;
    }
    case "steal": {
      const victim = pickVictim(w, a);
      if (!victim) { setActivity(w, a, "wander", "блукає"); break; }
      a.activity.target = victim.id;
      a.activity.until = w.time + 90;
      goTo(w, a, victim.x, victim.y);
      if (prevType !== "steal") w.log(`[намір] ${a.name} вирішує вкрасти в ${victim.name}.`, "intent");
      break;
    }
    case "arrest":
    case "collect_debt":
    case "borrow":
    case "give": {
      const t = w.being(o.data!.target!);
      if (t) goTo(w, a, t.x, t.y);
      a.activity.until = w.time + 150;
      if (o.type === "arrest") w.say(a.id, `Стій, ${t?.name}! Іменем Домініону!`);
      break;
    }
    case "wander": {
      const area = w.map.areas[a.kind === "klumnog" ? "grove" : pickWanderArea(w, a)];
      if (area) { const s = randomSpotIn(w.map, area); goTo(w, a, s.x, s.y); }
      break;
    }
    default: break;
  }
}

function patrolArea(): string {
  const r = ["market", "gate", "market", "south_gate", "tavern_front"];
  const pick = r[Math.floor(Math.random() * r.length)];
  return pick === "tavern_front" ? "market" : pick;
}

function pickWanderArea(w: World, a: Agent): string {
  void w;
  const choices = ["market", "market", a.home, "town"];
  return choices[Math.floor(Math.random() * choices.length)];
}

function nearestGuard(w: World, a: Agent): Agent | null {
  let best: Agent | null = null, bd = Infinity;
  for (const g of w.agents.values()) {
    if (g.jobBiz !== "guard" || w.isJailed(g) || g.id === a.id) continue;
    const d = Math.hypot(g.x - a.x, g.y - a.y);
    if (d < bd) { bd = d; best = g; }
  }
  return best;
}

function pickVictim(w: World, a: Agent): Being | null {
  let best: Being | null = null, bestScore = -Infinity;
  for (const b of w.presentBeings()) {
    if (b.id === a.id || b.kind === "klumnog" || b.coins < 6 || w.isJailed(b) || b.jobBiz === "guard" || isChild(w, b)) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > 35) continue;
    const loved = (a.relations[b.id]?.affection ?? 0) > 30;
    if (loved) continue;
    const score = Math.min(b.coins, 40) / 4 - d / 3 - attitude(a, b.id) / 10 + (b.kind === "player" ? 2 : 0);
    if (score > bestScore) { bestScore = score; best = b; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Activity execution (engine validates & applies)
// ---------------------------------------------------------------------------

function updateActivity(w: World, a: Agent) {
  const act = a.activity;
  if (act.until !== undefined && w.time > act.until && act.type !== "sleep") {
    if (act.type === "arrest") a.nextThinkAt = w.time + 20; // give up the chase for now
    setActivity(w, a, "idle", "стоїть");
    a.path = null;
    return;
  }
  if (a.path) return; // still walking
  switch (act.type) {
    case "sleep":
      if (inArea(w, a, a.home)) { a.anim = "sleep"; if (a.energy >= 99 && !isHourBetween(w.time, 22, 6)) a.nextThinkAt = w.time; }
      break;
    case "work": doWork(w, a); break;
    case "eat": doEat(w, a); break;
    case "socialize":
      a.anim = "idle";
      if (Math.random() < 0.004) { const area = w.map.areas[act.area ?? "tavern"]; const s = randomSpotIn(w.map, area); goTo(w, a, s.x, s.y); }
      break;
    case "seek_job": doSeekJob(w, a); break;
    case "steal": doSteal(w, a); break;
    case "arrest": doArrest(w, a); break;
    case "report": doReport(w, a); break;
    case "collect_debt": doCollect(w, a); break;
    case "give": doGive(w, a); break;
    case "borrow": doBorrow(w, a); break;
    case "buy_business": doBuyBusiness(w, a); break;
    case "wedding":
      if (!inArea(w, a, "temple")) { goToArea(w, a, "temple"); break; }
      a.anim = "idle";
      if (tryWedding(w, a)) { setActivity(w, a, "idle", "щойно одружився(лась)"); a.nextThinkAt = w.time + 20; }
      break;
    case "play": {
      a.anim = "idle";
      const parent = act.target ? w.agents.get(act.target) : undefined;
      if (parent && Math.hypot(parent.x - a.x, parent.y - a.y) > 4 && Math.random() < 0.02) goTo(w, a, parent.x + 1, parent.y + 0.5);
      else if (Math.random() < 0.003) { const s = randomSpotIn(w.map, w.map.areas[w.areaIdAt(a.x, a.y)] ?? w.map.areas.market); goTo(w, a, s.x, s.y); }
      break;
    }
    case "pray":
      a.anim = "pray";
      if (a.profession === "priest") {
        const vael = w.agents.get("vael");
        if (vael && Math.hypot(vael.x - a.x, vael.y - a.y) > 2) goTo(w, a, vael.x + 1, vael.y);
        else if (vael && (a.flags.toldVaelDay ?? 0) !== dayOf(w.time)) {
          // The priest is the Klumnog's only regular link to town news.
          a.flags.toldVaelDay = dayOf(w.time);
          const news = a.memories
            .filter((m) => m.fact && m.importance >= 0.5 && !(m.fact.key in vael.knownFacts))
            .sort((x, y) => y.importance * y.confidence - x.importance * x.confidence)
            .slice(0, 3);
          for (const m of news) learnFact(w, vael, m.fact!, a.id, m.confidence * 0.9);
          w.say(a.id, news.length ? "Ваелю, у місті неспокійно. Послухай..." : "Ваелю, в Каргаті все тихо.");
          if (news.length) w.log(`Отець Мейлан переказує Ваелю новини міста (${news.length}).`, "magic");
        }
        if (w.time - act.started > 45) { a.flags.groveDay = dayOf(w.time); setActivity(w, a, "idle", "повертається"); a.nextThinkAt = w.time; }
      }
      break;
    case "talk_player":
      a.anim = "talk";
      if (act.target) { const p = w.players.get(act.target); if (p) faceTowards(a, p); }
      if (act.until && w.time > act.until) { setActivity(w, a, "idle", "стоїть"); a.nextThinkAt = w.time; }
      break;
    case "wander":
    case "idle":
    default:
      if (a.anim !== "eat" || w.time - act.started > 15) a.anim = "idle";
      break;
  }
}

function doWork(w: World, a: Agent) {
  const b = w.businesses.get(a.activity.biz ?? "");
  if (!b || a.jobBiz !== b.id) { setActivity(w, a, "idle", "стоїть"); return; }
  if (b.kind === "guard") {
    a.anim = "idle";
    if (Math.random() < 0.006) { const area = w.map.areas[patrolArea()]; const s = randomSpotIn(w.map, area); goTo(w, a, s.x, s.y); }
    return;
  }
  if (!inArea(w, a, b.area)) { goToArea(w, a, b.area); return; }
  a.anim = b.kind === "trade" || b.kind === "admin" ? "idle" : b.kind === "temple" ? "pray" : "work";
  if (b.kind === "tavern" || b.kind === "trade") {
    if (Math.random() < 0.004) { const s = randomSpotIn(w.map, w.map.areas[b.area]); goTo(w, a, s.x, s.y); }
  }
}

function doEat(w: World, a: Agent) {
  if (a.activity.data?.home) {
    // Family meal at home; a parent pays for the food.
    if (!inArea(w, a, a.home)) { goToArea(w, a, a.home); return; }
    a.hunger = Math.min(100, a.hunger + 60);
    const payer = (a.parents ?? []).map((id) => w.being(id)).find((p) => p && p.coins >= 2);
    if (payer) { payer.coins -= 2; w.townTreasury += 2; }
    setActivity(w, a, "idle", "їсть удома", { until: w.time + 15 });
    a.anim = "eat";
    return;
  }
  const charity = !!a.activity.data?.charity;
  if (charity) {
    if (!inArea(w, a, "temple")) { goToArea(w, a, "temple"); return; }
    a.flags.charityDay = dayOf(w.time);
    a.hunger = Math.min(100, a.hunger + 40);
    const priest = w.agents.get("meilan");
    if (priest && !w.isJailed(priest)) { adjustRel(a, priest.id, { trust: 5, affection: 4 }); w.say(priest.id, `Їж, ${a.name}. Храм не залишить тебе голодним.`); }
    setActivity(w, a, "idle", "їсть милостиню"); a.anim = "eat";
    return;
  }
  if (!inArea(w, a, "tavern")) { goToArea(w, a, "tavern"); return; }
  const paid = buyMeal(w, a);
  if (paid !== null) {
    setActivity(w, a, "idle", "їсть у таверні", { until: w.time + 20 });
    a.anim = "eat";
    adjustRel(a, "brana", { trust: 0.5 });
    return;
  }
  // Tavern is out of food (or too expensive): buy a meal at the market instead.
  if (w.marketStock("meal") > 0 && marketBuy(w, a, "meal", 1).ok) {
    a.inv.meal = (a.inv.meal ?? 1) - 1;
    if (!a.inv.meal) delete a.inv.meal;
    a.hunger = Math.min(100, a.hunger + 65);
    w.say(a.id, "У таверні порожньо — добре, що на ринку ще є їжа.");
    setActivity(w, a, "idle", "їсть", { until: w.time + 15 });
    a.anim = "eat";
    return;
  }
  // Nothing worked: remember it and don't retry for a while (do other things meanwhile).
  a.flags.eatFailAt = w.time;
  w.say(a.id, a.coins < mealPrice(w) ? "Ех, навіть на миску юшки не вистачає..." : "У таверні вже нічого не лишилося. Прийду пізніше.");
  setActivity(w, a, "idle", "голодний");
  a.nextThinkAt = w.time + 2;
}

function doSeekJob(w: World, a: Agent) {
  const b = w.businesses.get(a.activity.biz ?? "");
  if (!b) return setActivity(w, a, "idle", "стоїть");
  if (!inArea(w, a, b.area)) { goToArea(w, a, b.area); return; }
  if (hasVacancy(b) && canWorkAt(b, a) && !a.jobBiz) {
    // Player-owned businesses: the worker applies, the owner auto-accepts (hiring policy "open").
    w.say(a.id, `Чи потрібні вам руки? Я можу працювати в «${b.name}».`);
    hire(w, b, a);
    removeGoal(a, `${a.id}_g0`);
  }
  setActivity(w, a, "idle", "стоїть");
  a.nextThinkAt = w.time + 2;
}

function doSteal(w: World, a: Agent) {
  const victim = w.being(a.activity.target ?? "");
  if (!victim || w.isJailed(victim) || (victim.kind === "player" && !w.players.get(victim.id)?.online)) { setActivity(w, a, "idle", "стоїть"); return; }
  const d = Math.hypot(victim.x - a.x, victim.y - a.y);
  if (d > 1.3) { goTo(w, a, victim.x, victim.y); return; }
  // The thief judges risk only from what *they* can see (close range) — distant witnesses may still notice.
  const watchers = [...w.presentBeings()].filter((b) => b.id !== a.id && b.id !== victim.id && b.anim !== "sleep" && canSee(w, a, b.x, b.y, 4));
  const guardsNear = watchers.some((b) => b.jobBiz === "guard");
  const tolerated = a.personality.courage > 0.6 ? 1 : 0;
  if (guardsNear || watchers.length > tolerated) {
    if (Math.random() < 0.02) { a.anim = "idle"; } // wait for a better moment, keep following
    if (Math.random() < 0.05) goTo(w, a, victim.x + (Math.random() - 0.5) * 2, victim.y + (Math.random() - 0.5) * 2);
    return;
  }
  const amount = Math.min(victim.coins, 6 + Math.floor(Math.random() * 12));
  victim.coins -= amount;
  a.coins += amount;
  const place = w.areaName(a.x, a.y);
  const f = newFact(w, "theft", { actor: a.id, target: victim.id, amount, place });
  w.log(`${a.name} краде ${amount} срібла в ${victim.name} (${place}).`, "crime");
  // The thief remembers their own deed; the victim may notice.
  learnFact(w, a, f, "self", 1);
  const victimNoticed = Math.random() < 0.55;
  const va = w.agents.get(victim.id);
  if (victimNoticed && va) { learnFact(w, va, f, "self", 0.9); w.say(va.id, `Злодій! ${a.name} мене обікрав!`); }
  const wit = witness(w, f, a.x, a.y, { exclude: [a.id, victim.id] });
  if (wit.length) w.log(`Свідки крадіжки: ${wit.map((x) => x.name).join(", ")}.`, "crime");
  const vp = w.players.get(victim.id);
  if (vp) {
    w.toast(vp.id, victimNoticed ? `${a.name} поцупив у тебе ${amount} срібла!` : `Здається, твій гаманець полегшав на ${amount} срібла...`, "bad");
    w.selfChanged(vp.id);
  }
  setActivity(w, a, "wander", "швидко йде геть");
  const away = randomSpotIn(w.map, w.map.areas[a.home]);
  goTo(w, a, away.x, away.y);
  a.nextThinkAt = w.time + 15;
}

function doArrest(w: World, a: Agent) {
  const s = w.being(a.activity.target ?? "");
  const goalId = a.activity.data?.goal as string | undefined;
  if (!s || w.isJailed(s)) { if (goalId) removeGoal(a, goalId); setActivity(w, a, "idle", "стоїть"); return; }
  const d = Math.hypot(s.x - a.x, s.y - a.y);
  if (d > 1.4) { goTo(w, a, s.x, s.y); return; }
  jail(w, s, a);
  if (goalId) removeGoal(a, goalId);
  for (const g of [...a.goals]) if (g.id.startsWith(`arrest:${s.id}:`)) removeGoal(a, g.id);
  setActivity(w, a, "idle", "виконав арешт");
  a.nextThinkAt = w.time + 10;
}

export function jail(w: World, s: Being, guard: Agent) {
  s.jailedUntil = w.time + JAIL_MINUTES;
  s.lastJailedAt = w.time;
  // Restitution: the thief's stolen coins go back to known victims
  const thief = w.agents.get(s.id);
  const known = guard.memories.filter((m) => m.fact?.type === "theft" && m.fact.actor === s.id);
  for (const m of known) {
    const v = w.being(m.fact!.target ?? "");
    const back = Math.min(s.coins, m.fact!.amount ?? 0);
    if (v && back > 0) { s.coins -= back; v.coins += back; }
  }
  const f = newFact(w, "jailed", { actor: guard.id, target: s.id, place: "В'язниця" });
  learnFact(w, guard, f, "self", 1);
  if (thief) learnFact(w, thief, f, "self", 1);
  witness(w, f, s.x, s.y, { exclude: [guard.id, s.id] });
  w.say(guard.id, `${s.name}, ти заарештований за крадіжку!`);
  w.log(`${guard.name} заарештовує ${s.name}. ${s.name} проведе в'язниці 6 годин.`, "crime");
  if (thief && thief.jobBiz) leaveJob(w, thief, "jailed");
  const jailArea = w.map.areas.jail;
  const spot = randomSpotIn(w.map, jailArea);
  s.x = spot.x; s.y = spot.y;
  s.anim = "jail";
  if (thief) { thief.path = null; setActivity(w, thief, "jail", "у в'язниці"); }
  const p = w.players.get(s.id);
  if (p) {
    p.busy = null;
    w.listener?.teleport(p.id, s.x, s.y);
    w.toast(p.id, `${guard.name} заарештував тебе за крадіжку! 6 годин у в'язниці.`, "bad");
    w.selfChanged(p.id);
  }
}

function release(w: World, a: Being) {
  a.jailedUntil = null;
  const res = w.map.buildings.find((b) => b.key === "residence")!;
  const out = doorOutside(res);
  a.x = out.x + 0.5; a.y = out.y + 0.5;
  a.anim = "idle";
  const f = newFact(w, "released", { target: a.id });
  witness(w, f, a.x, a.y, { exclude: [a.id] });
  w.log(`${a.name} виходить з в'язниці.`, "crime");
  const ag = w.agents.get(a.id);
  if (ag) { setActivity(w, ag, "idle", "щойно вийшов на волю"); ag.nextThinkAt = w.time; ag.title = "Безробітний"; }
  const p = w.players.get(a.id);
  if (p) { w.listener?.teleport(p.id, a.x, a.y); w.toast(p.id, "Тебе випустили з в'язниці.", "info"); w.selfChanged(p.id); }
}

export function releaseIfDue(w: World, b: Being) {
  if (b.jailedUntil !== null && w.time >= b.jailedUntil) release(w, b);
}

function doReport(w: World, a: Agent) {
  const goalId = a.activity.data?.goal as string | undefined;
  const guard = w.agents.get(a.activity.target ?? "") ?? nearestGuard(w, a);
  if (!guard) { setActivity(w, a, "idle", "стоїть"); return; }
  if (Math.hypot(guard.x - a.x, guard.y - a.y) > 2) { goTo(w, a, guard.x, guard.y); return; }
  const factKey = goalId?.slice("report:".length);
  const mem = a.memories.find((m) => m.fact?.key === factKey || m.fact?.key.startsWith(`${factKey}~`));
  if (mem?.fact) {
    learnFact(w, guard, mem.fact, a.id, mem.confidence * 0.95);
    w.say(a.id, `${guard.name}! ${factText(w, mem.fact).replace(/\s*\(день.*\)$/, "")}!`);
    w.log(`${a.name} повідомляє ${guard.name} про крадіжку.`, "crime");
  }
  if (goalId) removeGoal(a, goalId);
  setActivity(w, a, "idle", "стоїть");
  a.nextThinkAt = w.time + 5;
}

function doCollect(w: World, a: Agent) {
  const d = w.agents.get(a.activity.target ?? "");
  if (!d || w.isJailed(d)) { setActivity(w, a, "idle", "стоїть"); return; }
  if (Math.hypot(d.x - a.x, d.y - a.y) > 1.6) { goTo(w, a, d.x, d.y); return; }
  a.flags[`collect_${d.id}`] = dayOf(w.time);
  const r = rel(d, a.id);
  const pay = Math.min(r.debt, Math.max(0, d.coins - 2));
  if (pay >= r.debt && r.debt > 0) {
    d.coins -= pay; a.coins += pay; r.debt = 0;
    const f = newFact(w, "debt_paid", { actor: d.id, target: a.id, amount: pay });
    learnFact(w, a, f, "self", 1); learnFact(w, d, f, "self", 1);
    witness(w, f, d.x, d.y, { exclude: [a.id, d.id] });
    w.say(a.id, `Отак би й одразу. Ми в розрахунку, ${d.name}.`);
    w.log(`${d.name} повністю віддає борг ${a.name} (${pay} срібла).`, "economy");
    removeGoal(d, `${d.id}_g0`);
    for (const ag of w.agents.values()) removeGoal(ag, `help:${d.id}`);
  } else {
    if (pay > 0) { d.coins -= pay; a.coins += pay; r.debt -= pay; }
    r.debt += 3; // interest
    const f = newFact(w, "debt_threat", { actor: a.id, target: d.id, amount: r.debt, place: w.areaName(d.x, d.y) });
    learnFact(w, d, f, "self", 1);
    learnFact(w, a, f, "self", 1);
    witness(w, f, d.x, d.y, { exclude: [a.id, d.id] });
    w.say(a.id, `${d.name}, ти винен мені ${r.debt} срібла. Не змушуй мене чекати — погано скінчиться.`);
    w.say(d.id, "Я... я віддам. Дай ще трохи часу.");
    w.log(`${a.name} погрожує ${d.name} через борг (${r.debt} срібла).`, "intent");
  }
  setActivity(w, a, "idle", "стоїть");
  a.nextThinkAt = w.time + 5;
}

function doBorrow(w: World, a: Agent) {
  const l = w.agents.get(a.activity.target ?? "");
  if (!l || w.isJailed(l)) { setActivity(w, a, "idle", "стоїть"); return; }
  if (Math.hypot(l.x - a.x, l.y - a.y) > 1.6) { goTo(w, a, l.x, l.y); return; }
  a.flags.borrowDay = dayOf(w.time);
  const r = rel(a, l.id);
  // The lender decides by trust and by how much is already owed.
  if (rel(l, a.id).trust < -40 || r.debt > 40 || l.coins < 20) {
    w.say(l.id, `Ти й так мені винен, ${a.name}. Більше не дам.`);
    adjustRel(a, l.id, { trust: -5 });
  } else {
    const loan = 15;
    l.coins -= loan; a.coins += loan; r.debt += 20; // 15 now, 20 back
    w.say(a.id, "Позич п'ятнадцять срібла... віддам, чесне слово.");
    w.say(l.id, `Двадцять поверни. І не змушуй мене тебе шукати, ${a.name}.`);
    w.log(`${a.name} позичає ${loan} срібла в ${l.name} (тепер винен ${r.debt}).`, "economy");
    addGoal(a, `${a.id}_debt`, `Віддати борг ${l.name} (${r.debt})`, 0.7);
  }
  setActivity(w, a, "idle", "стоїть");
  a.nextThinkAt = w.time + 2;
}

function doGive(w: World, a: Agent) {
  const t = w.agents.get(a.activity.target ?? "");
  const amount = Math.min(a.coins, Number(a.activity.data?.amount ?? 0));
  if (!t || w.isJailed(t) || amount <= 0) { setActivity(w, a, "idle", "стоїть"); return; }
  if (Math.hypot(t.x - a.x, t.y - a.y) > 1.6) { goTo(w, a, t.x, t.y); return; }
  a.coins -= amount; t.coins += amount;
  const f = newFact(w, "gift", { actor: a.id, target: t.id, amount });
  learnFact(w, t, f, "self", 1); learnFact(w, a, f, "self", 1);
  witness(w, f, a.x, a.y, { exclude: [a.id, t.id] });
  w.say(a.id, `${t.name}, візьми. Це для твого боргу.`);
  w.say(t.id, `${a.name}... звідки в тебе стільки грошей?`);
  w.log(`${a.name} віддає ${t.name} ${amount} срібла, щоб допомогти з боргом.`, "event");
  const goalId = a.activity.data?.goal as string | undefined;
  if (goalId) removeGoal(a, goalId);
  setActivity(w, a, "idle", "стоїть");
}

function doBuyBusiness(w: World, a: Agent) {
  const b = w.businesses.get(a.activity.biz ?? "");
  if (!b || b.forSale === null) { setActivity(w, a, "idle", "розчарований"); w.say(a.id, "Запізнився... Хтось уже купив."); return; }
  if (!inArea(w, a, "residence")) { goToArea(w, a, "residence"); return; }
  const r = buyBusiness(w, a, b);
  if (r.ok) {
    const deposit = Math.min(a.coins, b.wage * b.maxWorkers * 2);
    a.coins -= deposit; b.treasury += deposit;
    w.say(a.id, `Тепер «${b.name}» — моя. Почнемо справжню справу!`);
    removeGoal(a, `${a.id}_g0`);
    addGoal(a, `${a.id}_grow`, `Розвинути «${b.name}» і найняти робітників`, 0.8);
  }
  setActivity(w, a, "idle", "стоїть");
}

// ---------------------------------------------------------------------------
// Klumnogi
// ---------------------------------------------------------------------------

function thinkKlumnog(w: World, a: Agent) {
  a.nextThinkAt = w.time + 20 + Math.random() * 30;
  if (a.activity.type === "talk_player" && a.activity.until && w.time < a.activity.until) return;
  if (Math.random() < 0.4) { setActivity(w, a, "pray", "медитує"); a.anim = "pray"; a.path = null; return; }
  const s = randomSpotIn(w.map, w.map.areas.grove);
  setActivity(w, a, "wander", "ширяє між руїнами");
  goTo(w, a, s.x, s.y);
}

// ---------------------------------------------------------------------------
// Level 2: important decisions (optionally LLM-driven)
// ---------------------------------------------------------------------------

export interface JobOffer { bizId: string; wage: number; from: string }
export interface JobDecision { action: "ACCEPT" | "STAY" | "NEGOTIATE"; counterWage?: number; reason: string }

/** Deterministic utility evaluation of a job offer — always available. */
export function evaluateJobOffer(w: World, a: Agent, offer: JobOffer): JobDecision {
  const b = w.businesses.get(offer.bizId)!;
  if (isChild(w, a)) return { action: "STAY", reason: "Я ще дитина! Спитай моїх батьків." };
  if (!canWorkAt(b, a))
    return { action: "STAY", reason: "Це не моє ремесло — у мене немає потрібних навичок." };
  const cur = a.jobBiz ? w.businesses.get(a.jobBiz) : undefined;
  if (cur && cur.ownerId === a.id) return { action: "STAY", reason: "У мене є власна справа." };
  const p = a.personality;
  const cw = cur ? cur.wage : 0;
  const gain = (offer.wage - cw) / Math.max(cw, 5);
  const curOwner = cur ? ownerPerson(cur) : null;
  const loyaltyPull = cur ? p.loyalty * (0.5 + (curOwner ? attitude(a, curOwner) : 0) / 100) : 0;
  const unpaid = cur ? (cur.unpaidDays[a.id] ?? 0) * 0.35 : 0;
  const trustNew = attitude(a, offer.from) / 100;
  const fearNew = (a.relations[offer.from]?.trust ?? 0) < -30 ? 0.6 : 0;
  const pressure = a.coins < 10 ? 0.3 : 0;
  const score = gain * (0.4 + p.greed) + trustNew * 0.4 + unpaid + pressure - loyaltyPull * 0.6 - fearNew + (cur ? 0 : 0.8);
  if (score > 0.15) return { action: "ACCEPT", reason: cur ? "Платня краща, ризик прийнятний." : "Мені потрібна робота." };
  if (score > -0.25 && p.greed > 0.45) return { action: "NEGOTIATE", counterWage: Math.max(offer.wage + 2, cw + 3), reason: "Цікаво, але за такі гроші не варто ризикувати." };
  return { action: "STAY", reason: cur ? `Мені добре в «${cur.name}».` : "Не довіряю цій пропозиції." };
}

/** Build the compact context for the LLM (concept §33.4) — only what the character knows. */
export function agentContext(w: World, a: Agent, focusIds: string[] = []): string {
  const p = a.personality;
  const job = a.jobBiz ? w.businesses.get(a.jobBiz) : undefined;
  const mems = [...a.memories]
    .filter((m) => focusIds.length === 0 || m.subjects.some((s) => focusIds.includes(s)) || m.importance > 0.6)
    .sort((x, y) => y.importance * y.confidence - x.importance * x.confidence)
    .slice(0, 8)
    .map((m) => `- ${m.text} (впевненість ${Math.round(m.confidence * 100)}%)`);
  const rels = focusIds.map((id) => {
    const r = a.relations[id];
    return r ? `- ${w.nameOf(id)}: довіра ${Math.round(r.trust)}, симпатія ${Math.round(r.affection)}, страх ${Math.round(r.fear)}${r.debt ? `, я винен ${r.debt}` : ""}` : `- ${w.nameOf(id)}: незнайомець`;
  });
  return [
    `IDENTITY: ${a.name}, ${a.title}, раса Dratorianie, фракція ${a.faction}`,
    `PERSONALITY: greed ${p.greed}, loyalty ${p.loyalty}, ambition ${p.ambition}, courage ${p.courage}, lawfulness ${p.lawfulness}, empathy ${p.empathy}`,
    `STATE: гроші ${a.coins}, ситість ${Math.round(a.hunger)}/100, енергія ${Math.round(a.energy)}/100, робота: ${job ? `${job.name} за ${job.wage}/день (неоплачених днів: ${job.unpaidDays[a.id] ?? 0})` : "немає"}`,
    `FAMILY: ${familySummary(w, a).join("; ") || "немає"}`,
    `GOALS:\n${a.goals.map((g) => `- ${g.text}`).join("\n") || "- жити далі"}`,
    `RELATIONSHIPS:\n${rels.join("\n") || "-"}`,
    `RELEVANT MEMORIES:\n${mems.join("\n") || "- нічого особливого"}`,
  ].join("\n");
}

const DECISION_SYSTEM =
  "Ти — модуль прийняття рішень для NPC у фентезійній симуляції Rutzarg. " +
  "Ти обираєш НАМІР персонажа лише з дозволених дій, спираючись на його характер, пам'ять і стосунки. " +
  "Відповідай ЛИШЕ JSON: {\"action\": \"ACCEPT\"|\"STAY\"|\"NEGOTIATE\", \"counterWage\": number?, \"reason\": \"коротко українською від першої особи\"}";

/**
 * Decision event: an agent receives a job offer. Resolved via LLM when available,
 * otherwise via utility evaluation. The engine re-validates before applying.
 */
export function requestJobDecision(w: World, a: Agent, offer: JobOffer, done?: (d: JobDecision) => void) {
  const apply = (d: JobDecision) => {
    a.thinking = false;
    const b = w.businesses.get(offer.bizId);
    // Re-validate against the *current* world state (it may have changed while reasoning).
    if (d.action === "ACCEPT" && (!b || !hasVacancy(b) || b.wage < offer.wage - 0.01 || w.isJailed(a) || !canWorkAt(b, a))) {
      d = { action: "STAY", reason: "Пропозиція вже неактуальна." };
    }
    const f = newFact(w, "job_offer", { actor: offer.from, target: a.id, biz: offer.bizId, amount: offer.wage });
    learnFact(w, a, f, "self", 1);
    if (d.action === "ACCEPT" && b) hire(w, b, a);
    w.log(`Рішення ${a.name} щодо роботи в «${b?.name}»: ${d.action}${d.counterWage ? ` (${d.counterWage})` : ""} — ${d.reason}`, "decision");
    done?.(d);
  };
  const fallback = evaluateJobOffer(w, a, offer);
  if (!llmEnabled() || fallback.reason.startsWith("Це не моє ремесло") || fallback.reason.startsWith("У мене є власна") || fallback.reason.startsWith("Я ще дитина")) {
    apply(fallback);
    return;
  }
  a.thinking = true;
  const b = w.businesses.get(offer.bizId)!;
  const cur = a.jobBiz ? w.businesses.get(a.jobBiz) : undefined;
  const user = [
    agentContext(w, a, [offer.from, ...(cur ? [ownerPerson(cur) ?? ""] : [])].filter(Boolean)),
    `EVENT: ${w.nameOf(offer.from)} пропонує роботу в «${b.name}» (${b.jobTitle}) за ${offer.wage} срібла/день.`,
    `AVAILABLE ACTIONS: ACCEPT, STAY, NEGOTIATE (попросити більше — вкажи counterWage)`,
    `Utility-оцінка рушія (для довідки): ${fallback.action}`,
  ].join("\n");
  const prio = w.players.has(offer.from) ? 0 : 1;
  llmJson<{ action?: string; counterWage?: number; reason?: string }>(DECISION_SYSTEM, user, prio).then((r) => {
    const action = r?.action?.toUpperCase();
    if (action === "ACCEPT" || action === "STAY" || action === "NEGOTIATE") {
      apply({ action, counterWage: action === "NEGOTIATE" ? Math.round(Number(r!.counterWage) || offer.wage + 2) : undefined, reason: String(r!.reason ?? "").slice(0, 200) || fallback.reason });
    } else apply(fallback);
  });
}
