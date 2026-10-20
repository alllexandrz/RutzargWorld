// Is the AI actually answering? A bot walks up to the nearest NPC, says something free-form
// and shows the reply + the server's LLM counters (/api/ai).
// Usage: (server running) node scripts/ai-check.ts [http://localhost:8787]

import WebSocket from "ws";
import type { C2S, S2C, EntSnap } from "../shared/protocol.ts";

const BASE = process.argv[2] ?? "http://localhost:8787";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = async () => (await fetch(`${BASE}/api/ai`)).json() as Promise<Record<string, unknown>>;

const before = await status();
console.log(`AI: ${before.enabled ? "увімкнено" : "ВИМКНЕНО"} · ${before.detail}`);
if (!before.enabled || !before.reachable) process.exit(1);

const ws = new WebSocket(BASE.replace("http", "ws") + "/ws");
let me = { x: 0, y: 0 }, seq = 0;
let ents = new Map<string, EntSnap>();
const dialogs: Extract<S2C, { t: "dialog" }>[] = [];
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw)) as S2C;
  if (m.t === "snap") { ents = new Map(m.ents.map((e) => [e.id, e])); if (m.me) me = m.me; }
  if (m.t === "dialog") dialogs.push(m);
});
await new Promise((r) => ws.on("open", r));
const send = (m: C2S) => ws.send(JSON.stringify(m));
send({ t: "join", name: "Перевірка AI" });
await wait(1000);

let npc: EntSnap | undefined;
for (let attempt = 0; attempt < 5 && !dialogs.length; attempt++) {
  npc = [...ents.values()].filter((e) => e.k === "npc").sort((p, q) => Math.hypot(p.x - me.x, p.y - me.y) - Math.hypot(q.x - me.x, q.y - me.y))[0];
  if (!npc) break;
  for (let i = 0; i < 300; i++) {
    const cur = ents.get(npc.id) ?? npc;
    if (Math.hypot(cur.x - me.x, cur.y - me.y) < 1.5) break;
    send({ t: "input", seq: ++seq, dx: cur.x - me.x, dy: cur.y - me.y });
    await wait(50);
  }
  send({ t: "talk", npcId: npc.id, opt: "open" });
  await wait(600);
}
if (!npc || !dialogs.length) { console.log("Не вдалося заговорити з NPC — спробуй ще раз."); process.exit(1); }

const question = "Привіт! Розкажи коротко, що тебе зараз найбільше турбує?";
console.log(`\nТи → ${npc.n}: ${question}`);
const n0 = dialogs.length;
const t0 = Date.now();
send({ t: "talk", npcId: npc.id, opt: "say", arg: question });
while (Date.now() - t0 < 60000) {
  const last = dialogs.at(-1)!;
  if (dialogs.length > n0 && !last.pending) break;
  await wait(250);
}
const reply = dialogs.at(-1)!.lines.at(-1)?.text;
const after = await status();
const usedAi = Number(after.calls) > Number(before.calls);
console.log(`${npc.n} → ти (${((Date.now() - t0) / 1000).toFixed(1)} с): ${reply}`);
console.log(`\n${usedAi ? "✔ Відповідь згенерував AI" : "✘ AI не відповів — це шаблонна відповідь"} (викликів LLM: ${before.calls} → ${after.calls}, помилок: ${after.failures}, середній час: ${after.avgMs ?? "—"} мс)`);
ws.close();
process.exit(usedAi ? 0 : 1);
