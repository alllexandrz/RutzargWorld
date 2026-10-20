// Town politics: who rules Kargat and how power changes hands.
// A small-scale prototype of the big game's faction politics (concept §3.5–3.6, §4 paths):
//   - lawful path:    reputation → candidacy → campaign → election (or recall by petition)
//   - economic path:  owning businesses, paying people well, donating to the town
//   - criminal path:  conspiracy with the guard → coup (low legitimacy, fear, grudges)
//   - the office:     taxes, town wages, privatisation, pardons — and the temptation to steal.
// NPCs use the very same mechanics: they sign petitions, run for office, vote, plot and embezzle.

import type { World } from "./world.ts";
import type { Agent, Being, Business, Politics } from "./types.ts";
import { adjustRel, attitude, learnFact, newFact, witness } from "./social.ts";
import { businessValue, hire, leaveJob, ledgerToday, setTownRep } from "./economy.ts";
import { isChild } from "./family.ts";
import { bedsShort } from "./construction.ts";
import { jail, release } from "./brain.ts";
import { statsOf } from "./gear.ts";
import { areaContains } from "../../shared/map.ts";
import { dayOf, hourOf } from "../../shared/time.ts";

const TERM_DAYS = 30;
const CAMPAIGN_MINUTES = 1440 + 9 * 60; // called at 9:00, votes counted next day at 18:00
const CANDIDATE_FEE = 25;
const PETITION_SHARE = 0.4;
const REEVE_SALARY = 12; // for a player reeve (NPC reeves are paid through the town hall job)
const PRIVATISABLE = new Set(["lumber", "mine", "quarry", "farm"]);
export const TAX_STEPS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3];

export function initialPolitics(): Politics {
  return {
    reeve: "aldric", since: 0, how: "founding", legitimacy: 65, taxRate: 0.05,
    nextElection: TERM_DAYS * 1440 + 9 * 60, election: null, petition: [], conspiracy: {}, approval: 0.2, history: [],
  };
}

/** First election a few days after the world (or this feature) starts — so players see one soon. */
export function firstElectionAt(now: number): number {
  return (Math.floor(now / 1440) + 4) * 1440 + 9 * 60;
}

export function reeveId(w: World): string {
  return w.politics.reeve;
}

function chronicle(w: World, text: string) {
  w.log(text, "politics");
  w.politics.history.push({ t: w.time, text });
  if (w.politics.history.length > 40) w.politics.history.shift();
}

/** Tell the whole town (town crier + gossip). */
function announce(w: World, f: ReturnType<typeof newFact>, confidence = 0.9) {
  for (const a of w.agents.values()) if (a.kind === "npc") learnFact(w, a, f, "self", confidence);
}

export function adults(w: World): Agent[] {
  return [...w.agents.values()].filter((a) => a.kind === "npc" && !isChild(w, a));
}

// ---------------------------------------------------------------------------
// Public opinion
// ---------------------------------------------------------------------------

/** How well life goes for this person (-1..1) — people credit or blame whoever rules. */
function welfare(w: World, a: Agent): number {
  let s = 0;
  const job = a.jobBiz ? w.businesses.get(a.jobBiz) : undefined;
  if (job) s += (job.unpaidDays[a.id] ?? 0) > 0 ? -0.3 : 0.15;
  else if (a.profession !== "moneylender") s -= 0.25;
  if (a.hunger < 30) s -= 0.15;
  if (a.coins < 10) s -= 0.1;
  if (a.home && bedsShort(w, a.home) > 0) s -= 0.15;
  const owns = [...w.businesses.values()].some((b) => b.ownerId === a.id);
  if (owns) s -= w.politics.taxRate * 2;
  return s;
}

/** Bad deeds of a politician this person believes in. */
function scandals(a: Agent, who: string): number {
  let n = 0;
  for (const m of a.memories) {
    const f = m.fact;
    if (!f || f.actor !== who) continue;
    if (f.type === "theft") n += 0.4 * m.confidence;
    if (f.type === "embezzle" || f.type === "coup" || f.type === "conspiracy" || f.type === "coup_failed") n += 0.6 * m.confidence;
    if (f.type === "vote_buying") n += 0.3 * m.confidence * a.personality.lawfulness * 2;
  }
  return Math.min(1.5, n);
}

