// Skills: any character can learn any skill; a skill grows by using it (concept §6, §21A).

export type SkillId = "woodcutting" | "mining" | "farming" | "herbalism" | "smithing" | "carpentry" | "cooking" | "building" | "trading" | "combat";

export const SKILLS: Record<SkillId, { name: string; verb: string }> = {
  woodcutting: { name: "Лісорубство", verb: "рубає ліс" },
  mining: { name: "Гірництво", verb: "добуває руду й камінь" },
  farming: { name: "Хліборобство", verb: "працює в полі" },
  herbalism: { name: "Травництво", verb: "збирає трави" },
  smithing: { name: "Ковальство", verb: "кує" },
  carpentry: { name: "Теслярство", verb: "майструє з дерева" },
  cooking: { name: "Кулінарія", verb: "куховарить" },
  building: { name: "Будівництво", verb: "будує" },
  trading: { name: "Торгівля", verb: "торгує" },
  combat: { name: "Бій", verb: "несе варту" },
};

export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];

export type Skills = Partial<Record<SkillId, number>>;

/** Productivity multiplier from skill level 0..100 → 0.5..1.5. */
export function skillMult(level: number | undefined): number {
  return 0.5 + Math.max(0, Math.min(100, level ?? 0)) / 100;
}

/** Skill needed to be hired outside one's social class ("qualification", §21A.6). */
export const QUALIFIED_LEVEL = 30;

/** Rank label for a skill level. */
export function skillRank(level: number): string {
  if (level >= 80) return "майстер";
  if (level >= 55) return "досвідчений";
  if (level >= 30) return "кваліфікований";
  if (level >= 10) return "учень";
  return "новачок";
}
