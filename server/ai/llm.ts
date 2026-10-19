// Optional LLM reasoning service (concept §25, §33).
// One shared model serves all agents through a priority queue.
// The game never depends on it: every caller has a deterministic fallback.
//
// Configure with env vars:
//   RUTZARG_LLM=ollama        (or "openai" for any OpenAI-compatible server: LM Studio, llama.cpp, vLLM)
//   LLM_URL=http://localhost:11434
//   LLM_MODEL=gemma3:4b
//   LLM_TIMEOUT_MS=15000

type Provider = "ollama" | "openai" | "off";

const provider: Provider = ((process.env.RUTZARG_LLM ?? "off").toLowerCase() as Provider);
const baseUrl = process.env.LLM_URL ?? (provider === "openai" ? "http://localhost:1234" : "http://localhost:11434");
const model = process.env.LLM_MODEL ?? "gemma3:4b";
const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 15000);

export function llmEnabled(): boolean {
  return provider === "ollama" || provider === "openai";
}

export function llmDescription(): string {
  return llmEnabled() ? `${provider} @ ${baseUrl} (${model})` : "вимкнено (utility AI fallback)";
}

export type Priority = 0 | 1 | 2; // 0 = high (talking with a player), 1 = medium, 2 = low

interface Job {
  prio: Priority;
  seq: number;
  system: string;
  user: string;
  json: boolean;
  resolve: (v: string | null) => void;
}

const queue: Job[] = [];
let running = 0;
let seq = 0;
const MAX_CONCURRENT = 1;
const MAX_QUEUE = 30;

export const llmStats = { calls: 0, failures: 0, dropped: 0, totalMs: 0 };

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    const job = queue.shift()!;
    running++;
    const t0 = Date.now();
    call(job)
      .then((r) => { llmStats.calls++; llmStats.totalMs += Date.now() - t0; job.resolve(r); })
      .catch((e) => { llmStats.failures++; console.warn("[llm] failed:", (e as Error).message); job.resolve(null); })
      .finally(() => { running--; pump(); });
  }
}

async function call(job: Job): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const messages = [{ role: "system", content: job.system }, { role: "user", content: job.user }];
    if (provider === "ollama") {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages, stream: false, format: job.json ? "json" : undefined, options: { temperature: 0.7 } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { message?: { content?: string } };
      return data.message?.content ?? null;
    }
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0.7, ...(job.json ? { response_format: { type: "json_object" } } : {}) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? null;
  } finally {
    clearTimeout(timer);
  }
}

function enqueue(system: string, user: string, json: boolean, prio: Priority): Promise<string | null> {
  if (!llmEnabled()) return Promise.resolve(null);
  if (queue.length >= MAX_QUEUE) {
    // drop the lowest-priority, oldest job
    queue.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
    const dropped = queue.shift()!;
    llmStats.dropped++;
    dropped.resolve(null);
  }
  return new Promise((resolve) => {
    queue.push({ prio, seq: seq++, system, user, json, resolve });
    pump();
  });
}

/** Ask for a structured JSON decision. Returns null on any failure (caller falls back). */
export async function llmJson<T = Record<string, unknown>>(system: string, user: string, prio: Priority = 1): Promise<T | null> {
  const txt = await enqueue(system, user, true, prio);
  if (!txt) return null;
  try {
    const start = txt.indexOf("{"), end = txt.lastIndexOf("}");
    return JSON.parse(txt.slice(start, end + 1)) as T;
  } catch {
    llmStats.failures++;
    return null;
  }
}

/** Ask for a short natural-language line (dialogue). */
export async function llmText(system: string, user: string, prio: Priority = 0): Promise<string | null> {
  const txt = await enqueue(system, user, false, prio);
  if (!txt) return null;
  return txt.trim().replace(/^["«]|["»]$/g, "").slice(0, 400);
}