/** Approval of the current reeve (-1..1). */
export function approvalOf(w: World, a: Agent): number {
  const r = reeveId(w);
  if (a.id === r) return 1;
  const v = attitude(a, r) / 60 + welfare(w, a) + (w.politics.legitimacy - 50) / 200 - scandals(a, r) * 0.5;
  return Math.max(-1, Math.min(1, v));
}

export function refreshApproval(w: World) {
  const ad = adults(w).filter((a) => a.id !== reeveId(w));
  w.politics.approval = ad.length ? ad.reduce((n, a) => n + approvalOf(w, a), 0) / ad.length : 0;
}

/** How much `voter` wants `cand` as reeve. */
export function voteScore(w: World, voter: Agent, cand: string): number {
  if (voter.id === cand) return 10;
  const el = w.politics.election;
  let s = attitude(voter, cand) / 40;
  if (cand === reeveId(w)) s += (welfare(w, voter) + (w.politics.legitimacy - 50) / 200) * 1.2;
  else s += 0.05 - welfare(w, voter) * 0.6; // hard times favour challengers
  if (el && (voter.flags[`camp_${cand}`] ?? -1) >= el.startedAt) s += 0.3;
  if (el && (voter.flags[`bribe_${cand}`] ?? -1) >= el.startedAt) s += voter.personality.greed > 0.5 ? 0.4 : -0.3;
  const c = w.being(cand);
  if (c && c.socialClass === voter.socialClass) s += 0.1;
  if (c) s += statsOf(c).presence * 0.02; // people judge by looks
  if (w.players.get(cand)?.blessing) s += 0.15;
  if (voter.spouse === cand || voter.partner === cand || voter.parents?.includes(cand) || voter.children?.includes(cand)) s += 1;
  const job = voter.jobBiz ? w.businesses.get(voter.jobBiz) : undefined;
  if (job && job.ownerId === cand) s += (job.unpaidDays[voter.id] ?? 0) > 0 ? -0.3 : 0.2;
  s -= scandals(voter, cand);
  return s;
}

/** Whom this NPC would vote for right now (null = stays home). */
export function voteOf(w: World, voter: Agent): string | null {
  const el = w.politics.election;
  if (!el || w.isJailed(voter)) return null;
  let best: string | null = null, bs = -0.4;
  for (const c of el.candidates) {
    const s = voteScore(w, voter, c);
    if (s > bs) { bs = s; best = c; }
  }
  return best;
}

/** Current standing: votes per candidate (NPC intentions + votes players already cast). */
export function tally(w: World): Record<string, number> {
  const el = w.politics.election;
  const out: Record<string, number> = {};
  if (!el) return out;
  for (const c of el.candidates) out[c] = 0;
  for (const a of adults(w)) { const v = voteOf(w, a); if (v) out[v]++; }
  for (const v of Object.values(el.playerVotes)) if (v in out) out[v]++;
  return out;
}

// ---------------------------------------------------------------------------
// Changing hands
// ---------------------------------------------------------------------------

function changeReeve(w: World, id: string, how: Politics["how"], share = 50) {
  const P = w.politics;
  const oldId = P.reeve;
  const old = w.agents.get(oldId);
  const hall = w.businesses.get("admin");
  if (old && oldId !== id) {
    if (old.jobBiz === "admin") leaveJob(w, old, "quit");
    old.name = old.name.replace(/^Староста\s+/, "");
    old.title = old.gender === "f" ? "Колишня старостиня" : "Колишній староста";
  }
  const oldPlayer = w.players.get(oldId);
  if (oldPlayer && oldId !== id) { w.toast(oldPlayer.id, "Ти більше не староста Каргата.", "bad"); w.selfChanged(oldPlayer.id); }
  P.reeve = id;
  P.since = w.time;
  P.how = how;
  P.legitimacy = how === "coup" ? 15 : how === "elected" ? Math.max(35, Math.min(95, 30 + share * 0.7)) : 60;
  P.petition = [];
  P.conspiracy = {};
  setTownRep(id);
  const neu = w.agents.get(id);
  if (neu && hall) {
    if (neu.jobBiz && neu.jobBiz !== "admin") leaveJob(w, neu, "quit");
    hall.workers = hall.workers.filter((x) => x !== oldId);
    if (!hall.workers.includes(neu.id)) hire(w, hall, neu);
    neu.title = neu.gender === "f" ? "Старостиня" : "Староста";
  }
  const pl = w.players.get(id);
  if (pl) { w.toast(pl.id, how === "coup" ? "Влада твоя — але люди бояться, а не довіряють. Керуй у панелі «Громада» (G)." : "Ти — староста Каргата! Керуй у панелі «Громада» (G).", "good"); w.selfChanged(pl.id); }
}

