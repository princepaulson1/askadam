// Data store layer. Uses Postgres when DATABASE_URL is set (Render/production),
// otherwise an in-memory store (local dev / demo only — data is lost on restart).
//
// All methods are async and return plain objects so callers are storage-agnostic.
import pg from "pg";

const { Pool } = pg;

export async function createStore() {
  if (process.env.DATABASE_URL) {
    const store = new PostgresStore(process.env.DATABASE_URL);
    await store.init();
    console.log("Store: PostgreSQL");
    return store;
  }
  console.log("Store: in-memory (no DATABASE_URL — data is not persisted)");
  return new MemoryStore();
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------
class PostgresStore {
  constructor(connectionString) {
    const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
    this.pool = new Pool({
      connectionString,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id           SERIAL PRIMARY KEY,
        provider     TEXT NOT NULL,
        provider_id  TEXT NOT NULL,
        email        TEXT,
        name         TEXT,
        avatar_url   TEXT,
        is_premium   BOOLEAN NOT NULL DEFAULT false,
        advice_read  INTEGER NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (provider, provider_id)
      );
      CREATE TABLE IF NOT EXISTS usage (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day     DATE NOT NULL,
        count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day)
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id, id);
      CREATE TABLE IF NOT EXISTS saved_wisdom (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text       TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, text)
      );
      CREATE TABLE IF NOT EXISTS cycle_settings (
        user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        last_period  DATE,
        cycle_length INTEGER,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS active_days (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day     DATE NOT NULL,
        PRIMARY KEY (user_id, day)
      );
    `);
  }

  async findOrCreateUser({ provider, providerId, email, name, avatarUrl }) {
    const { rows } = await this.pool.query(
      `INSERT INTO users (provider, provider_id, email, name, avatar_url)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider, provider_id) DO UPDATE
         SET email = EXCLUDED.email,
             name = COALESCE(users.name, EXCLUDED.name),
             avatar_url = EXCLUDED.avatar_url
       RETURNING *`,
      [provider, providerId, email || null, name || null, avatarUrl || null]
    );
    return rows[0];
  }

  async getUserById(id) {
    const { rows } = await this.pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] || null;
  }

  async updateUserName(id, name) {
    await this.pool.query(`UPDATE users SET name = $2 WHERE id = $1`, [id, name]);
  }

  async deleteUser(id) {
    await this.pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  }

  async getUsageCount(userId, day) {
    const { rows } = await this.pool.query(
      `SELECT count FROM usage WHERE user_id = $1 AND day = $2`,
      [userId, day]
    );
    return rows[0]?.count || 0;
  }

  async incrementUsage(userId, day) {
    const { rows } = await this.pool.query(
      `INSERT INTO usage (user_id, day, count) VALUES ($1,$2,1)
       ON CONFLICT (user_id, day) DO UPDATE SET count = usage.count + 1
       RETURNING count`,
      [userId, day]
    );
    return rows[0].count;
  }

  async addMessage(userId, role, content) {
    await this.pool.query(
      `INSERT INTO chat_messages (user_id, role, content) VALUES ($1,$2,$3)`,
      [userId, role, content]
    );
  }

  async getRecentMessages(userId, limit = 50) {
    const { rows } = await this.pool.query(
      `SELECT role, content FROM chat_messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
      [userId, limit]
    );
    return rows.reverse();
  }

  async getSavedWisdom(userId) {
    const { rows } = await this.pool.query(
      `SELECT text FROM saved_wisdom WHERE user_id = $1 ORDER BY id DESC`,
      [userId]
    );
    return rows.map((r) => r.text);
  }

  async addSavedWisdom(userId, text) {
    await this.pool.query(
      `INSERT INTO saved_wisdom (user_id, text) VALUES ($1,$2)
       ON CONFLICT (user_id, text) DO NOTHING`,
      [userId, text]
    );
  }

  async removeSavedWisdom(userId, text) {
    await this.pool.query(
      `DELETE FROM saved_wisdom WHERE user_id = $1 AND text = $2`,
      [userId, text]
    );
  }

  async getCycle(userId) {
    const { rows } = await this.pool.query(
      `SELECT last_period, cycle_length FROM cycle_settings WHERE user_id = $1`,
      [userId]
    );
    if (!rows[0]) return null;
    return {
      lastPeriod: rows[0].last_period
        ? new Date(rows[0].last_period).toISOString().slice(0, 10)
        : null,
      cycleLength: rows[0].cycle_length,
    };
  }

  async setCycle(userId, lastPeriod, cycleLength) {
    await this.pool.query(
      `INSERT INTO cycle_settings (user_id, last_period, cycle_length, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (user_id) DO UPDATE
         SET last_period = EXCLUDED.last_period,
             cycle_length = EXCLUDED.cycle_length,
             updated_at = now()`,
      [userId, lastPeriod, cycleLength]
    );
  }

  async trackActiveDay(userId, day) {
    await this.pool.query(
      `INSERT INTO active_days (user_id, day) VALUES ($1,$2)
       ON CONFLICT (user_id, day) DO NOTHING`,
      [userId, day]
    );
  }

  async incrementAdviceRead(userId) {
    await this.pool.query(
      `UPDATE users SET advice_read = advice_read + 1 WHERE id = $1`,
      [userId]
    );
  }

  async getStats(userId) {
    const [q, u, d, s] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS n FROM chat_messages WHERE user_id = $1 AND role = 'user'`,
        [userId]
      ),
      this.pool.query(`SELECT advice_read FROM users WHERE id = $1`, [userId]),
      this.pool.query(`SELECT count(*)::int AS n FROM active_days WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT count(*)::int AS n FROM saved_wisdom WHERE user_id = $1`, [userId]),
    ]);
    return {
      questionsAsked: q.rows[0].n,
      adviceRead: u.rows[0]?.advice_read || 0,
      daysActive: d.rows[0].n,
      savedCount: s.rows[0].n,
    };
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (local dev / demo)
// ---------------------------------------------------------------------------
class MemoryStore {
  constructor() {
    this.users = new Map(); // id -> user
    this.byProvider = new Map(); // `${provider}:${providerId}` -> id
    this.seq = 1;
    this.usage = new Map(); // `${userId}:${day}` -> count
    this.messages = new Map(); // userId -> [{role, content}]
    this.saved = new Map(); // userId -> Set(text)
    this.cycle = new Map(); // userId -> {lastPeriod, cycleLength}
    this.activeDays = new Map(); // userId -> Set(day)
  }

  async findOrCreateUser({ provider, providerId, email, name, avatarUrl }) {
    const key = `${provider}:${providerId}`;
    if (this.byProvider.has(key)) {
      const user = this.users.get(this.byProvider.get(key));
      user.email = email || user.email;
      user.avatar_url = avatarUrl || user.avatar_url;
      return user;
    }
    const id = this.seq++;
    const user = {
      id, provider, provider_id: providerId,
      email: email || null, name: name || null, avatar_url: avatarUrl || null,
      is_premium: false, advice_read: 0, created_at: new Date().toISOString(),
    };
    this.users.set(id, user);
    this.byProvider.set(key, id);
    return user;
  }

  async getUserById(id) { return this.users.get(Number(id)) || null; }
  async updateUserName(id, name) { const u = this.users.get(Number(id)); if (u) u.name = name; }
  async deleteUser(id) {
    id = Number(id);
    const u = this.users.get(id);
    if (u) this.byProvider.delete(`${u.provider}:${u.provider_id}`);
    this.users.delete(id);
    this.messages.delete(id);
    this.saved.delete(id);
    this.cycle.delete(id);
    this.activeDays.delete(id);
    for (const k of [...this.usage.keys()]) if (k.startsWith(id + ":")) this.usage.delete(k);
  }

  async getUsageCount(userId, day) { return this.usage.get(`${userId}:${day}`) || 0; }
  async incrementUsage(userId, day) {
    const k = `${userId}:${day}`;
    const n = (this.usage.get(k) || 0) + 1;
    this.usage.set(k, n);
    return n;
  }

  async addMessage(userId, role, content) {
    if (!this.messages.has(userId)) this.messages.set(userId, []);
    this.messages.get(userId).push({ role, content });
  }
  async getRecentMessages(userId, limit = 50) {
    const all = this.messages.get(userId) || [];
    return all.slice(-limit);
  }

  async getSavedWisdom(userId) { return [...(this.saved.get(userId) || [])].reverse(); }
  async addSavedWisdom(userId, text) {
    if (!this.saved.has(userId)) this.saved.set(userId, new Set());
    this.saved.get(userId).add(text);
  }
  async removeSavedWisdom(userId, text) { this.saved.get(userId)?.delete(text); }

  async getCycle(userId) { return this.cycle.get(userId) || null; }
  async setCycle(userId, lastPeriod, cycleLength) {
    this.cycle.set(userId, { lastPeriod, cycleLength });
  }

  async trackActiveDay(userId, day) {
    if (!this.activeDays.has(userId)) this.activeDays.set(userId, new Set());
    this.activeDays.get(userId).add(day);
  }

  async incrementAdviceRead(userId) {
    const u = this.users.get(Number(userId));
    if (u) u.advice_read += 1;
  }

  async getStats(userId) {
    const msgs = this.messages.get(userId) || [];
    const u = this.users.get(Number(userId));
    return {
      questionsAsked: msgs.filter((m) => m.role === "user").length,
      adviceRead: u?.advice_read || 0,
      daysActive: (this.activeDays.get(userId) || new Set()).size,
      savedCount: (this.saved.get(userId) || new Set()).size,
    };
  }
}
