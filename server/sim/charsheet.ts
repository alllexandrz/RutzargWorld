// The player's character sheet (panel I): who you are in Karhat and what people think of you.
// Reputation is not a number the engine keeps — it is read from what NPCs actually remember and feel.

import type { World } from "./world.ts";
import type { Fact, Player } from "./types.ts";
import type { CharInfo } from "../../shared/protocol.ts";
import { CLASS_NAMES, FACTION_NAMES } from "./types.ts";
import { ITEMS, type ItemId } from "../../shared/items.ts";
import { attitude, factText, FACT_IMPORTANCE } from "./social.ts";
import { adults, guards } from "./politics.ts";
import { statsOf } from "./gear.ts";

export function charInfo(w: World, p: Player): CharInfo {
  const people = adults(w);
  let known = 0, friends = 0, foes = 0, trust = 0, respect = 0, fear = 0;
  const opinions: { name: string; v: number }[] = [];
  const rumors = new Map<string, { f: Fact; n: number }>();
  for (const a of people) {
    const r = a.relations[p.id];
    if (r) {
      known++;
      const v = attitude(a, p.id);
      if (v >= 20) friends++;
      if (v <= -20) foes++;
      trust += r.trust; respect += r.respect; fear += r.fear;
      opinions.push({ name: a.name, v: Math.round(v) });
    }
    for (const m of a.memories) {
      const f = m.fact;
      if (!f || f.actor !== p.id || f.type === "met" || m.confidence < 0.3) continue;
      const cur = rumors.get(f.key);
      if (cur) cur.n++;
      else rumors.set(f.key, { f, n: 1 });
    }
  }
  const avg = (x: number) => (known ? Math.round(x / known) : 0);
  opinions.sort((x, y) => y.v - x.v);

  const roles: string[] = [];
  const P = w.politics;
  if (P.reeve === p.id) roles.push(p.gender === "f" ? "Старостиня Каргата" : "Староста Каргата");
  if (P.election?.candidates.includes(p.id)) roles.push("Кандидат на виборах");
  if (P.petition.includes(p.id)) roles.push("Підписав петицію про відставку");
  const sworn = (P.conspiracy[p.id] ?? []).length;
  if (sworn) roles.push(`Змова: на твоєму боці ${sworn} з ${guards(w).length} вартових`);
  if (p.blessing) roles.push("Благословенний Клумногом");

  const job = p.jobBiz ? w.businesses.get(p.jobBiz) : undefined;
  const gather: Record<string, number> = {};
  for (const [item, v] of Object.entries(statsOf(p).gather) as [ItemId, number][]) gather[ITEMS[item].name] = Math.round(v * 100);

  return {
    name: p.name, gender: p.gender,
    socialClass: CLASS_NAMES[p.socialClass], faction: FACTION_NAMES[p.faction],
    job: job ? `${job.name} (${job.wage} срібла/день)` : null,
    businesses: p.ownedBusinesses.map((id) => w.businesses.get(id)?.name ?? id),
    roles,
    daysInWorld: p.joinedAt !== undefined ? Math.floor((w.time - p.joinedAt) / 1440) : null,
    location: w.areaName(p.x, p.y),
    gather,
    reputation: { known, friends, foes, trust: avg(trust), respect: avg(respect), fear: avg(fear), adults: people.length },
    friends: opinions.filter((o) => o.v > 5).slice(0, 4),
    foes: opinions.filter((o) => o.v < -5).reverse().slice(0, 4),
    rumors: [...rumors.values()]
      .sort((x, y) => y.n * FACT_IMPORTANCE[y.f.type] - x.n * FACT_IMPORTANCE[x.f.type])
      .slice(0, 8)
      .map((r) => ({ text: factText(w, r.f), n: r.n })),
    lastJailed: p.lastJailedAt ?? null,
  };
}