// ---------------------------------------------------------------------------
// Elections & petitions
// ---------------------------------------------------------------------------

export function startElection(w: World, reason: "term" | "recall") {
  const P = w.politics;
  if (P.election) return;
  P.election = { reason, startedAt: w.time, endsAt: Math.floor(w.time / 60) * 60 + CAMPAIGN_MINUTES, candidates: [], playerVotes: {} };
  const inc = w.being(P.reeve);
  if (inc && !w.isJailed(inc)) P.election.candidates.push(P.reeve);
  const f = newFact(w, "election_called", { place: reason, amount: P.election.endsAt });
  announce(w, f, 1);
  chronicle(w, reason === "recall"
    ? `Петицію підписало достатньо людей: дострокові вибори старости! Голоси порахують ${dayLabel(P.election.endsAt)}.`
    : `Минув термін старости — вибори! Голоси порахують ${dayLabel(P.election.endsAt)}.`);
  for (const p of w.players.values()) w.toast(p.id, "Вибори старости! Висунутися й проголосувати — у резиденції (панель «Громада», G).", "info");
  npcCandidacies(w);
}

function dayLabel(t: number): string {
  return `у день ${dayOf(t)} о ${Math.floor(hourOf(t))}:00`;
}

/** Register a candidate (players pay a fee; NPCs decide by ambition). */
export function registerCandidate(w: World, b: Being): { ok: boolean; reason: string } {
  const el = w.politics.election;
  if (!el) return { ok: false, reason: "Зараз немає виборів." };
  if (el.candidates.includes(b.id)) return { ok: false, reason: "Ти вже кандидат." };
  if (w.isJailed(b)) return { ok: false, reason: "З в'язниці не балотуються." };
  if (w.players.has(b.id)) {
    if (b.coins < CANDIDATE_FEE) return { ok: false, reason: `Внесок кандидата — ${CANDIDATE_FEE} срібла.` };
    b.coins -= CANDIDATE_FEE;
    w.townTreasury += CANDIDATE_FEE;
  }
  el.candidates.push(b.id);
  const f = newFact(w, "candidate", { actor: b.id });
  announce(w, f, 0.9);
  chronicle(w, `${b.name} висувається на виборах старости.`);
  return { ok: true, reason: `Ти кандидат! Агітуй людей у розмовах. Голоси порахують ${dayLabel(el.endsAt)}.` };
}

function npcCandidacies(w: World) {
  const P = w.politics;
  const challengers = adults(w)
    .filter((a) => a.id !== P.reeve && !w.isJailed(a) && a.coins >= 20 &&
      (a.goals.some((g) => g.id === "regain_power") || a.personality.ambition >= 0.75))
    .map((a) => ({ a, want: a.personality.ambition + (a.goals.some((g) => g.id === "regain_power") ? 0.5 : 0) - P.approval * 0.5 + Math.random() * 0.2 }))
    .filter((x) => x.want > 0.85)
    .sort((x, y) => y.want - x.want)
    .slice(0, 2);
  for (const { a } of challengers) {
    registerCandidate(w, a);
    w.say(a.id, "Каргату потрібна нова рука. Голосуйте за мене!");
  }
}

export function castVote(w: World, p: Being, cand: string): { ok: boolean; reason: string } {
  const el = w.politics.election;
  if (!el) return { ok: false, reason: "Зараз немає виборів." };
  if (!el.candidates.includes(cand)) return { ok: false, reason: "Такого кандидата немає." };
  el.playerVotes[p.id] = cand;
  return { ok: true, reason: `Твій голос — за ${w.nameOf(cand)}.` };
}

