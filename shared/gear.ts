// Equipment: what a character wears and holds. Shared by the server (rules) and the client (character panel).
// Every worn thing is an ordinary item: crafted, bought, sold, stolen... and it wears out with use.

import { ITEMS, type ItemId, type Slot } from "./items.ts";

export const SLOTS: Slot[] = ["head", "body", "legs", "feet", "weapon", "offhand"];

export const SLOT_NAMES: Record<Slot, string> = {
  head: "Голова", body: "Тіло", legs: "Ноги", feet: "Взуття", weapon: "Зброя / знаряддя", offhand: "Друга рука",
};

/** A worn item and its condition 0..100 (0 = falls apart). */
export interface Worn { item: ItemId; dur: number }

export type Equipment = Partial<Record<Slot, Worn>>;

export interface CharStats {
  attack: number;
  armor: number;
  presence: number;
  /** Fighting strength: weapon + armour + combat skill. Decides scuffles (resisting arrest...). */
  power: number;
  /** Gathering / work speed bonus per resource from the held tool (0.6 = +60%). */
  gather: Partial<Record<ItemId, number>>;
}

/** Bare hands: 1 attack. */
export function gearStats(eq: Equipment | undefined, combatSkill = 0): CharStats {
  let attack = 1, armor = 0, presence = 0;
  const gather: Partial<Record<ItemId, number>> = {};
  for (const w of Object.values(eq ?? {})) {
    if (!w) continue;
    const st = ITEMS[w.item]?.stats;
    if (!st) continue;
    // a badly worn thing gives less
    const k = w.dur < 25 ? 0.6 : 1;
    attack += (st.attack ?? 0) * k;
    armor += (st.armor ?? 0) * k;
    presence += (st.presence ?? 0) * k;
    for (const [item, v] of Object.entries(st.gather ?? {}) as [ItemId, number][]) gather[item] = Math.max(gather[item] ?? 0, v * k);
  }
  const power = attack + armor * 0.8 + combatSkill / 5;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { attack: r(attack), armor: r(armor), presence: r(presence), power: r(power), gather };
}

/** Condition loss per use. Tools/weapons wear when used, clothes wear daily. */
export const WEAR = {
  gather: 1,      // per gathered unit (player)
  workHour: 1,    // per worked hour with the tool (NPC jobs)
  daily: 3,       // clothes and armour, every day
  fight: 3,       // weapon and armour in a scuffle
};

export function condLabel(dur: number): string {
  if (dur >= 80) return "нове";
  if (dur >= 50) return "поношене";
  if (dur >= 25) return "зношене";
  return "ледь тримається";
}
