// Sign-in page of the item editor (admins only). The session lives in an HttpOnly cookie set by the server.

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

async function init() {
  const hashErr = new URLSearchParams(location.hash.slice(1)).get("error");
  if (hashErr) { $("err").textContent = hashErr; history.replaceState(null, "", location.pathname); }
  // already signed in (or local development without admins) → straight to the editor
  const me = await fetch("/api/editor/me").catch(() => null);
  if (me?.ok) { location.replace("/editor/"); return; }
  const info = (await me?.json().catch(() => ({}))) as { google?: boolean; login?: boolean; error?: string } | undefined;
  if (info?.google) $("google").hidden = false;
  if (info && !info.login) {
    $("err").textContent = info.error ?? "Редактор вимкнено";
    $<HTMLButtonElement>("go").disabled = true;
  }
  $<HTMLFormElement>("login").onsubmit = async (e) => {
    e.preventDefault();
    $("err").textContent = "";
    $<HTMLButtonElement>("go").disabled = true;
    try {
      const r = await fetch("/api/editor/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: $<HTMLInputElement>("email").value, password: $<HTMLInputElement>("password").value }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error ?? `Помилка ${r.status}`);
      location.replace("/editor/");
    } catch (err) {
      $("err").textContent = (err as Error).message;
      $<HTMLButtonElement>("go").disabled = false;
    }
  };
}

void init();
