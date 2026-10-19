// Client-side view of the world (render state only — never authoritative).

import type { ChronicleEntry, EntSnap, PlotInfo, SelfState } from "../../shared/protocol.ts";

export interface SnapFrame { at: number; ents: Map<string, EntSnap> }

export const state = {
  myId: "",
  token: "",
  time: 0,
  timeAt: 0, // performance.now() when `time` was received
  minutesPerSecond: 1,
  self: null as SelfState | null,
  snaps: [] as SnapFrame[],
  chronicle: [] as ChronicleEntry[],
  selectedId: null as string | null,
  /** Locally predicted position of my character (tile units). */
  myPos: { x: 0, y: 0 },
  /** Latest building-plot states (may arrive before the Phaser scene exists). */
  plots: [] as PlotInfo[],
  /** Tile diffs received before the scene existed. */
  tiles: [] as [number, number, number, number][],
  sceneReady: false,
};

/** Interpolated game time for display. */
export function gameNow(): number {
  return state.time + ((performance.now() - state.timeAt) / 1000) * state.minutesPerSecond;
}

export function pushSnap(ents: EntSnap[]) {
  const map = new Map<string, EntSnap>();
  for (const e of ents) map.set(e.id, e);
  state.snaps.push({ at: performance.now(), ents: map });
  if (state.snaps.length > 30) state.snaps.shift();
}

export function latestEnt(id: string): EntSnap | undefined {
  return state.snaps[state.snaps.length - 1]?.ents.get(id);
}
