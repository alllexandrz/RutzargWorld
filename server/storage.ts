// Persistence backends (concept §30.1: persistent database / event log / snapshots).
//   - FileStorage: a JSON file (default for local development, zero setup)
//   - PgStorage:   PostgreSQL — world snapshots, append-only world event log, daily statistics, players
// Selected by DATABASE_URL. The simulation never waits on the database: writes are batched/async.

import pg from "pg";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SaveFile } from "./persist.ts";
import { writeSnapshotFile } from "./persist.ts";
import type { ChronicleRecord } from "./sim/types.ts";

export interface DailyStats {
  day: number;
  gameTime: number;
  population: number;
  children: number;
  playersTotal: number;
  playersOnline: number;
  townTreasury: number;
  market: Record<string, { stock: number; price: number }>;
  businesses: { id: string; name: string; owner: string; workers: number; wage: number; treasury: number }[];
  houses: number;
  deposits: Record<string, number>;
  surface: Record<string, number>;
}

export interface PlayerRecord { id: string; name: string; online: boolean }

export interface Account {
  id: string;
  email: string | null;
  displayName: string;
  /** scrypt hash "salt:hash" (hex); null for Google-only accounts. */
  passwordHash: string | null;
  googleSub: string | null;
  /** The character this account plays (one per account in the prototype). */
  playerId: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface Session {
  tokenHash: string;
  accountId: string;
  expiresAt: number;
}

export interface Storage {
  readonly kind: string;
  init(): Promise<void>;
  loadSnapshot(): Promise<SaveFile | null>;
  saveSnapshot(data: SaveFile): Promise<void>;
  logEvents(events: ChronicleRecord[]): Promise<void>;
  saveDailyStats(stats: DailyStats): Promise<void>;
  recentStats(limit: number): Promise<DailyStats[]>;
  upsertPlayers(players: PlayerRecord[]): Promise<void>;
  // accounts & sessions
  getAccount(id: string): Promise<Account | null>;
  findAccountByEmail(email: string): Promise<Account | null>;
  findAccountByGoogle(sub: string): Promise<Account | null>;
  findAccountByPlayer(playerId: string): Promise<Account | null>;
  saveAccount(a: Account): Promise<void>;
  createSession(s: Session): Promise<void>;
  getSession(tokenHash: string): Promise<Session | null>;
  deleteSession(tokenHash: string): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------

export class FileStorage implements Storage {
  readonly kind: string;
  private stats: DailyStats[] = [];
  private file: string;
  private accFile: string;
  private accounts = new Map<string, Account>();
  private sessions = new Map<string, Session>();
  constructor(file: string) {
    this.file = file;
    this.accFile = join(dirname(file), "accounts.json");
    this.kind = `файл ${file}`;
  }
  async init() {
    if (!existsSync(this.accFile)) return;
    const d = JSON.parse(readFileSync(this.accFile, "utf8")) as { accounts: Account[]; sessions: Session[] };
    for (const a of d.accounts) this.accounts.set(a.id, a);
    for (const x of d.sessions) if (x.expiresAt > Date.now()) this.sessions.set(x.tokenHash, x);
  }
  private flushAccounts() {
    mkdirSync(dirname(this.accFile), { recursive: true });
    const tmp = `${this.accFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ accounts: [...this.accounts.values()], sessions: [...this.sessions.values()] }));
    renameSync(tmp, this.accFile);
  }
  async getAccount(id: string) { return this.accounts.get(id) ?? null; }
  async findAccountByEmail(email: string) { return [...this.accounts.values()].find((a) => a.email === email) ?? null; }
  async findAccountByGoogle(sub: string) { return [...this.accounts.values()].find((a) => a.googleSub === sub) ?? null; }
  async findAccountByPlayer(pid: string) { return [...this.accounts.values()].find((a) => a.playerId === pid) ?? null; }
  async saveAccount(a: Account) { this.accounts.set(a.id, { ...a }); this.flushAccounts(); }
  async createSession(x: Session) { this.sessions.set(x.tokenHash, x); this.flushAccounts(); }
  async getSession(h: string) { const x = this.sessions.get(h); return x && x.expiresAt > Date.now() ? x : null; }
  async deleteSession(h: string) { this.sessions.delete(h); this.flushAccounts(); }
  async loadSnapshot() {
    if (!existsSync(this.file)) return null;
    return JSON.parse(readFileSync(this.file, "utf8")) as SaveFile;
  }
  async saveSnapshot(data: SaveFile) { writeSnapshotFile(data, this.file); }
  async logEvents() { /* the chronicle inside the snapshot is enough for file mode */ }
  async saveDailyStats(s: DailyStats) { this.stats.push(s); if (this.stats.length > 60) this.stats.shift(); }
  async recentStats(limit: number) { return this.stats.slice(-limit); }
  async upsertPlayers() {}
  async close() {}
}

// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS world_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  game_time   DOUBLE PRECISION NOT NULL,
  version     INT NOT NULL,
  data        JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS world_events (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  game_time   DOUBLE PRECISION NOT NULL,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS world_events_kind_idx ON world_events (kind, game_time);
CREATE TABLE IF NOT EXISTS daily_stats (
  day         INT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  game_time   DOUBLE PRECISION NOT NULL,
  population  INT NOT NULL,
  data        JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT,
  google_sub    TEXT UNIQUE,
  player_id     TEXT UNIQUE,
  created_at    BIGINT NOT NULL,
  last_login_at BIGINT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  online      BOOLEAN NOT NULL DEFAULT false
);
`;

const KEEP_SNAPSHOTS = 30;

export class PgStorage implements Storage {
  readonly kind: string;
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 4 });
    this.kind = `PostgreSQL ${url.replace(/\/\/[^@]*@/, "//***@")}`;
  }