function finishElection(w: World) {
  const P = w.politics;
  const el = P.election!;
  const votes = tally(w);
  const total = Object.values(votes).reduce((n, v) => n + v, 0);
  // ties keep the incumbent
  const ranked = Object.entries(votes).sort((x, y) => y[1] - x[1] || Number(y[0] === P.reeve) - Number(x[0] === P.reeve));
  P.election = null;
  P.nextElection = w.time + TERM_DAYS * 1440;
  for (const a of w.agents.values()) for (const k of Object.keys(a.flags)) if (k.startsWith("camp_") || k.startsWith("bribe_")) delete a.flags[k];
  if (!ranked.length) { chronicle(w, "Вибори не відбулися — ніхто не балотувався."); return; }
  const [winner, n] = ranked[0];
  const share = total ? Math.round((n / total) * 100) : 0;
  const results = ranked.map(([c, v]) => `${w.nameOf(c)} — ${v}`).join(", ");
  const kept = winner === P.reeve;
  if (!kept) changeReeve(w, winner, "elected", share);
  else { P.legitimacy = Math.max(P.legitimacy, Math.min(95, 30 + share * 0.7)); P.petition = []; P.how = P.how === "coup" ? "elected" : P.how === "founding" ? "elected" : P.how; }
  const f = newFact(w, "elected", { actor: winner, amount: share });
  announce(w, f, 1);
  chronicle(w, `Підсумки виборів: ${results}. ${kept ? `${w.nameOf(winner)} лишається старостою` : `Новий староста — ${w.nameOf(winner)}`} (${share}%).`);
  for (const [c] of ranked.slice(1)) {
    const loser = w.agents.get(c);
    if (loser) adjustRel(loser, winner, { trust: -5 });
  }
  void el;
}

export function signPetition(w: World, b: Being): { ok: boolean; reason: string } {
  const P = w.politics;
  if (b.id === P.reeve) return { ok: false, reason: "Сам проти себе?" };
  if (P.election) return { ok: false, reason: "Вибори вже йдуть." };
  if (P.petition.includes(b.id)) return { ok: false, reason: "Підпис уже стоїть." };
  P.petition.push(b.id);
  checkPetition(w);
  return { ok: true, reason: `Підписано (${P.petition.length}/${petitionNeeded(w)}).` };
}

export function petitionNeeded(w: World): number {
  return Math.max(3, Math.ceil(adults(w).length * PETITION_SHARE));
}

function checkPetition(w: World) {
  const P = w.politics;
  P.petition = P.petition.filter((id) => w.being(id));
  if (!P.election && P.petition.length >= petitionNeeded(w)) startElection(w, "recall");
}

// ---------------------------------------------------------------------------
// Conspiracy & coup
// ---------------------------------------------------------------------------

export function guards(w: World): Agent[] {
  return [...w.agents.values()].filter((a) => a.jobBiz === "guard" && !w.isJailed(a));
}

/** A guard decides whether to side with a plotter (bribe in coins). Refusing lawful guards report it. */
export function conspire(w: World, plotter: Being, g: Agent, bribe: number): { joined: boolean; reply: string } {
  const P = w.politics;
  if (plotter.id === P.reeve) return { joined: false, reply: "Ти ж і так староста." };
  const pe = g.personality;
  const score = attitude(g, plotter.id) - attitude(g, P.reeve) + (50 - P.legitimacy) * 0.5 - pe.lawfulness * 30 - pe.loyalty * 10
    + pe.greed * Math.min(60, bribe) * 1.2 + (P.approval < -0.2 ? 15 : 0);
  if (score > 10) {
    const sworn = (P.conspiracy[plotter.id] ??= []);
    if (!sworn.includes(g.id)) sworn.push(g.id);
    if (bribe > 0) { plotter.coins -= bribe; g.coins += bribe; }
    adjustRel(g, plotter.id, { trust: 5 });
    return { joined: true, reply: `Тихіше... Я з тобою. Скажеш, коли — і варта не заважатиме. (на твоєму боці: ${sworn.length} з ${guards(w).length} вартових)` };
  }
  if (pe.lawfulness > 0.6 || attitude(g, P.reeve) > 20) {
    const f = newFact(w, "conspiracy", { actor: plotter.id, target: P.reeve });
    learnFact(w, g, f, "self", 1);
    const r = w.agents.get(P.reeve);
    if (r) learnFact(w, r, f, g.id, 0.9);
    for (const o of guards(w)) learnFact(w, o, f, g.id, 0.85);
    chronicle(w, `${g.name} доповідає: ${plotter.name} підбиває варту на змову!`);
    return { joined: false, reply: `Змова проти старости? Ти це серйозно? Я доповім куди слід, ${plotter.name}.` };
  }
  return { joined: false, reply: "Я цього не чув. І ти мені нічого не казав." };
}

