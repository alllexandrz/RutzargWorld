// Client entry: account sign-in (email/password, Google, or guest) → character → connect → start Phaser.

import Phaser from "phaser";
import { net } from "./net.ts";
import { state } from "./state.ts";
import { WorldScene } from "./WorldScene.ts";
import { OverlayScene } from "./OverlayScene.ts";
import { initUI, toast } from "./ui.ts";
import { initMinimap } from "./minimap.ts";

const TOKEN_KEY = "rutzarg.token";     // guest character token (legacy / guest mode)
const SESSION_KEY = "rutzarg.session"; // account session
const NAME_KEY = "rutzarg.name";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function storage(key: string, value?: string | null): string | null {
  try {
    if (value === null) { localStorage.removeItem(key); return null; }
    if (value !== undefined) { localStorage.setItem(key, value); return value; }
    return localStorage.getItem(key);
  } catch { return null; }
}

function setError(msg: string) { $("login-err").textContent = msg; }
function setHint(msg: string) { $("login-hint").textContent = msg; }

async function api<T>(path: string, opts: { method?: string; body?: unknown; session?: string | null } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(opts.session ? { authorization: `Bearer ${opts.session}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

interface AccountInfo { id: string; email: string | null; displayName: string; google: boolean; character: { name: string } | null }

// ---------------------------------------------------------------------------
// Game start
// ---------------------------------------------------------------------------

function startGame() {
  // Debug handle for the browser console: __rutzarg.game.scene.getScene("world").walkTo(10, 10)
  const debug = { state, game: null as Phaser.Game | null };
  (window as unknown as { __rutzarg: unknown }).__rutzarg = debug;
  debug.game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#0d0f12",
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    scene: [WorldScene, OverlayScene],
    render: { antialias: true, roundPixels: false },
    disableContextMenu: true,
  });
}

function readLook() {
  return {
    body: $<HTMLInputElement>("look-body").value,
    hair: $<HTMLInputElement>("look-hair").value,
    skin: $<HTMLInputElement>("look-skin").value,
    gender: $<HTMLSelectElement>("look-gender").value,
  };
}

/** Connect and enter the world either with an account session or as a guest. */
async function enterWorld(opts: { session?: string; name?: string; look?: Record<string, string> }) {
  for (const id of ["login-go", "char-continue", "guest-btn"]) $<HTMLButtonElement>(id).disabled = true;
  try {
    await net.connect();
  } catch (e) {
    setError((e as Error).message);
    for (const id of ["login-go", "char-continue", "guest-btn"]) $<HTMLButtonElement>(id).disabled = false;
    return;
  }
  net.on((m) => {
    if (m.t === "welcome") {
      state.myId = m.you; state.token = m.token || state.token; state.time = m.time; state.timeAt = performance.now();
      state.minutesPerSecond = m.minutesPerSecond;
      if (m.token) storage(TOKEN_KEY, m.token);
    } else if (m.t === "plots") {
      state.plots = m.plots;
    } else if (m.t === "tiles" && !state.sceneReady) {
      state.tiles.push(...m.changes);
    } else if (m.t === "authError") {
      storage(SESSION_KEY, null);
      alert(m.text);
      location.reload();
    }
  });
  net.onClose = () => toast("З'єднання з сервером втрачено. Онови сторінку.", "bad");
  state.token = opts.session ?? storage(TOKEN_KEY) ?? "";
  net.send({
    t: "join",
    name: opts.name ?? "",
    session: opts.session,
    token: opts.session ? undefined : storage(TOKEN_KEY) ?? undefined,
    look: opts.look as never,
  });
  if (opts.name) storage(NAME_KEY, opts.name);
  $("login").remove();
  initUI();
  initMinimap();
  startGame();
}

// ---------------------------------------------------------------------------
// Sign-in screen
// ---------------------------------------------------------------------------

let mode: "login" | "register" = "login";

function showAuth() {
  $("auth-box").hidden = false;
  $("char-box").hidden = true;
  setHint("");
}

function showCharacter(acc: AccountInfo | null) {
  $("auth-box").hidden = true;
  $("char-box").hidden = false;
  $("logout-btn").hidden = !acc;
  $("acc-line").textContent = acc ? `Акаунт: ${acc.displayName}${acc.email ? ` · ${acc.email}` : ""}${acc.google ? " · Google" : ""}` : "Гість — прогрес прив'язаний до цього браузера.";
  const has = !!acc?.character;
  $("char-continue").hidden = !has;
  $("char-new").hidden = has;
  if (has) $("char-name").textContent = acc!.character!.name;
  $<HTMLInputElement>("login-name").value = storage(NAME_KEY) ?? acc?.displayName ?? "";
  setHint(has ? "Твій персонаж чекає у світі — продовжиш там, де зупинився." : "Створи персонажа. Він житиме у світі, навіть коли тебе немає.");
}

function setMode(m: "login" | "register") {
  mode = m;
  $("tab-login").classList.toggle("sel", m === "login");
  $("tab-register").classList.toggle("sel", m === "register");
  $("auth-name-row").hidden = m === "login";
  $("auth-go").textContent = m === "login" ? "Увійти" : "Створити акаунт";
  $<HTMLInputElement>("auth-pass").autocomplete = m === "login" ? "current-password" : "new-password";
  setError("");
}

async function submitAuth() {
  setError("");
  const email = $<HTMLInputElement>("auth-email").value.trim();
  const password = $<HTMLInputElement>("auth-pass").value;
  try {
    const r = await api<{ session: string; account: AccountInfo }>(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
      method: "POST",
      body: mode === "login" ? { email, password } : { email, password, displayName: $<HTMLInputElement>("auth-name").value, guestToken: storage(TOKEN_KEY) },
    });
    storage(SESSION_KEY, r.session);
    showCharacter(r.account);
  } catch (e) {
    setError((e as Error).message);
  }
}

async function initLogin() {
  // Google redirects back with #session=... or #auth_error=...
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("session")) storage(SESSION_KEY, hash.get("session"));
  if (hash.get("auth_error")) setError(hash.get("auth_error")!);
  if (location.hash) history.replaceState(null, "", location.pathname);

  const cfg = await api<{ google: boolean; guests: boolean }>("/api/auth/config").catch(() => ({ google: false, guests: true }));
  $("google-row").hidden = $("google-btn").hidden = !cfg.google;
  $("guest-btn").hidden = !cfg.guests;

  $("tab-login").onclick = () => setMode("login");
  $("tab-register").onclick = () => setMode("register");
  $("auth-go").onclick = submitAuth;
  for (const id of ["auth-email", "auth-pass", "auth-name"]) $(id).onkeydown = (e) => { if ((e as KeyboardEvent).key === "Enter") submitAuth(); };
  $("guest-btn").onclick = () => {
    if (storage(TOKEN_KEY)) return enterWorld({}); // resume the guest character
    showCharacter(null);
  };
  $("logout-btn").onclick = async () => {
    await api("/api/auth/logout", { method: "POST", session: storage(SESSION_KEY) }).catch(() => {});
    storage(SESSION_KEY, null);
    showAuth();
  };
  $("char-continue").onclick = () => enterWorld({ session: storage(SESSION_KEY) ?? undefined });
  const createChar = () => {
    const name = $<HTMLInputElement>("login-name").value.trim() || "Мандрівник";
    const session = storage(SESSION_KEY) ?? undefined;
    enterWorld({ session, name, look: readLook() });
  };
  $("login-go").onclick = createChar;
  $("login-name").onkeydown = (e) => { if ((e as KeyboardEvent).key === "Enter") createChar(); };

  const session = storage(SESSION_KEY);
  if (session) {
    try {
      showCharacter(await api<AccountInfo>("/api/auth/me", { session }));
      return;
    } catch {
      storage(SESSION_KEY, null);
    }
  }
  setMode("login");
  showAuth();
}

initLogin();

// in-game logout button
document.addEventListener("click", async (e) => {
  if ((e.target as HTMLElement)?.id !== "btn-logout") return;
  if (!confirm("Вийти з акаунта? Персонаж залишиться у світі.")) return;
  await api("/api/auth/logout", { method: "POST", session: storage(SESSION_KEY) }).catch(() => {});
  storage(SESSION_KEY, null);
  location.reload();
});
