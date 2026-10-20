// Basic needs for every being (players and NPCs use the same rules).

import type { World } from "./world.ts";

export const HUNGER_DECAY = 100 / (18 * 60); // per game minute
export const ENERGY_DECAY = 100 / (20 * 60);
export const ENERGY_SLEEP_REGEN = 100 / (7 * 60);
export const SOCIAL_DECAY = 100 / (16 * 60);

export function tickNeeds(w: World, gdt: number) {
  for (const b of w.presentBeings()) {
    if (b.kind === "klumnog") continue;
    b.hunger = Math.max(0, b.hunger - HUNGER_DECAY * gdt);
    // no bed in an overfull home: a bench or the floor — a poor night
    if (b.anim === "sleep") b.energy = Math.min(100, b.energy + ENERGY_SLEEP_REGEN * gdt * ((b as { flags?: Record<string, number> }).flags?.noBed ? 0.55 : 1));
    else {
      // Klumnogi blessing: "the ancient light does not let you tire as fast as others"
      const blessed = (b as { blessing?: boolean }).blessing ? 0.5 : 1;
      b.energy = Math.max(0, b.energy - ENERGY_DECAY * gdt * (b.anim === "work" ? 1.5 : 1) * blessed);
    }
  }
  for (const a of w.agents.values()) {
    if (a.kind === "klumnog") continue;
    a.social = Math.max(0, a.social - SOCIAL_DECAY * gdt);
  }
}
