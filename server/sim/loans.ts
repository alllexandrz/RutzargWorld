// Loans for players: borrow from any townsperson who trusts you (or from the moneylender, who lends
// to almost anyone — at his price). Interest, a due date, and consequences: penalty interest,
// gossip about the debtor, and finally the lender goes to the guards (debtors' prison).
// NPCs borrow from the moneylender through brain.ts (doBorrow) and keep the debt in Relation.debt.

import type { World } from "./world.ts";
import type { Agent, Player } from "./types.ts";
import { adjustRel, attitude, learnFact, newFact, rel, witness, addGoal } from "./social.ts";
import { isChild } from "./family.ts";
import { dayOf } from "../../shared/time.ts";

export interface Loan { lender: string; principal: number; owe: number; due: number; since: number; overdueDays: number; reported?: boolean }

const DAY = 1440;

function isFamily(a: Agent, p: Player): boolean {
  return a.spouse === p.id || a.partner === p.id || !!a.children?.includes(p.id) || !!a.parents?.includes(p.id);
}

/** What this NPC would lend the player and on what terms (null = won't). */
export function loanTerms(w: World, a: Agent, p: Player): { max: number; rate: number; days: number; why?: string } {
  if (isChild(w, a) || a.kind !== "npc") return { max: 0, rate: 0, days: 0, why: "Я ще мала(ий) для таких справ." };
  const owedHere = (p.loans ?? []).filter((l) => l.lender === a.id).reduce((n, l) => n + l.owe, 0);
  const overdue = (p.loans ?? []).some((l) => l.overdueDays > 0);
  const r = rel(a, p.id);
  if (a.profession === "moneylender") {
    if (r.trust < -30 || owedHere > 60) return { max: 0, rate: 0, days: 0, why: `Ти й так мені винен ${owedHere}. Спершу віддай.` };
    const thief = a.memories.some((m) => m.fact?.type === "theft" && m.fact.actor === p.id);
    const max = Math.max(0, Math.min(80 - owedHere, Math.floor(a.coins - 30)));
    // the moneylender's living: a third on top, half for the shady and the already-late
    return { max, rate: thief || overdue ? 0.5 : 0.33, days: 3 };
  }
  if (isFamily(a, p)) return { max: Math.max(0, Math.floor(a.coins * 0.5) - owedHere), rate: 0, days: 10 };
  const att = attitude(a, p.id);
  if (overdue) return { max: 0, rate: 0, days: 0, why: "Кажуть, ти не віддаєш боргів. Ні, не позичу." };
  if (att < 15 || r.trust < 10) return { max: 0, rate: 0, days: 0, why: "Я тебе ще надто мало знаю, щоб позичати гроші." };
  const max = Math.max(0, Math.min(Math.floor(a.coins * 0.3), 40) - owedHere);
  if (max < 3) return { max: 0, rate: 0, days: 0, why: "Самому б хто позичив..." };
  // good friends lend cheaper; the greedy want more
  const rate = Math.max(0, Math.round((0.1 + a.personality.greed * 0.25 - (att - 15) / 300 - a.personality.empathy * 0.08) * 100) / 100);
  return { max, rate, days: 5 };
}

export function borrow(w: World, a: Agent, p: Player, amount: number): { ok: boolean; reply: string } {
  const t = loanTerms(w, a, p);
  amount = Math.floor(amount);
  if (t.max <= 0) return { ok: false, reply: t.why ?? "Ні." };
  if (amount <= 0) return { ok: false, reply: `Скільки тобі треба? Можу дати до ${t.max} срібла${t.rate ? `, повернеш з ${Math.round(t.rate * 100)}% зверху` : " без відсотків"}, за ${t.days} дн.` };
  if (amount > t.max) return { ok: false, reply: `Стільки не дам. Найбільше — ${t.max} срібла.` };
  const owe = Math.ceil(amount * (1 + t.rate));
  a.coins -= amount; p.coins += amount;
  (p.loans ??= []).push({ lender: a.id, principal: amount, owe, due: w.time + t.days * DAY, since: w.time, overdueDays: 0 });
  rel(a, p.id).debt -= owe; // they owe me (negative = the other side owes)
  const f = newFact(w, "loan", { actor: a.id, target: p.id, amount });
  learnFact(w, a, f, "self", 1);
  witness(w, f, a.x, a.y, { exclude: [a.id, p.id] });
  w.log(`${p.name} позичає ${amount} срібла в ${a.name} (повернути ${owe} до дня ${dayOf(w.time + t.days * DAY)}).`, "economy");
  w.selfChanged(p.id);
  return { ok: true, reply: a.profession === "moneylender"
    ? `Тримай ${amount}. Повернеш ${owe} — за ${t.days} дн. І пам'ятай: я завжди знаходжу боржників.`
    : t.rate ? `Ну гаразд, тримай ${amount}. Повернеш ${owe} за ${t.days} дн.` : `Тримай ${amount}. Віддаси, як зможеш — тільки не забудь.` };
}

