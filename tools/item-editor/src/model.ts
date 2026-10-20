// Editor state: the draft game data, selection, undo/redo, the game's copy (for the diff) and change notifications.

import { exportGameData, gameReference, validateGameData, type GameData, type GameReference, type Problem } from "../../../shared/gamedata.ts";
import type { ItemDef } from "../../../shared/items.ts";
import type { Recipe } from "../../../shared/crafting.ts";

export type View = "graph" | "table" | "gather" | "diff";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Defaults compiled into this editor (the game's code, without any game-data file). */
export const BUILTIN: GameData = exportGameData("built-in");

export const state = {
  data: clone(BUILTIN) as GameData,
  /** What the game runs with (last import) — for "changes" and "new item" markers. */
  game: clone(BUILTIN) as GameData,
  ref: (BUILTIN.reference ?? gameReference()) as GameReference,
  selected: null as string | null,
  view: "graph" as View,
  skill: 0,
  problems: [] as Problem[],
  log: [] as { t: string; text: string; kind: "info" | "good" | "bad" }[],
};

type Listener = () => void;
const listeners: Listener[] = [];
export function onChange(fn: Listener) { listeners.push(fn); }
export function emit() { state.problems = validateGameData(state.data); for (const f of listeners) f(); saveDraft(); }

// ---------------------------------------------------------------------------
// Undo / redo — whole-document snapshots (the data is small)
// ---------------------------------------------------------------------------

const undo: string[] = [];
const redo: string[] = [];

/** Change the draft. Every edit goes through here so it can be undone. */
export function edit(label: string, fn: (d: GameData) => void) {
  undo.push(JSON.stringify(state.data));
  if (undo.length > 200) undo.shift();
  redo.length = 0;
  fn(state.data);
  log(label);
  emit();
}

export function canUndo() { return undo.length > 0; }
export function canRedo() { return redo.length > 0; }
export function doUndo() { const s = undo.pop(); if (!s) return; redo.push(JSON.stringify(state.data)); state.data = JSON.parse(s); fixSelection(); emit(); }
export function doRedo() { const s = redo.pop(); if (!s) return; undo.push(JSON.stringify(state.data)); state.data = JSON.parse(s); fixSelection(); emit(); }

/** Replace the whole document (import / open / reset) — undoable too. */
export function load(d: GameData, label: string, asGame = false) {
  undo.push(JSON.stringify(state.data));
  redo.length = 0;
  state.data = clone({ ...d, reference: undefined });
  if (d.reference) state.ref = d.reference;
  if (asGame) state.game = clone(d);
  fixSelection();
  log(label, "good");
  emit();
}

function fixSelection() {
  if (state.selected && !item(state.selected)) state.selected = null;
  if (!state.selected) state.selected = state.data.items[0]?.id ?? null;
}

export function select(id: string | null) {
  state.selected = id;
  for (const f of listeners) f();
}

export function log(text: string, kind: "info" | "good" | "bad" = "info") {
  state.log.push({ t: new Date().toLocaleTimeString(), text, kind });
  if (state.log.length > 300) state.log.shift();
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function item(id: string): ItemDef | undefined { return state.data.items.find((x) => x.id === id); }
export function recipeOf(id: string): Recipe | undefined { return state.data.recipes.find((r) => r.out === id); }
export function usedIn(id: string): Recipe[] { return state.data.recipes.filter((r) => id in r.inputs); }
export function itemName(id: string): string { return item(id)?.name ?? id; }
export function isNewItem(id: string): boolean { return !state.game.items.some((x) => x.id === id) && !BUILTIN.items.some((x) => x.id === id); }

/** Changed compared with what the game runs with. */
export function isModified(id: string): boolean {
  const a = item(id), b = state.game.items.find((x) => x.id === id);
  if (!a || !b) return false;
  const ra = recipeOf(id), rb = state.game.recipes.find((r) => r.out === id);
  return JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(ra ?? null) !== JSON.stringify(rb ?? null)
    || JSON.stringify(state.data.gatherTools[id as keyof typeof state.data.gatherTools] ?? null) !== JSON.stringify(state.game.gatherTools[id as keyof typeof state.game.gatherTools] ?? null);
}

export function problemsFor(id: string): Problem[] {
  return state.problems.filter((p) => p.where.includes(`«${id}»`));
}

// ---------------------------------------------------------------------------
// Draft autosave (per browser; the real save is "У гру" or a JSON file)
// ---------------------------------------------------------------------------

const DRAFT_KEY = "rutzarg.itemEditor.draft";
let saveTimer = 0;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ data: state.data, game: state.game, selected: state.selected })); } catch { /* storage off */ }
  }, 300);
}

export function restoreDraft(): boolean {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw) as { data: GameData; game: GameData; selected: string | null };
    if (!d.data?.items?.length) return false;
    state.data = d.data; state.game = d.game ?? clone(BUILTIN); state.selected = d.selected;
    fixSelection();
    return true;
  } catch { return false; }
}

export function cloneData<T>(x: T): T { return clone(x); }