  async init() {
    // The database container may still be starting: retry for ~30 s.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query(SCHEMA);
        return;
      } catch (e) {
        if (attempt >= 15) throw e;
        console.warn(`[db] not ready (${(e as Error).message}), retry ${attempt}/15...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async loadSnapshot() {
    const r = await this.pool.query("SELECT data FROM world_snapshots ORDER BY id DESC LIMIT 1");
    return (r.rows[0]?.data as SaveFile | undefined) ?? null;
  }

  async saveSnapshot(data: SaveFile) {
    await this.pool.query("INSERT INTO world_snapshots (game_time, version, data) VALUES ($1, $2, $3)", [data.time, data.version, JSON.stringify(data)]);
    // keep a rolling window of snapshots (crash recovery / admin rollback, not a gameplay feature)
    await this.pool.query("DELETE FROM world_snapshots WHERE id NOT IN (SELECT id FROM world_snapshots ORDER BY id DESC LIMIT $1)", [KEEP_SNAPSHOTS]);
  }

  async logEvents(events: ChronicleRecord[]) {
    if (!events.length) return;
    const values: unknown[] = [];
    const rows = events.map((e, i) => { values.push(e.t, e.kind, e.text); return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`; });
    await this.pool.query(`INSERT INTO world_events (game_time, kind, text) VALUES ${rows.join(",")}`, values);
  }

  async saveDailyStats(s: DailyStats) {
    await this.pool.query(
      `INSERT INTO daily_stats (day, game_time, population, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (day) DO UPDATE SET game_time = EXCLUDED.game_time, population = EXCLUDED.population, data = EXCLUDED.data`,
      [s.day, s.gameTime, s.population, JSON.stringify(s)],
    );
  }

  async recentStats(limit: number) {
    const r = await this.pool.query("SELECT data FROM daily_stats ORDER BY day DESC LIMIT $1", [limit]);
    return r.rows.map((x) => x.data as DailyStats).reverse();
  }

  async upsertPlayers(players: PlayerRecord[]) {
    for (const p of players)
      await this.pool.query(
        `INSERT INTO players (id, name, online) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, online = EXCLUDED.online, last_seen = now()`,
        [p.id, p.name, p.online],
      );
  }

  private static acc(r: Record<string, unknown> | undefined): Account | null {
    if (!r) return null;
    return {
      id: r.id as string, email: (r.email as string) ?? null, displayName: r.display_name as string,
      passwordHash: (r.password_hash as string) ?? null, googleSub: (r.google_sub as string) ?? null,
      playerId: (r.player_id as string) ?? null, createdAt: Number(r.created_at), lastLoginAt: r.last_login_at ? Number(r.last_login_at) : null,
    };
  }
  async getAccount(id: string) { return PgStorage.acc((await this.pool.query("SELECT * FROM accounts WHERE id = $1", [id])).rows[0]); }
  async findAccountByEmail(email: string) { return PgStorage.acc((await this.pool.query("SELECT * FROM accounts WHERE email = $1", [email])).rows[0]); }
  async findAccountByGoogle(sub: string) { return PgStorage.acc((await this.pool.query("SELECT * FROM accounts WHERE google_sub = $1", [sub])).rows[0]); }
  async findAccountByPlayer(pid: string) { return PgStorage.acc((await this.pool.query("SELECT * FROM accounts WHERE player_id = $1", [pid])).rows[0]); }
  async saveAccount(a: Account) {
    await this.pool.query(
      `INSERT INTO accounts (id, email, display_name, password_hash, google_sub, player_id, created_at, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash,
         google_sub = EXCLUDED.google_sub, player_id = EXCLUDED.player_id, last_login_at = EXCLUDED.last_login_at`,
      [a.id, a.email, a.displayName, a.passwordHash, a.googleSub, a.playerId, a.createdAt, a.lastLoginAt],
    );
  }
  async createSession(x: Session) {
    await this.pool.query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)", [x.tokenHash, x.accountId, x.expiresAt]);
    await this.pool.query("DELETE FROM sessions WHERE expires_at < $1", [Date.now()]);
  }
  async getSession(h: string) {
    const r = (await this.pool.query("SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > $2", [h, Date.now()])).rows[0];
    return r ? { tokenHash: r.token_hash as string, accountId: r.account_id as string, expiresAt: Number(r.expires_at) } : null;
  }
  async deleteSession(h: string) { await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [h]); }

  async close() { await this.pool.end(); }
}

export function createStorage(file: string): Storage {
  const url = process.env.DATABASE_URL;
  return url ? new PgStorage(url) : new FileStorage(file);
}
