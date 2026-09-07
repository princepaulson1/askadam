// Data store layer. Uses Postgres when DATABASE_URL is set (Render/production),
// otherwise an in-memory store (local dev / demo only — data is lost on restart).
//
// All methods are async and return plain objects so callers are storage-agnostic.
import pg from "pg";
import { EMBEDDING_DIM } from "./embeddings.js";

const { Pool } = pg;

// Format a JS number[] as a pgvector literal: [0.1,0.2,...]
function toVector(arr) {
  return "[" + arr.join(",") + "]";
}

// Cosine similarity for the in-memory fallback.
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

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
      CREATE TABLE IF NOT EXISTS partners (
        id                SERIAL PRIMARY KEY,
        owner_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        display_name      TEXT,
        birthday          DATE,
        notes             TEXT,
        cycle_last_period DATE,
        cycle_length      INTEGER,
        is_primary        BOOLEAN NOT NULL DEFAULT true,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_partners_owner ON partners(owner_user_id);
      -- One-time migration: carry over any cycle data from the old table if it exists.
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cycle_settings') THEN
          INSERT INTO partners (owner_user_id, cycle_last_period, cycle_length)
          SELECT cs.user_id, cs.last_period, cs.cycle_length
          FROM cycle_settings cs
          WHERE NOT EXISTS (SELECT 1 FROM partners p WHERE p.owner_user_id = cs.user_id);
          DROP TABLE cycle_settings;
        END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS active_days (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day     DATE NOT NULL,
        PRIMARY KEY (user_id, day)
      );
      -- V3: relationship state, timeline, and check-ins
      CREATE TABLE IF NOT EXISTS relationship_state (
        partner_id          INTEGER PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
        stage               TEXT,
        tension_level       INTEGER,
        current_cycle_phase TEXT,
        goals               JSONB,
        last_checkin_at     TIMESTAMPTZ,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS events (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        partner_id  INTEGER,
        type        TEXT NOT NULL,
        summary     TEXT,
        metadata    JSONB,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS checkins (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        partner_id INTEGER,
        mood       TEXT,
        note       TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- V3 Phase 22: link two real app users into a relationship (invite + consent)
      CREATE TABLE IF NOT EXISTS relationships (
        id         SERIAL PRIMARY KEY,
        user_a_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status     TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_a_id, user_b_id)
      );
      CREATE TABLE IF NOT EXISTS relationship_invites (
        id           SERIAL PRIMARY KEY,
        from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code         TEXT NOT NULL UNIQUE,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at   TIMESTAMPTZ
      );
    `);

    // V3: pgvector for long-term semantic memory (guarded — degrade if unavailable).
    try {
      await this.pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS memories (
          id         SERIAL PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL DEFAULT 'message',
          content    TEXT NOT NULL,
          embedding  vector(${EMBEDDING_DIM}),
          metadata   JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_memories_vec ON memories USING hnsw (embedding vector_cosine_ops);
        CREATE TABLE IF NOT EXISTS memory_facts (
          id         SERIAL PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          partner_id INTEGER,
          fact       TEXT NOT NULL,
          confidence REAL,
          source     TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      this.vectorEnabled = true;
      console.log("pgvector: enabled");
    } catch (e) {
      this.vectorEnabled = false;
      console.warn("pgvector: unavailable —", e.message);
    }
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

  async countUserMessages(userId) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM chat_messages WHERE user_id = $1 AND role = 'user'`,
      [userId]
    );
    return rows[0].n;
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

  // ---- Partners (a partner profile owned by the user; "her") ----
  async getPrimaryPartner(userId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM partners WHERE owner_user_id = $1 ORDER BY is_primary DESC, id ASC LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  async ensurePrimaryPartner(userId) {
    const existing = await this.getPrimaryPartner(userId);
    if (existing) return existing;
    const { rows } = await this.pool.query(
      `INSERT INTO partners (owner_user_id, is_primary) VALUES ($1, true) RETURNING *`,
      [userId]
    );
    return rows[0];
  }

  async updatePartner(userId, { displayName, birthday, notes }) {
    const p = await this.ensurePrimaryPartner(userId);
    const { rows } = await this.pool.query(
      `UPDATE partners
         SET display_name = COALESCE($2, display_name),
             birthday     = COALESCE($3, birthday),
             notes        = COALESCE($4, notes),
             updated_at   = now()
       WHERE id = $1 RETURNING *`,
      [p.id, displayName ?? null, birthday ?? null, notes ?? null]
    );
    return rows[0];
  }

  getPartnerView(p) {
    if (!p) return null;
    return {
      id: p.id,
      displayName: p.display_name,
      birthday: p.birthday ? new Date(p.birthday).toISOString().slice(0, 10) : null,
      cycle:
        p.cycle_last_period || p.cycle_length
          ? {
              lastPeriod: p.cycle_last_period
                ? new Date(p.cycle_last_period).toISOString().slice(0, 10)
                : null,
              cycleLength: p.cycle_length,
            }
          : null,
    };
  }

  async getPartner(userId) {
    return this.getPartnerView(await this.getPrimaryPartner(userId));
  }

  async getCycle(userId) {
    const p = await this.getPrimaryPartner(userId);
    if (!p || (!p.cycle_last_period && !p.cycle_length)) return null;
    return {
      lastPeriod: p.cycle_last_period
        ? new Date(p.cycle_last_period).toISOString().slice(0, 10)
        : null,
      cycleLength: p.cycle_length,
    };
  }

  async setCycle(userId, lastPeriod, cycleLength) {
    const p = await this.ensurePrimaryPartner(userId);
    await this.pool.query(
      `UPDATE partners SET cycle_last_period = $2, cycle_length = $3, updated_at = now() WHERE id = $1`,
      [p.id, lastPeriod, cycleLength]
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

  // ---- V3: events / check-ins / state ----
  async addEvent(userId, { type, summary, partnerId = null, metadata = null }) {
    await this.pool.query(
      `INSERT INTO events (user_id, partner_id, type, summary, metadata) VALUES ($1,$2,$3,$4,$5)`,
      [userId, partnerId, type, summary || null, metadata ? JSON.stringify(metadata) : null]
    );
  }
  async getRecentEvents(userId, limit = 5) {
    const { rows } = await this.pool.query(
      `SELECT type, summary, occurred_at FROM events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows;
  }
  async addCheckin(userId, { mood, note, partnerId = null }) {
    await this.pool.query(
      `INSERT INTO checkins (user_id, partner_id, mood, note) VALUES ($1,$2,$3,$4)`,
      [userId, partnerId, mood || null, note || null]
    );
  }
  async getRecentCheckins(userId, limit = 3) {
    const { rows } = await this.pool.query(
      `SELECT mood, note, created_at FROM checkins WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows;
  }

  // ---- V3: semantic memory (pgvector) ----
  async addMemory(userId, kind, content, embedding, metadata = null) {
    if (!this.vectorEnabled || !embedding) return;
    await this.pool.query(
      `INSERT INTO memories (user_id, kind, content, embedding, metadata)
       VALUES ($1,$2,$3,$4::vector,$5)`,
      [userId, kind, content, toVector(embedding), metadata ? JSON.stringify(metadata) : null]
    );
  }
  async searchMemories(userId, queryEmbedding, k = 5) {
    if (!this.vectorEnabled || !queryEmbedding) return [];
    const { rows } = await this.pool.query(
      `SELECT content, kind, 1 - (embedding <=> $2::vector) AS score
         FROM memories
        WHERE user_id = $1 AND embedding IS NOT NULL
        ORDER BY embedding <=> $2::vector
        LIMIT $3`,
      [userId, toVector(queryEmbedding), k]
    );
    return rows;
  }
  async addFact(userId, { fact, partnerId = null, confidence = null, source = null }) {
    await this.pool.query(
      `INSERT INTO memory_facts (user_id, partner_id, fact, confidence, source) VALUES ($1,$2,$3,$4,$5)`,
      [userId, partnerId, fact, confidence, source]
    );
  }
  async getFacts(userId, limit = 10) {
    const { rows } = await this.pool.query(
      `SELECT fact FROM memory_facts WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows.map((r) => r.fact);
  }

  // ---- V3 Phase 22: relationship linking ----
  async createInvite(userId, code, expiresAt) {
    await this.pool.query(
      `INSERT INTO relationship_invites (from_user_id, code, expires_at) VALUES ($1,$2,$3)`,
      [userId, code, expiresAt]
    );
    return code;
  }
  async acceptInvite(userId, code) {
    const { rows } = await this.pool.query(
      `SELECT * FROM relationship_invites WHERE code = $1`,
      [code]
    );
    const invite = rows[0];
    if (!invite) return { error: "Invalid invite code." };
    if (invite.status !== "pending") return { error: "This invite was already used." };
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) return { error: "This invite has expired." };
    if (invite.from_user_id === userId) return { error: "You can't accept your own invite." };
    // Order the pair consistently to respect the UNIQUE constraint.
    const a = Math.min(invite.from_user_id, userId);
    const b = Math.max(invite.from_user_id, userId);
    await this.pool.query(
      `INSERT INTO relationships (user_a_id, user_b_id, status) VALUES ($1,$2,'active')
       ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET status = 'active'`,
      [a, b]
    );
    await this.pool.query(`UPDATE relationship_invites SET status = 'accepted' WHERE id = $1`, [invite.id]);
    return { ok: true };
  }
  async getRelationship(userId) {
    const { rows } = await this.pool.query(
      `SELECT r.*, ua.name AS a_name, ub.name AS b_name
         FROM relationships r
         JOIN users ua ON ua.id = r.user_a_id
         JOIN users ub ON ub.id = r.user_b_id
        WHERE r.status = 'active' AND (r.user_a_id = $1 OR r.user_b_id = $1)
        ORDER BY r.created_at DESC LIMIT 1`,
      [userId]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    const isA = r.user_a_id === userId;
    return { id: r.id, partnerName: isA ? r.b_name : r.a_name, since: r.created_at };
  }
  async unlinkRelationship(userId) {
    await this.pool.query(
      `UPDATE relationships SET status = 'ended' WHERE status = 'active' AND (user_a_id = $1 OR user_b_id = $1)`,
      [userId]
    );
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
    this.partners = new Map(); // userId -> partner object (primary)
    this.activeDays = new Map(); // userId -> Set(day)
    this.events = new Map(); // userId -> [{type, summary, occurred_at}]
    this.checkins = new Map(); // userId -> [{mood, note, created_at}]
    this.memories = new Map(); // userId -> [{kind, content, embedding}]
    this.facts = new Map(); // userId -> [fact]
    this.invites = new Map(); // code -> {fromUserId, status, expiresAt}
    this.relationships = []; // [{a, b, status, created_at}]
    this.vectorEnabled = true; // naive cosine search in memory
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
    this.partners.delete(id);
    this.activeDays.delete(id);
    this.events.delete(id);
    this.checkins.delete(id);
    this.memories.delete(id);
    this.facts.delete(id);
    this.relationships = this.relationships.filter((r) => r.a !== id && r.b !== id);
    for (const [code, inv] of [...this.invites]) if (inv.fromUserId === id) this.invites.delete(code);
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
  async countUserMessages(userId) {
    return (this.messages.get(userId) || []).filter((m) => m.role === "user").length;
  }

  async getSavedWisdom(userId) { return [...(this.saved.get(userId) || [])].reverse(); }
  async addSavedWisdom(userId, text) {
    if (!this.saved.has(userId)) this.saved.set(userId, new Set());
    this.saved.get(userId).add(text);
  }
  async removeSavedWisdom(userId, text) { this.saved.get(userId)?.delete(text); }

  // ---- Partners ----
  ensurePartner(userId) {
    let p = this.partners.get(Number(userId));
    if (!p) {
      p = { id: Number(userId), displayName: null, birthday: null, notes: null, cycle: null };
      this.partners.set(Number(userId), p);
    }
    return p;
  }
  async getPartner(userId) {
    const p = this.partners.get(Number(userId));
    return p ? { id: p.id, displayName: p.displayName, birthday: p.birthday, cycle: p.cycle } : null;
  }
  async updatePartner(userId, { displayName, birthday, notes }) {
    const p = this.ensurePartner(userId);
    if (displayName !== undefined && displayName !== null) p.displayName = displayName;
    if (birthday !== undefined && birthday !== null) p.birthday = birthday;
    if (notes !== undefined && notes !== null) p.notes = notes;
    return p;
  }
  async getCycle(userId) { return this.partners.get(Number(userId))?.cycle || null; }
  async setCycle(userId, lastPeriod, cycleLength) {
    const p = this.ensurePartner(userId);
    p.cycle = { lastPeriod, cycleLength };
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

  // ---- V3: events / check-ins / state ----
  async addEvent(userId, { type, summary }) {
    if (!this.events.has(userId)) this.events.set(userId, []);
    this.events.get(userId).push({ type, summary, occurred_at: new Date().toISOString() });
  }
  async getRecentEvents(userId, limit = 5) {
    return (this.events.get(userId) || []).slice(-limit).reverse();
  }
  async addCheckin(userId, { mood, note }) {
    if (!this.checkins.has(userId)) this.checkins.set(userId, []);
    this.checkins.get(userId).push({ mood, note, created_at: new Date().toISOString() });
  }
  async getRecentCheckins(userId, limit = 3) {
    return (this.checkins.get(userId) || []).slice(-limit).reverse();
  }

  // ---- V3: semantic memory (naive cosine) ----
  async addMemory(userId, kind, content, embedding) {
    if (!embedding) return;
    if (!this.memories.has(userId)) this.memories.set(userId, []);
    this.memories.get(userId).push({ kind, content, embedding });
  }
  async searchMemories(userId, queryEmbedding, k = 5) {
    if (!queryEmbedding) return [];
    const items = this.memories.get(userId) || [];
    return items
      .map((m) => ({ content: m.content, kind: m.kind, score: cosine(m.embedding, queryEmbedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
  async addFact(userId, { fact }) {
    if (!this.facts.has(userId)) this.facts.set(userId, []);
    this.facts.get(userId).push(fact);
  }
  async getFacts(userId, limit = 10) {
    return (this.facts.get(userId) || []).slice(-limit).reverse();
  }

  // ---- V3 Phase 22: relationship linking ----
  async createInvite(userId, code, expiresAt) {
    this.invites.set(code, { fromUserId: Number(userId), status: "pending", expiresAt });
    return code;
  }
  async acceptInvite(userId, code) {
    userId = Number(userId);
    const invite = this.invites.get(code);
    if (!invite) return { error: "Invalid invite code." };
    if (invite.status !== "pending") return { error: "This invite was already used." };
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return { error: "This invite has expired." };
    if (invite.fromUserId === userId) return { error: "You can't accept your own invite." };
    const a = Math.min(invite.fromUserId, userId);
    const b = Math.max(invite.fromUserId, userId);
    if (!this.relationships.some((r) => r.a === a && r.b === b && r.status === "active")) {
      this.relationships.push({ a, b, status: "active", created_at: new Date().toISOString() });
    }
    invite.status = "accepted";
    return { ok: true };
  }
  async getRelationship(userId) {
    userId = Number(userId);
    const r = [...this.relationships].reverse().find((x) => x.status === "active" && (x.a === userId || x.b === userId));
    if (!r) return null;
    const otherId = r.a === userId ? r.b : r.a;
    return { id: `${r.a}-${r.b}`, partnerName: this.users.get(otherId)?.name || null, since: r.created_at };
  }
  async unlinkRelationship(userId) {
    userId = Number(userId);
    this.relationships.forEach((r) => {
      if (r.status === "active" && (r.a === userId || r.b === userId)) r.status = "ended";
    });
  }
}