/** Take the town hall by force. Needs the majority of the guard. */
export function attemptCoup(w: World, plotter: Being): { ok: boolean; reason: string } {
  const P = w.politics;
  const all = guards(w);
  const sworn = (P.conspiracy[plotter.id] ?? []).filter((id) => all.some((g) => g.id === id));
  const oldId = P.reeve;
  if (sworn.length * 2 > all.length && sworn.length > 0) {
    changeReeve(w, plotter.id, "coup");
    const f = newFact(w, "coup", { actor: plotter.id, target: oldId, place: "Резиденція старости" });
    announce(w, f, 0.95);
    const ex = w.agents.get(oldId);
    if (ex) learnFact(w, ex, f, "self", 1);
    chronicle(w, `ПЕРЕВОРОТ! ${plotter.name} з вартою (${sworn.map((id) => w.nameOf(id)).join(", ")}) захоплює резиденцію. ${w.nameOf(oldId)} усунуто від влади.`);
    w.say(plotter.id, "Відтепер Каргатом правлю я. Хто проти — до в'язниці.");
    // the guard now takes orders from the new ruler
    for (const g of all) g.goals = g.goals.filter((x) => !x.id.startsWith(`arrest:${plotter.id}:`));
    // Honest guards won't serve a usurper.
    for (const g of all) if (!sworn.includes(g.id) && g.personality.lawfulness > 0.7) {
      w.say(g.id, "Я присягав громаді, а не узурпаторові. Знімаю значок.");
      leaveJob(w, g, "quit");
    }
    return { ok: true, reason: "Влада твоя." };
  }
  const f = newFact(w, "coup_failed", { actor: plotter.id, target: oldId });
  announce(w, f, 0.9);
  chronicle(w, `${plotter.name} намагається захопити владу, але варта не підтримує (${sworn.length} з ${all.length}).`);
  P.conspiracy[plotter.id] = [];
  const loyal = all.find((g) => !sworn.includes(g.id));
  if (loyal && !w.isJailed(plotter)) jail(w, plotter, loyal, "спробу перевороту");
  return { ok: false, reason: `Варта не з тобою (${sworn.length} з ${all.length}). Тебе заарештовано.` };
}

// ---------------------------------------------------------------------------
// The office: taxes, wages, privatisation, pardons, embezzlement, donations
// ---------------------------------------------------------------------------

export function setTax(w: World, rate: number) {
  const P = w.politics;
  const r = TAX_STEPS.reduce((best, x) => (Math.abs(x - rate) < Math.abs(best - rate) ? x : best), 0);
  if (r === P.taxRate) return;
  const up = r > P.taxRate;
  P.taxRate = r;
  const f = newFact(w, "tax_change", { actor: P.reeve, amount: Math.round(r * 100) });
  announce(w, f, 0.9);
  // owners feel it in their purse
  for (const b of w.businesses.values()) {
    const o = b.ownerId ? w.agents.get(b.ownerId) : undefined;
    if (o) adjustRel(o, P.reeve, { trust: up ? -8 : 6 });
  }
  chronicle(w, `${w.nameOf(P.reeve)} ${up ? "підвищує" : "знижує"} податок для справ до ${Math.round(r * 100)}% виручки.`);
}

/** Daily tax at 19:00: a share of each private business's revenue. */
function collectTaxes(w: World) {
  const rate = w.politics.taxRate;
  if (rate <= 0) return;
  for (const b of w.businesses.values()) {
    if (!b.ownerId || b.ownerId === "town") continue;
    const l = ledgerToday(w, b);
    const tax = Math.min(Math.floor(b.treasury), Math.round(l.revenue * rate));
    if (tax <= 0) continue;
    b.treasury -= tax;
    w.townTreasury += tax;
    l.tax = (l.tax ?? 0) + tax;
  }
}

export function isPrivatisable(b: Business): boolean {
  return b.ownerId === "town" && PRIVATISABLE.has(b.kind) && !!b.product;
}

