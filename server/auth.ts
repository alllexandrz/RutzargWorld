// Accounts & authentication: email+password and "Sign in with Google" (OAuth 2.0 authorization-code flow).
// No external auth libraries: scrypt for passwords, random session tokens (only their SHA-256 is stored).
//
// Env:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — enable Google sign-in
//   PUBLIC_URL     — public base URL (for the OAuth redirect), e.g. https://rutzarg.example.com
//   ALLOW_GUESTS   — "0" disables guest play (default: allowed)

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Account, Storage } from "./storage.ts";

const SESSION_DAYS = 30;
const GOOGLE_AUTH_URL = process.env.GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";

export const authConfig = {
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/$/, ""),
  allowGuests: process.env.ALLOW_GUESTS !== "0",
  get google() { return !!(this.googleClientId && this.googleClientSecret); },
};

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${(await scryptAsync(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createSession(storage: Storage, accountId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await storage.createSession({ tokenHash: sha256(token), accountId, expiresAt: Date.now() + SESSION_DAYS * 86400_000 });
  return token;
}

/** Resolve a session token to its account (null if missing/expired). */
export async function accountFromSession(storage: Storage, token: string | undefined | null): Promise<Account | null> {
  if (!token || token.length > 128) return null;
  const s = await storage.getSession(sha256(token));
  return s ? storage.getAccount(s.accountId) : null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Very small fixed-window rate limiter per IP for auth endpoints. */
const attempts = new Map<string, { n: number; at: number }>();
function limited(req: IncomingMessage, max = 10): boolean {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() || req.socket.remoteAddress || "?";
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.at > 60_000) { attempts.set(ip, { n: 1, at: now }); return false; }
  a.n++;
  return a.n > max;
}

function baseUrl(req: IncomingMessage): string {
  if (authConfig.publicUrl) return authConfig.publicUrl;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  return `${proto}://${req.headers.host}`;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function publicAccount(a: Account, playerName: string | null) {
  return { id: a.id, email: a.email, displayName: a.displayName, google: !!a.googleSub, character: playerName ? { name: playerName } : null };
}

// ---------------------------------------------------------------------------
// Routes: /api/auth/* and /auth/google*
// ---------------------------------------------------------------------------

export interface AuthDeps {
  storage: Storage;
  /** Name of the character linked to an account (if it exists in the world). */
  characterName(playerId: string | null): string | null;
  /** A guest character (by its legacy token) that may be attached to a new account. */
  guestPlayerByToken(token: string): { id: string; name: string } | null;
  /** Bind a character to an account immediately (so the old guest token stops working). */
  linkPlayer(playerId: string, accountId: string): void;
}

/** Handle an auth route. Returns true if the request was handled. */
export async function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL, deps: AuthDeps): Promise<boolean> {
  const { storage } = deps;
  const p = url.pathname;

  if (p === "/api/auth/config" && req.method === "GET") {
    json(res, 200, { google: authConfig.google, guests: authConfig.allowGuests });
    return true;
  }

  if (p === "/api/auth/me" && req.method === "GET") {
    const a = await accountFromSession(storage, bearer(req));
    if (!a) { json(res, 401, { error: "Сесія недійсна. Увійди знову." }); return true; }
    json(res, 200, publicAccount(a, deps.characterName(a.playerId)));
    return true;
  }

  if (p === "/api/auth/register" && req.method === "POST") {
    if (limited(req)) { json(res, 429, { error: "Забагато спроб. Зачекай хвилину." }); return true; }
    let body: Record<string, unknown>;
    try { body = await readJson(req); } catch { json(res, 400, { error: "Некоректний запит" }); return true; }
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const displayName = String(body.displayName ?? "").trim().slice(0, 40) || email.split("@")[0];
    if (!EMAIL_RE.test(email)) { json(res, 400, { error: "Некоректний email" }); return true; }
    if (password.length < 8 || password.length > 200) { json(res, 400, { error: "Пароль має містити щонайменше 8 символів" }); return true; }
    if (await storage.findAccountByEmail(email)) { json(res, 409, { error: "Акаунт із таким email уже існує" }); return true; }
    const acc: Account = {
      id: randomUUID(), email, displayName, passwordHash: await hashPassword(password), googleSub: null,
      playerId: null, createdAt: Date.now(), lastLoginAt: Date.now(),
    };
    // a guest who registers keeps their character
    const guest = typeof body.guestToken === "string" ? deps.guestPlayerByToken(body.guestToken) : null;
    if (guest && !(await storage.findAccountByPlayer(guest.id))) acc.playerId = guest.id;
    await storage.saveAccount(acc);
    if (acc.playerId) deps.linkPlayer(acc.playerId, acc.id);
    const session = await createSession(storage, acc.id);
    json(res, 200, { session, account: publicAccount(acc, deps.characterName(acc.playerId)) });
    return true;
  }

  if (p === "/api/auth/login" && req.method === "POST") {
    if (limited(req)) { json(res, 429, { error: "Забагато спроб. Зачекай хвилину." }); return true; }
    let body: Record<string, unknown>;
    try { body = await readJson(req); } catch { json(res, 400, { error: "Некоректний запит" }); return true; }
    const email = String(body.email ?? "").trim().toLowerCase();
    const acc = await storage.findAccountByEmail(email);
    const ok = acc?.passwordHash ? await verifyPassword(String(body.password ?? ""), acc.passwordHash) : false;
    if (!acc || !ok) { json(res, 401, { error: acc && !acc.passwordHash ? "Цей акаунт входить через Google" : "Невірний email або пароль" }); return true; }
    acc.lastLoginAt = Date.now();
    await storage.saveAccount(acc);
    const session = await createSession(storage, acc.id);
    json(res, 200, { session, account: publicAccount(acc, deps.characterName(acc.playerId)) });
    return true;
  }

  if (p === "/api/auth/logout" && req.method === "POST") {
    const t = bearer(req);
    if (t) await storage.deleteSession(sha256(t));
    json(res, 200, { ok: true });
    return true;
  }

  // ---- Google OAuth 2.0 ----
  if (p === "/auth/google" && req.method === "GET") {
    if (!authConfig.google) { json(res, 404, { error: "Вхід через Google не налаштовано" }); return true; }
    const state = randomBytes(16).toString("hex");
    const params = new URLSearchParams({
      client_id: authConfig.googleClientId,
      redirect_uri: `${baseUrl(req)}/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    const secure = baseUrl(req).startsWith("https") ? "; Secure" : "";
    res.writeHead(302, {
      location: `${GOOGLE_AUTH_URL}?${params}`,
      "set-cookie": `rz_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600${secure}`,
    });
    res.end();
    return true;
  }

  if (p === "/auth/google/callback" && req.method === "GET") {
    const fail = (msg: string) => { res.writeHead(302, { location: `/#auth_error=${encodeURIComponent(msg)}` }); res.end(); };
    if (!authConfig.google) return fail("Вхід через Google не налаштовано"), true;
    const state = url.searchParams.get("state");
    if (!state || state !== cookie(req, "rz_oauth_state")) return fail("Помилка безпеки входу (state). Спробуй ще раз."), true;
    const code = url.searchParams.get("code");
    if (!code) return fail(url.searchParams.get("error") ?? "Вхід скасовано"), true;
    try {
      const tr = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: authConfig.googleClientId, client_secret: authConfig.googleClientSecret,
          redirect_uri: `${baseUrl(req)}/auth/google/callback`, grant_type: "authorization_code",
        }),
      });
      if (!tr.ok) throw new Error(`token endpoint ${tr.status}`);
      const tok = (await tr.json()) as { id_token?: string };
      if (!tok.id_token) throw new Error("no id_token");
      // The ID token came straight from Google's token endpoint over TLS, so its signature
      // need not be re-verified here; we still validate the claims.
      const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString("utf8")) as {
        iss?: string; aud?: string; sub?: string; email?: string; email_verified?: boolean; name?: string; exp?: number;
      };
      if (claims.aud !== authConfig.googleClientId) throw new Error("aud mismatch");
      if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("iss mismatch");
      if (!claims.sub || (claims.exp ?? 0) * 1000 < Date.now()) throw new Error("expired");
      const email = claims.email_verified ? claims.email?.toLowerCase() ?? null : null;
      let acc = await storage.findAccountByGoogle(claims.sub);
      if (!acc && email) {
        // link to an existing email+password account with the same verified email
        acc = await storage.findAccountByEmail(email);
        if (acc) acc.googleSub = claims.sub;
      }
      if (!acc) {
        acc = {
          id: randomUUID(), email, displayName: (claims.name ?? email?.split("@")[0] ?? "Мандрівник").slice(0, 40),
          passwordHash: null, googleSub: claims.sub, playerId: null, createdAt: Date.now(), lastLoginAt: null,
        };
      }
      acc.lastLoginAt = Date.now();
      await storage.saveAccount(acc);
      const session = await createSession(storage, acc.id);
      // the session travels in the URL fragment (never sent to servers/logs); the client stores it
      res.writeHead(302, { location: `/#session=${session}`, "set-cookie": "rz_oauth_state=; Path=/auth; Max-Age=0" });
      res.end();
    } catch (e) {
      console.warn("[auth] google:", (e as Error).message);
      fail("Не вдалося увійти через Google");
    }
    return true;
  }
  return false;
}
