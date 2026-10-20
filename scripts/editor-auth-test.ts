// Item editor access control: starts its own server with ADMIN_EMAILS and checks that the editor and the
// game-data API are closed to everyone but signed-in admins (and scripts with ADMIN_TOKEN).
// Usage: node scripts/editor-auth-test.ts

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) failures++; };

const root = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "rz-editor-auth-"));
const port = 8900 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;
const ADMIN = "admin@test.local", TOKEN = "t0ken-for-scripts-123";
const srv = spawn(process.execPath, [join(root, "server", "main.ts")], {
  env: { ...process.env, PORT: String(port), SAVE_FILE: join(dir, "world.json"), GAMEDATA_FILE: join(dir, "game-data.json"),
    FRESH_WORLD: "1", ADMIN_EMAILS: ADMIN, ADMIN_TOKEN: TOKEN, DATABASE_URL: "", RUTZARG_LLM: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
srv.stdout.on("data", (d) => { out += d; });
srv.stderr.on("data", (d) => { out += d; });
for (let i = 0; i < 60 && !out.includes("running"); i++) await new Promise((r) => setTimeout(r, 100));

const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];
const register = (email: string) => fetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ email, password: "password123", displayName: "x" }) });

try {
  // closed by default
  const page = await fetch(`${base}/editor/`, { redirect: "manual" });
  check("редактор без входу → сторінка входу", page.status === 302 && page.headers.get("location") === "/editor/login.html");
  check("сторінка входу відкрита", (await fetch(`${base}/editor/login.html`)).status === 200);
  check("скрипт редактора без входу закритий", (await fetch(`${base}/editor/editor.js`)).status === 401);
  check("GET /api/gamedata без входу → 401", (await fetch(`${base}/api/gamedata`)).status === 401);
  check("POST /api/gamedata без входу → 401", (await fetch(`${base}/api/gamedata`, { method: "POST", headers: { "x-rutzarg-editor": "1" }, body: "{}" })).status === 401);

  // a player account that is not an admin
  await register("player@test.local");
  const pl = await fetch(`${base}/api/editor/login`, { method: "POST", body: JSON.stringify({ email: "player@test.local", password: "password123" }) });
  check("звичайний гравець не входить у редактор", pl.status === 401 && !cookieOf(pl));
  const wrong = await fetch(`${base}/api/editor/login`, { method: "POST", body: JSON.stringify({ email: ADMIN, password: "nope" }) });
  check("неправильний пароль — відмова", wrong.status === 401);

  // the admin
  await register(ADMIN);
  const ok = await fetch(`${base}/api/editor/login`, { method: "POST", body: JSON.stringify({ email: ADMIN, password: "password123" }) });
  const cookie = cookieOf(ok);
  const sc = ok.headers.get("set-cookie") ?? "";
  check("адмін входить, cookie HttpOnly + SameSite=Strict", ok.ok && cookie.startsWith("rz_editor=") && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc), sc.replace(/=[0-9a-f]{20,}/, "=…"));
  const h = { cookie };
  check("адміну редактор відкривається", (await fetch(`${base}/editor/`, { headers: h, redirect: "manual" })).status === 200);
  const me = (await (await fetch(`${base}/api/editor/me`, { headers: h })).json()) as { who?: string };
  check("редактор знає, хто увійшов", me.who === ADMIN);
  const data = await fetch(`${base}/api/gamedata`, { headers: h });
  const gd = (await data.json()) as { items: { id: string; basePrice: number }[] };
  check("адмін читає дані гри", data.ok && gd.items.length > 30);
  const noHdr = await fetch(`${base}/api/gamedata`, { method: "POST", headers: h, body: JSON.stringify(gd) });
  check("запис без заголовка редактора відхиляється (CSRF)", noHdr.status === 400);
  gd.items.find((x) => x.id === "plank")!.basePrice += 1;
  const post = await fetch(`${base}/api/gamedata`, { method: "POST", headers: { ...h, "x-rutzarg-editor": "1" }, body: JSON.stringify(gd) });
  check("адмін застосовує зміни", post.ok);
  check("у хроніці гри немає email адміна", !(await (await fetch(`${base}/api/stats`)).text()).includes(ADMIN));

  // a script with the token
  const t = await fetch(`${base}/api/gamedata`, { headers: { "x-admin-token": TOKEN } });
  check("скрипт з ADMIN_TOKEN читає дані", t.ok);
  check("неправильний токен — 401", (await fetch(`${base}/api/gamedata`, { headers: { "x-admin-token": "bad" } })).status === 401);

  // sign out
  await fetch(`${base}/api/editor/logout`, { method: "POST", headers: h });
  check("після виходу сесія недійсна", (await fetch(`${base}/api/gamedata`, { headers: h })).status === 401);

  // pretending to come through a proxy doesn't help
  check("заголовки проксі не відкривають доступ", (await fetch(`${base}/api/gamedata`, { headers: { "x-forwarded-for": "127.0.0.1" } })).status === 401);
} finally {
  srv.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} перевірок не пройдено` : "\nУсі перевірки пройдено");
process.exit(failures ? 1 : 0);