/** Price the town asks (reeve's goodwill matters). null = not to this buyer. */
export function privatePrice(w: World, b: Business, buyerId: string): { price: number | null; reason: string } {
  if (!isPrivatisable(b)) return { price: null, reason: "Це не продається." };
  const r = w.agents.get(reeveId(w));
  if (r) {
    if (r.memories.some((m) => m.fact?.actor === buyerId && (m.fact.type === "theft" || m.fact.type === "conspiracy" || m.fact.type === "coup_failed")))
      return { price: null, reason: "Майно громади злодіям і змовникам не продаємо." };
    if (attitude(r, buyerId) < 5) return { price: null, reason: "Я тебе надто мало знаю, щоб довірити майно громади. Зароби довіру — тоді поговоримо." };
  }
  const att = r ? attitude(r, buyerId) : 0;
  return { price: Math.round(businessValue(w, b) * 1.5 * (1 - att / 300)), reason: "" };
}

export function privatise(w: World, b: Business, buyer: Being, price: number): { ok: boolean; reason: string } {
  if (!isPrivatisable(b)) return { ok: false, reason: "Це не продається." };
  if (buyer.coins < price) return { ok: false, reason: `Потрібно ${price} срібла.` };
  buyer.coins -= price;
  w.townTreasury += price;
  b.ownerId = buyer.id;
  b.forSale = null;
  b.vacancyDays = 0;
  const p = w.players.get(buyer.id);
  if (p) { p.ownedBusinesses.push(b.id); w.selfChanged(p.id); }
  const f = newFact(w, "privatized", { actor: buyer.id, biz: b.id, amount: price, place: "Резиденція старости" });
  announce(w, f, 0.8);
  chronicle(w, `${buyer.name} викуповує в громади «${b.name}» за ${price} срібла. Працівники лишаються на тих самих умовах.`);
  return { ok: true, reason: `«${b.name}» тепер твоя.` };
}

export function pardon(w: World, prisonerId: string): { ok: boolean; reason: string } {
  const s = w.being(prisonerId);
  if (!s || !w.isJailed(s)) return { ok: false, reason: "Такого в'язня немає." };
  release(w, s);
  const f = newFact(w, "pardon", { actor: reeveId(w), target: s.id });
  announce(w, f, 0.8);
  const a = w.agents.get(s.id);
  if (a) adjustRel(a, reeveId(w), { trust: 20, affection: 10 });
  chronicle(w, `${w.nameOf(reeveId(w))} милує ${s.name}.`);
  return { ok: true, reason: `${s.name} на волі.` };
}

/** The reeve takes coins from the treasury. Whoever sees it — or audits later — will talk. */
export function embezzle(w: World, r: Being, amount: number): { ok: boolean; reason: string } {
  amount = Math.max(1, Math.min(60, Math.floor(amount), Math.floor(w.townTreasury)));
  if (r.id !== reeveId(w)) return { ok: false, reason: "Ти не староста." };
  w.townTreasury -= amount;
  r.coins += amount;
  const f = newFact(w, "embezzle", { actor: r.id, amount });
  const seen = witness(w, f, r.x, r.y, { exclude: [r.id] });
  w.log(`[таємно] ${r.name} бере зі скарбниці ${amount} срібла.`, "intent");
  if (seen.length) chronicle(w, `Свідки бачать, як ${r.name} кладе гроші громади собі в кишеню.`);
  else (w.politics.hidden ??= []).push({ t: w.time, amount, actor: r.id }); // the books remember
  return { ok: true, reason: `+${amount} срібла. ${seen.length ? `Тебе бачили: ${seen.map((x) => x.name).join(", ")}!` : "Здається, ніхто не бачив..."}` };
}

export function donate(w: World, b: Being, amount: number): { ok: boolean; reason: string } {
  amount = Math.floor(amount);
  if (amount < 5) return { ok: false, reason: "Щонайменше 5 срібла." };
  if (b.coins < amount) return { ok: false, reason: "Не вистачає грошей." };
  b.coins -= amount;
  w.townTreasury += amount;
  const f = newFact(w, "donation", { actor: b.id, amount });
  witness(w, f, b.x, b.y, { exclude: [b.id] });
  const r = w.agents.get(reeveId(w));
  if (r) learnFact(w, r, f, "self", 1);
  if (amount >= 30) announce(w, f, 0.7);
  chronicle(w, `${b.name} жертвує громаді ${amount} срібла.`);
  return { ok: true, reason: `Дякуємо! Скарбниця: ${Math.round(w.townTreasury)}.` };
}

