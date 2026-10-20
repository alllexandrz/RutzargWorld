// Tiny DOM helpers (no framework).

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Collapsible sections remember their state between re-renders. */
const closed = new Set<string>();
export function section(key: string, title: string, body: string): string {
  return `<div class="section ${closed.has(key) ? "closed" : ""}" data-sec="${key}"><div class="sec-h">${title}</div><div class="sec-b">${body}</div></div>`;
}
export function bindSections(root: HTMLElement) {
  for (const h of root.querySelectorAll<HTMLElement>(".sec-h")) {
    h.onclick = () => {
      const s = h.parentElement!;
      s.classList.toggle("closed");
      const k = s.dataset.sec!;
      if (s.classList.contains("closed")) closed.add(k); else closed.delete(k);
    };
  }
}

export function options(list: { id: string | number; name: string }[], value: unknown, empty?: string): string {
  return (empty !== undefined ? `<option value="">${esc(empty)}</option>` : "") +
    list.map((o) => `<option value="${esc(o.id)}" ${String(o.id) === String(value ?? "") ? "selected" : ""}>${esc(o.name)}</option>`).join("");
}

export function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
