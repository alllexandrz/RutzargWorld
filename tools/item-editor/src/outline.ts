// Left pane: items grouped like an asset tree, with search and change / error markers.

import { $, esc } from "./dom.ts";
import { isModified, isNewItem, problemsFor, select, state } from "./model.ts";

const closedGroups = new Set<string>();
let query = "";

export function initOutline() {
  const search = $<HTMLInputElement>("outline-search");
  search.oninput = () => { query = search.value.trim().toLowerCase(); renderOutline(); };
  $("outline-tree").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const g = t.closest(".tg-h") as HTMLElement | null;
    if (g) {
      const k = g.parentElement!.dataset.group!;
      if (closedGroups.has(k)) closedGroups.delete(k); else closedGroups.add(k);
      renderOutline();
      return;
    }
    const it = t.closest(".tree-item") as HTMLElement | null;
    if (it) select(it.dataset.id!);
  });
}

export function renderOutline() {
  const items = state.data.items.filter((x) => !query || `${x.name} ${x.id} ${x.group}`.toLowerCase().includes(query));
  $("outline-count").textContent = `${items.length}`;
  $("outline-tree").innerHTML = state.ref.groups.map((g) => {
    const list = items.filter((x) => x.group === g.id);
    if (!list.length) return "";
    return `<div class="tree-group ${closedGroups.has(g.id) && !query ? "closed" : ""}" data-group="${g.id}">
      <div class="tg-h">${esc(g.name)} <span class="muted">${list.length}</span></div>
      <div class="tg-items">${list.map((x) => {
        const errs = problemsFor(x.id).filter((p) => p.level === "error").length;
        const flag = errs ? `<span class="flag err" title="Помилки">${errs}</span>` : isNewItem(x.id) ? `<span class="flag new">нова</span>` : isModified(x.id) ? `<span class="flag mod" title="Змінено відносно гри">змін.</span>` : "";
        return `<div class="tree-item ${x.id === state.selected ? "sel" : ""}" data-id="${esc(x.id)}" style="--c:${esc(x.color)}">
          <span class="sw"></span><span class="nm">${esc(x.name)}</span><span class="id">${esc(x.id)}</span>${flag}</div>`;
      }).join("")}</div></div>`;
  }).join("") || `<div class="empty">Нічого не знайдено</div>`;
  $("outline-tree").querySelector(".tree-item.sel")?.scrollIntoView({ block: "nearest" });
}
