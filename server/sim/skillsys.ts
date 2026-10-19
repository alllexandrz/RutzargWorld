// Skill progression: a skill grows when it is used (concept: "learning by doing").

import type { World } from "./world.ts";
import type { Being, Business, BusinessKind } from "./types.ts";
import { SKILLS, QUALIFIED_LEVEL, type SkillId, skillRank } from "../../shared/skills.ts";

/** Which skill a job trains/uses. */
export const SKILL_OF: Partial<Record<BusinessKind, SkillId>> = {
  lumber: "woodcutting", mine: "mining", quarry: "mining", farm: "farming", smithy: "smithing",
  tavern: "cooking", trade: "trading", guard: "combat", construction: "building",
};

export function skillLevel(b: Being, s: SkillId): number {
  return b.skills?.[s] ?? 0;
}

/**
 * Use a skill: the level rises with diminishing returns (fast for novices, slow for masters).
 * `amount` ≈ 1 for an hour of work or one gathered item.
 */
export function trainSkill(w: World, b: Being, s: SkillId, amount: number) {
  b.skills ??= {};
  const before = b.skills[s] ?? 0;
  const after = Math.min(100, before + amount * 0.32 * (1 - before / 110));
  b.skills[s] = Math.round(after * 100) / 100;
  if (Math.floor(after / 5) > Math.floor(before / 5)) {
    if (w.players.has(b.id)) {
      w.toast(b.id, `${SKILLS[s].name}: ${Math.floor(after)} (${skillRank(after)})`, "good");
      w.selfChanged(b.id);
    }
    if (Math.floor(after / 25) > Math.floor(before / 25) && after >= 25)
      w.log(`${b.name}: навичка «${SKILLS[s].name}» досягла ${Math.floor(after)} — ${skillRank(after)}.`, "skill");
  }
}

/** Can this being be hired at this business? Class OR proven skill (social mobility, §21A.6). */
export function canWorkAt(b: Business, being: Being): boolean {
  if (b.allowedClasses.includes(being.socialClass)) return true;
  const s = SKILL_OF[b.kind];
  return !!s && skillLevel(being, s) >= QUALIFIED_LEVEL;
}
