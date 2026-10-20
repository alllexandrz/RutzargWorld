// Multiplayer smoke test: two bot clients join a running server, see each other,
// chat, trade at the market and gather resources.
// Usage: (server running) node scripts/smoke-test.ts [ws://localhost:8787/ws]

import WebSocket from "ws";
import type { C2S, S2C, SelfState, EntSnap } from "../shared/protocol.ts";
import { getMap, idx, isWalkable, O } from "../shared/map.ts";

const URL = process.argv[2] ?? "ws://localhost:8787/ws";

class Bot {
  ws: WebSocket;
  id = "";
  self: SelfState | null = null;
  ents = new Map<string, EntSnap>();
  me = { x: 0, y: 0 };
  ack = 0;
  log: S2C[] = [];
  seq = 0;
  name: string;
  token = "";
  constructor(name: string, token = "") { this.name = name; this.token = token; this.ws = new WebSocket(URL); }
  async open() {
    if (this.ws.readyState !== WebSocket.OPEN)
      await new Promise<void>((res, rej) => { this.ws.on("open", () => res()); this.ws.on("error", rej); });
    this.ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as S2C;
      this.log.push(m);
      if (m.t === "welcome") { this.id = m.you; this.token = m.token || this.token; }
      if (m.t === "self") this.self = m.s;
      if (m.t === "snap") { this.ents = new Map(m.ents.map((e) => [e.id, e])); if (m.me) this.me = m.me; this.ack = m.ack; }
    });
    this.send({ t: "join", name: this.name, ...(this.token ? { token: this.token } : {}) });
    await wait(600);
  }
  send(m: C2S) { this.ws.send(JSON.stringify(m)); }
  async walk(dx: number, dy: number, steps: number) {
    for (let i = 0; i < steps; i++) { this.send({ t: "input", seq: ++this.seq, dx, dy }); await wait(50); }
  }
  async walkTo(x: number, y: number, maxSteps = 400) {
    for (let i = 0; i < maxSteps; i++) {
      const dx = x - this.me.x, dy = y - this.me.y;
      if (Math.hypot(dx, dy) < 0.4) return true;
      this.send({ t: "input", seq: ++this.seq, dx, dy });
      await wait(50);
    }
    return false;
  }
  got<T extends S2C["t"]>(t: T) { return this.log.filter((m) => m.t === t) as Extract<S2C, { t: T }>[]; }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

const a = new Bot("Тест-А"), b = new Bot("Тест-Б");
await a.open(); await b.open();
await wait(500);
check("обидва отримали welcome", !!a.id && !!b.id);
check("А бачить Б у снапшоті", a.ents.has(b.id));
check("NPC у світі", [...a.ents.values()].filter((e) => e.k === "npc").length >= 10, `${a.ents.size} сутностей`);
check("стан гравця отримано", !!a.self && a.self.coins > 0, `монет: ${a.self?.coins}`);

// movement
const start = { ...a.me };
// walk towards the middle of the gate road (always free; a random spawn may face the town wall)
await a.walkTo(45.5, 24.5, 40); // line up with the gate opening first
await a.walkTo(38.5, 24.5, 60);
await wait(300);
check("рух підтверджено сервером", Math.hypot(a.me.x - start.x, a.me.y - start.y) > 2 && a.me.x < 44, `${start.x.toFixed(1)}→${a.me.x.toFixed(1)}`);
check("ack послідовності", a.ack === a.seq, `${a.ack}/${a.seq}`);

// speed hack protection: flood 100 inputs instantly
const before = { ...a.me };
for (let i = 0; i < 100; i++) a.send({ t: "input", seq: ++a.seq, dx: -1, dy: 0 });
await wait(400);
const moved = Math.hypot(a.me.x - before.x, a.me.y - before.y);
check("захист від спідхаку", moved < 4.2 * 1.2, `пройдено ${moved.toFixed(2)} за ~0.4с`);

// chat
b.send({ t: "chat", text: "Привіт з тесту!" });
await wait(300);
check("чат доставлено іншому гравцю", a.got("chat").some((m) => m.text === "Привіт з тесту!"));

// market: walk to plaza and buy
await a.walkTo(22.5, 24.5);
a.send({ t: "openMarket" });
a.send({ t: "market", op: "buy", item: "meal", qty: 1 });
await wait(400);
check("купівля на ринку", (a.self?.inv.meal ?? 0) === 1, `монет: ${a.self?.coins}`);
a.send({ t: "act", a: "eat" });
await wait(2000);
check("поїв", (a.self?.inv.meal ?? 0) === 0);

// gather wood in the forest
// a real tree next to the east road (the map is shared code, so the bot knows it)
const map = getMap();
let tree = { x: 70, y: 21 };
for (let x = 66; x < 92; x++) if (map.obj[idx(x, 21)] === O.TREE && isWalkable(map, x, 22)) { tree = { x, y: 21 }; break; }
await b.walkTo(42.5, 24.5, 300); // through the east gate
await b.walkTo(tree.x + 0.5, 24.5, 900); // along the road
const ok = await b.walkTo(tree.x + 0.5, 22.5, 100);
b.send({ t: "act", a: "gather" });
await wait(4000);
check("збирання деревини", (b.self?.inv.wood ?? 0) >= 1, `дійшов: ${ok}, деревина: ${b.self?.inv.wood ?? 0}`);

// talk to an NPC
// NPCs move: re-approach the (current) nearest one a few times
let npc = [...a.ents.values()][0];
for (let attempt = 0; attempt < 4 && !a.got("dialog").length; attempt++) {
  npc = [...a.ents.values()].filter((e) => e.k === "npc").sort((p, q) => Math.hypot(p.x - a.me.x, p.y - a.me.y) - Math.hypot(q.x - a.me.x, q.y - a.me.y))[0];
  for (let i = 0; i < 300; i++) {
    const cur = a.ents.get(npc.id)!;
    if (Math.hypot(cur.x - a.me.x, cur.y - a.me.y) < 1.5) break;
    a.send({ t: "input", seq: ++a.seq, dx: cur.x - a.me.x, dy: cur.y - a.me.y });
    await wait(50);
  }
  a.send({ t: "talk", npcId: npc.id, opt: "open" });
  await wait(500);
}
check(`діалог з ${npc.n}`, a.got("dialog").length > 0, a.got("dialog").at(-1)?.lines.at(-1)?.text);

// businesses
a.send({ t: "biz", op: "list" });
await wait(300);
check("список справ", (a.got("biz").at(-1)?.list.length ?? 0) >= 8);

// reconnect: the same character must be able to walk right away (input seq starts from 0 again)
const oldSeq = a.seq, oldId = a.id;
a.ws.close();
await wait(500);
const a2 = new Bot("Тест-А", a.token);
await a2.open();
await wait(400);
const start2 = { ...a2.me };
let moved2 = 0;
for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
  await a2.walk(dx, dy, 15);
  await wait(300);
  moved2 = Math.hypot(a2.me.x - start2.x, a2.me.y - start2.y);
  if (moved2 > 0.5) break;
}
check("після перезаходу персонаж ходить", a2.id === oldId && moved2 > 0.5, `той самий: ${a2.id === oldId}, старий seq ${oldSeq}, зрушив на ${moved2.toFixed(2)}`);

a2.ws.close(); b.ws.close();
console.log(failures ? `\n${failures} перевірок не пройшло` : "\nУсі перевірки пройдено");
process.exit(failures ? 1 : 0);