/** Pay back (all of it by default). */
export function repay(w: World, a: Agent, p: Player, amount?: number): { ok: boolean; reply: string } {
  const loans = (p.loans ?? []).filter((l) => l.lender === a.id).sort((x, y) => x.due - y.due);
  if (!loans.length) return { ok: false, reply: "Ти мені нічого не винен." };
  let budget = Math.min(p.coins, Math.floor(amount ?? Infinity));
  if (budget <= 0) return { ok: false, reply: "З порожніми кишенями борг не віддають." };
  let paid = 0;
  for (const l of loans) {
    const x = Math.min(budget, l.owe);
    l.owe -= x; budget -= x; paid += x;
    if (budget <= 0) break;
  }
  p.coins -= paid; a.coins += paid;
  rel(a, p.id).debt += paid;
  const done = loans.filter((l) => l.owe <= 0);
  p.loans = (p.loans ?? []).filter((l) => l.owe > 0);
  if (done.length) {
    const late = done.some((l) => l.overdueDays > 0);
    adjustRel(a, p.id, { trust: late ? 3 : 8, respect: late ? 0 : 4 });
    const f = newFact(w, "debt_paid", { actor: p.id, target: a.id, amount: paid });
    learnFact(w, a, f, "self", 1);
    for (const g of [...w.agents.values()].filter((x) => x.jobBiz === "guard"))
      g.goals = g.goals.filter((x) => !x.id.startsWith(`arrest:${p.id}:debt#${a.id}`));
  }
  w.selfChanged(p.id);
  const left = (p.loans ?? []).filter((l) => l.lender === a.id).reduce((n, l) => n + l.owe, 0);
  return { ok: true, reply: left > 0 ? `Отримав ${paid}. Ще за тобою ${left}.` : `Ми в розрахунку. ${done.some((l) => l.overdueDays > 0) ? "Хоч і з запізненням." : "Приємно мати з тобою справу."}` };
}

export function owedTo(p: Player, lender: string): number {
  return (p.loans ?? []).filter((l) => l.lender === lender).reduce((n, l) => n + l.owe, 0);
}

/** Every morning: late loans grow, lenders lose patience, and finally call the guards. */
export function onDayLoans(w: World) {
  for (const p of w.players.values()) {
    for (const l of p.loans ?? []) {
      if (w.time < l.due) continue;
      const a = w.agents.get(l.lender);
      if (!a) continue;
      l.overdueDays++;
      const penalty = Math.max(1, Math.ceil(l.principal * 0.1));
      l.owe += penalty;
      rel(a, p.id).debt -= penalty;
      adjustRel(a, p.id, { trust: -6, affection: -3 });
      const f = newFact(w, "debt_threat", { actor: a.id, target: p.id, amount: l.owe, place: w.areaName(a.x, a.y) });
      learnFact(w, a, f, "self", 1);
      w.toast(p.id, `Борг ${a.name} прострочено (${l.overdueDays} дн.): тепер ${l.owe} срібла. ${l.overdueDays >= 3 ? "Кредитор іде до варти!" : "Поверни, поки не пізно."}`, "bad");
      // after three days the lender goes to the guards: debtors' prison
      if (l.overdueDays >= 3 && !l.reported) {
        l.reported = true;
        w.log(`${a.name} скаржиться варті: ${p.name} не віддає борг (${l.owe} срібла).`, "crime");
        for (const g of w.agents.values()) if (g.jobBiz === "guard" && !w.isJailed(g))
          addGoal(g, `arrest:${p.id}:debt#${a.id}#${dayOf(w.time)}`, `Заарештувати ${p.name} (борги)`, 0.75);
      }
    }
  }
}

/** Jailed debtor: what's in the purse goes to the creditors. */
export function seizeForDebts(w: World, p: Player) {
  for (const l of [...(p.loans ?? [])].filter((x) => x.overdueDays > 0)) {
    const a = w.agents.get(l.lender);
    if (!a || p.coins <= 0) continue;
    const x = Math.min(p.coins, l.owe);
    p.coins -= x; a.coins += x; l.owe -= x;
    rel(a, p.id).debt += x;
    l.reported = false;
    l.overdueDays = 1; // still late: another complaint in two days unless paid
    w.log(`З ${p.name} стягують на користь ${a.name}: ${x} срібла.`, "economy");
  }
  p.loans = (p.loans ?? []).filter((l) => l.owe > 0);
}