/** Political talk: a campaign visit during an election. */
export function campaign(w: World, cand: Being, voter: Agent): string {
  const el = w.politics.election;
  if (!el || !el.candidates.includes(cand.id)) return "Ти ж навіть не кандидат.";
  if ((voter.flags[`camp_${cand.id}`] ?? -1) >= el.startedAt) return "Ти вже казав(ла). Я подумаю.";
  voter.flags[`camp_${cand.id}`] = w.time;
  const pick = voteOf(w, voter);
  if (pick === cand.id) return "Мій голос — твій. Не підведи Каргат.";
  const s = voteScore(w, voter, cand.id), best = pick ? voteScore(w, voter, pick) : -1;
  if (s > best - 0.3) return `Чесно, вагаюся між тобою і ${w.nameOf(pick)}. Покажи, що ти вартий(а) довіри.`;
  return pick ? `Вибач, я за ${w.nameOf(pick)}.` : "Політика — не моє. Може, й не піду голосувати.";
}

/** Money to a voter from a candidate during an election (a gift is a gift... until someone calls it a bribe). */
export function noteBribe(w: World, giver: Being, voter: Agent, amount: number) {
  const el = w.politics.election;
  if (!el || !el.candidates.includes(giver.id)) return;
  voter.flags[`bribe_${giver.id}`] = w.time;
  const f = newFact(w, "vote_buying", { actor: giver.id, target: voter.id, amount });
  witness(w, f, voter.x, voter.y, { exclude: [giver.id, voter.id] });
  if (voter.personality.lawfulness > 0.65) learnFact(w, voter, f, "self", 1);
}

// ---------------------------------------------------------------------------
// NPC politics (the same rules)
// ---------------------------------------------------------------------------

/** NPC reeve's daily governing: taxes by temperament and treasury; greedy crooks steal. */
function npcGoverns(w: World, r: Agent) {
  const P = w.politics;
  let target = 0.04 + r.personality.greed * 0.12;
  if (w.townTreasury < 150) target += 0.05;
  if (P.approval < -0.2) target -= 0.05;
  const step = TAX_STEPS.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), 0);
  if (step !== P.taxRate) setTax(w, step > P.taxRate ? Math.min(step, P.taxRate + 0.05) : Math.max(step, P.taxRate - 0.05));
  if (r.personality.lawfulness < 0.35 && r.personality.greed > 0.6 && w.townTreasury > 120 && Math.random() < 0.5)
    embezzle(w, r, 5 + Math.floor(Math.random() * 12));
  // ambitious townsfolk buy town property
  const forSale = [...w.businesses.values()].filter(isPrivatisable);
  if (!forSale.length || Math.random() > 0.3) return;
  for (const a of adults(w).sort((x, y) => y.personality.ambition - x.personality.ambition)) {
    if (a.personality.ambition < 0.75 || w.isJailed(a)) continue;
    for (const b of forSale) {
      const { price } = privatePrice(w, b, a.id);
      if (price !== null && a.coins >= price + 20) { privatise(w, b, a, price); return; }
    }
  }
}

