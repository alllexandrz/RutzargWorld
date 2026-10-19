// Auth flow test: email/password registration & login, sessions, account-bound character,
// guest → account migration, and the Google OAuth callback (against a mock Google token endpoint).
//
// Usage:
//   1) node scripts/auth-test.ts --mock-google            (starts a mock token endpoint on :9911)
//   2) start the server with GOOGLE_CLIENT_ID=test-client GOOGLE_CLIENT_SECRET=x GOOGLE_TOKEN_URL=http://127.0.0.1:9911/token
//   3) node scripts/auth-test.ts http://localhost:8787
// (step 1 and 3 can be the same process: pass both)

import { createServer } from "node:http";
import WebSocket from "ws";

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith("http")) ?? "http://localhost:8787";
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) failures++; };

if (args.includes("--mock-google")) {
  // Mock of https://oauth2.googleapis.com/token returning an unsigned ID token with test claims.
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      if (p.get("code") !== "good-code") { res.writeHead(400).end("{}"); return; }
      const idToken = `${b64({ alg: "none" })}.${b64({
        iss: "https://accounts.google.com", aud: "test-client", sub: "google-user-42", email: "hero@example.com",
        email_verified: true, name: "Герой Google", exp: Math.floor(Date.now() / 1000) + 3600,
      })}.sig`;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: idToken }));
    });
  }).listen(9911);
  console.log("mock google token endpoint on :9911");
}

async function api(path: string, body?: unknown, session?: string) {
  const r = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, any>, headers: r.headers };
}

function joinWs(msg: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace("http", "ws") + "/ws");
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", ...msg })));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === "welcome" || m.t === "authError") { ws.close(); resolve(m); }
    });
  });
}

if (args.some((a) => a.startsWith("http"))) {
  const email = `test${Date.now()}@example.com`;
  const cfg = await api("/api/auth/config");
  check("config", cfg.status === 200, JSON.stringify(cfg.data));

  // guest first, then register → the guest character moves into the account
  const guest = await joinWs({ name: "Гість", look: {} });
  check("гість заходить", guest.t === "welcome" && !!guest.token);

  const weak = await api("/api/auth/register", { email, password: "123" });
  check("слабкий пароль відхилено", weak.status === 400, weak.data.error);
  const reg = await api("/api/auth/register", { email, password: "correct-horse-battery", displayName: "Тестер", guestToken: guest.token });
  check("реєстрація", reg.status === 200 && !!reg.data.session);
  check("персонаж гостя перейшов в акаунт", reg.data.account?.character?.name === "Гість", JSON.stringify(reg.data.account?.character));
  const dup = await api("/api/auth/register", { email, password: "correct-horse-battery" });
  check("повторний email відхилено", dup.status === 409);

  const bad = await api("/api/auth/login", { email, password: "wrong-password" });
  check("невірний пароль", bad.status === 401);
  const login = await api("/api/auth/login", { email: email.toUpperCase(), password: "correct-horse-battery" });
  check("вхід (email без урахування регістру)", login.status === 200);
  const session = login.data.session as string;

  const me = await api("/api/auth/me", undefined, session);
  check("/me", me.status === 200 && me.data.email === email);

  const w1 = await joinWs({ session, name: "ігнорується" });
  check("вхід у світ за сесією = той самий персонаж", w1.t === "welcome" && w1.you === guest.you, `${w1.you} vs ${guest.you}`);
  check("токен гостя більше не відкриває персонажа акаунта", (await joinWs({ token: guest.token, name: "X" })).you !== guest.you);

  await api("/api/auth/logout", {}, session);
  const after = await api("/api/auth/me", undefined, session);
  check("вихід інвалідовує сесію", after.status === 401);
  const w2 = await joinWs({ session });
  check("стара сесія не пускає у світ", w2.t === "authError");

  // Google OAuth (needs the server started with the mock token endpoint)
  if (cfg.data.google) {
    const start = await fetch(BASE + "/auth/google", { redirect: "manual" });
    const loc = start.headers.get("location") ?? "";
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    const state = new URL(loc).searchParams.get("state");
    check("редірект на Google", start.status === 302 && loc.includes("client_id=test-client") && loc.includes("redirect_uri="), loc.slice(0, 80));
    const badState = await fetch(`${BASE}/auth/google/callback?code=good-code&state=forged`, { redirect: "manual", headers: { cookie } });
    check("підроблений state відхилено", (badState.headers.get("location") ?? "").includes("auth_error"));
    const cb = await fetch(`${BASE}/auth/google/callback?code=good-code&state=${state}`, { redirect: "manual", headers: { cookie } });
    const gSession = new URLSearchParams((cb.headers.get("location") ?? "").split("#")[1]).get("session");
    check("callback → сесія", !!gSession, cb.headers.get("location")?.slice(0, 30));
    const gMe = await api("/api/auth/me", undefined, gSession!);
    check("Google-акаунт створено", gMe.data.google === true && gMe.data.email === "hero@example.com", JSON.stringify(gMe.data));
    const gw = await joinWs({ session: gSession, name: "Гуглер", look: {} });
    check("Google-гравець входить у світ", gw.t === "welcome");
    const cb2Start = await fetch(BASE + "/auth/google", { redirect: "manual" });
    const st2 = new URL(cb2Start.headers.get("location")!).searchParams.get("state");
    const cb2 = await fetch(`${BASE}/auth/google/callback?code=good-code&state=${st2}`, { redirect: "manual", headers: { cookie: (cb2Start.headers.get("set-cookie") ?? "").split(";")[0] } });
    const s2 = new URLSearchParams((cb2.headers.get("location") ?? "").split("#")[1]).get("session");
    const gw2 = await joinWs({ session: s2 });
    check("повторний вхід Google → той самий персонаж", gw2.you === gw.you);
  } else console.log("(Google не налаштовано на сервері — OAuth-перевірки пропущено)");

  console.log(failures ? `\n${failures} перевірок не пройшло` : "\nУсі перевірки пройдено");
  process.exit(failures ? 1 : 0);
}
