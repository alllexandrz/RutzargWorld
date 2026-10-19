import { MINUTES_PER_DAY } from "./constants.ts";

/** Game time is an integer-ish number of game minutes since world creation. */
export function dayOf(min: number): number {
  return Math.floor(min / MINUTES_PER_DAY) + 1;
}

export function minuteOfDay(min: number): number {
  return ((min % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function hourOf(min: number): number {
  return minuteOfDay(min) / 60;
}

export function fmtClock(min: number): string {
  const m = Math.floor(minuteOfDay(min));
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function fmtDayTime(min: number): string {
  return `День ${dayOf(min)}, ${fmtClock(min)}`;
}

/** 0 = full day, 1 = deep night. Smooth dusk (19-21h) and dawn (5-7h). */
export function darkness(min: number): number {
  const h = hourOf(min);
  if (h >= 7 && h < 19) return 0;
  if (h >= 21 || h < 5) return 1;
  if (h >= 19) return (h - 19) / 2;
  return 1 - (h - 5) / 2;
}

export function isHourBetween(min: number, from: number, to: number): boolean {
  const h = hourOf(min);
  return from <= to ? h >= from && h < to : h >= from || h < to;
}