/** Unhappy people sign the recall petition; plotters work on the guard. */
function npcOpinions(w: World) {
  const P = w.politics;
  if (!P.election) {
    for (const a of adults(w)) {
      if (P.petition.includes(a.id) || a.id === P.reeve || w.isJailed(a)) continue;
      const ap = approvalOf(w, a);
      if (ap < -0.25 && Math.random() < 0.5 + a.personality.courage * 0.3) {
        P.petition.push(a.id);
        if (Math.random() < 0.3) w.log(`${a.name} підписує петицію за відставку старости.`, "politics");
      }
    }
    checkPetition(w);
  }
  // Plotters: ousted rulers and ruthless ambitious people, when the rule is shaky.
  if (P.legitimacy >= 40 && P.approval > -0.15) return;
  for (const a of adults(w)) {
    if (a.id === P.reeve || w.isJailed(a) || a.jobBiz === "guard") continue;
    const ousted = a.goals.some((g) => g.id === "regain_power");
    if (!ousted && !(a.personality.ambition >= 0.8 && a.personality.lawfulness <= 0.35)) continue;
    if (Math.random() > 0.4) continue;
    for (const g of guards(w)) {
      if ((P.conspiracy[a.id] ?? []).includes(g.id)) continue;
      const r = conspire(w, a, g, Math.min(20, Math.floor(a.coins / 4)));
      if (!r.joined && g.personality.lawfulness > 0.6) break; // exposed — lie low
    }
    const all = guards(w), sworn = (P.conspiracy[a.id] ?? []).filter((id) => all.some((g) => g.id === id));
    if (sworn.length * 2 > all.length) { attemptCoup(w, a); return; }
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function onHourPolitics(w: World, hour: number) {
  const P = w.politics;
  refreshApproval(w);
  if (P.election && w.time >= P.election.endsAt) finishElection(w);
  if (!P.election && hour === 9 && w.time >= P.nextElection) startElection(w, "term");
  if (hour === 18) {
    const pr = w.players.get(P.reeve);
    if (pr && w.townTreasury >= REEVE_SALARY) { w.townTreasury -= REEVE_SALARY; pr.coins += REEVE_SALARY; w.selfChanged(pr.id); }
  }
  if (hour === 19) collectTaxes(w);
  if (hour === 8) npcOpinions(w);
  if (hour === 10) {
    const r = w.agents.get(P.reeve);
    if (r && !w.isJailed(r)) npcGoverns(w, r);
  }
}

/** Someone honest looks into the town books; the more is missing, the likelier it shows. */
function audit(w: World) {
  const P = w.politics;
  const hidden = P.hidden ?? [];
  if (!hidden.length) return;
  const total = hidden.reduce((n, h) => n + h.amount, 0);
  if (Math.random() > Math.min(0.7, 0.15 + total / 80)) return;
  const auditor = adults(w).filter((a) => !hidden.some((h) => h.actor === a.id) && a.personality.lawfulness > 0.55 && !w.isJailed(a))
    .sort(() => Math.random() - 0.5)[0];
  if (!auditor) return;
  const actor = hidden[0].actor;
  const f = newFact(w, "embezzle", { actor, amount: total });
  learnFact(w, auditor, f, "self", 0.85); // and gossip does the rest
  chronicle(w, `${auditor.name} перевіряє книги: зі скарбниці зникло ${total} срібла. Підозра падає на ${w.nameOf(actor)}.`);
  P.hidden = [];
}

export function onDayPolitics(w: World) {
  const P = w.politics;
  audit(w);
  // Legitimacy follows public mood slowly; time in office itself makes rule "normal".
  P.legitimacy = Math.max(0, Math.min(100, P.legitimacy + (P.approval > 0 ? 1 + P.approval * 3 : P.approval * 6) + (P.how === "coup" ? 0.5 : 0)));
  // A jailed reeve can't govern: an emergency election.
  const r = w.being(P.reeve);
  if ((!r || w.isJailed(r)) && !P.election) startElection(w, "recall");
}

/** One line for the LLM prompt / inspector: who rules and what's going on. */
export function politicsLine(w: World, a?: Agent): string {
  const P = w.politics;
  const parts = [`староста ${w.nameOf(P.reeve)} (${P.how === "coup" ? "захопив владу силою" : P.how === "elected" ? "обраний" : "давній"}), податок ${Math.round(P.taxRate * 100)}%`];
  if (P.election) parts.push(`йдуть вибори: ${P.election.candidates.map((c) => w.nameOf(c)).join(", ")}${a ? `; я голосую за: ${w.nameOf(voteOf(w, a)) || "не знаю"}` : ""}`);
  if (a && a.id !== P.reeve) {
    const ap = approvalOf(w, a);
    parts.push(`моє ставлення до старости: ${ap > 0.3 ? "підтримую" : ap < -0.25 ? "незадоволений, хочу відставки" : "так собі"}`);
  }
  return parts.join("; ");
}

/** Physical presence: political paperwork happens at the residence. */
export function atResidence(w: World, b: Being): boolean {
  return areaContains(w.map.areas.residence, b.x, b.y);
}

