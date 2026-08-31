import "dotenv/config";
import express from "express";
import cors from "cors";
import session from "express-session";
import passport from "passport";
import connectPgSimple from "connect-pg-simple";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WISDOM } from "./data/wisdom.js";
import { SITUATIONS } from "./data/situations.js";
import { CYCLE_PHASES } from "./data/cycle.js";
import { createStore } from "./store.js";
import { configureAuth, requireAuth, authConfig } from "./auth.js";
import { generateReply, aiConfigured } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 5);
const isProd = process.env.NODE_ENV === "production";

function today() {
  return new Date().toISOString().slice(0, 10);
}

const store = await createStore();
const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy (needed for secure cookies)
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- Sessions ----
const sessionConfig = {
  secret: process.env.SESSION_SECRET || "dev-insecure-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd, // HTTPS-only cookies in production
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  },
};
// Persist sessions in Postgres when available so logins survive restarts.
if (store.pool) {
  const PgSession = connectPgSimple(session);
  sessionConfig.store = new PgSession({ pool: store.pool, createTableIfMissing: true });
}
app.use(session(sessionConfig));
app.use(passport.initialize());
app.use(passport.session());

configureAuth(app, store);

// ---- Static frontend ----
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// ---- Helpers ----
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatar_url,
    isPremium: u.is_premium,
    provider: u.provider,
  };
}

// ---- Public endpoints ----
app.get("/api/health", (req, res) => {
  res.json({ ok: true, aiConfigured: aiConfigured() });
});

app.get("/api/config", (req, res) => {
  res.json({ providers: authConfig(), freeLimit: FREE_DAILY_LIMIT });
});

app.get("/api/wisdom", (req, res) => res.json({ items: WISDOM }));
app.get("/api/situations", (req, res) => res.json({ items: SITUATIONS }));
app.get("/api/cycle-advice", (req, res) => res.json({ phases: CYCLE_PHASES }));

// ---- Account endpoints ----
app.get("/api/me", requireAuth, async (req, res) => {
  await store.trackActiveDay(req.user.id, today());
  const remaining = req.user.is_premium
    ? null
    : Math.max(0, FREE_DAILY_LIMIT - (await store.getUsageCount(req.user.id, today())));
  res.json({ user: publicUser(req.user), remaining, freeLimit: FREE_DAILY_LIMIT });
});

app.patch("/api/me", requireAuth, async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  await store.updateUserName(req.user.id, name);
  res.json({ ok: true });
});

app.delete("/api/me", requireAuth, async (req, res, next) => {
  const id = req.user.id;
  await store.deleteUser(id);
  req.logout(() => req.session.destroy(() => res.json({ ok: true })));
});

app.get("/api/stats", requireAuth, async (req, res) => {
  res.json(await store.getStats(req.user.id));
});

// ---- Chat ----
app.get("/api/history", requireAuth, async (req, res) => {
  res.json({ messages: await store.getRecentMessages(req.user.id, 100) });
});

app.post("/api/chat", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required." });

  // Per-user freemium limit (premium users are unlimited).
  if (!req.user.is_premium) {
    const used = await store.getUsageCount(userId, today());
    if (used >= FREE_DAILY_LIMIT) {
      return res.status(429).json({
        limitReached: true,
        remaining: 0,
        message: `You've reached today's free limit of ${FREE_DAILY_LIMIT} questions. Upgrade to Premium for unlimited access to Adam.`,
      });
    }
  }

  await store.addMessage(userId, "user", message);
  const count = req.user.is_premium ? 0 : await store.incrementUsage(userId, today());
  const remaining = req.user.is_premium ? null : Math.max(0, FREE_DAILY_LIMIT - count);

  try {
    const history = await store.getRecentMessages(userId, 10);
    const { reply, degraded } = await generateReply(history);
    await store.addMessage(userId, "assistant", reply);
    res.json({ reply, degraded, remaining });
  } catch (err) {
    console.error("AI error:", err.status || "", err.detail || err.message || err);
    res.status(502).json({
      error: "Adam is having trouble responding right now. Please try again in a moment.",
      remaining,
    });
  }
});

// ---- Saved wisdom ----
app.get("/api/saved-wisdom", requireAuth, async (req, res) => {
  res.json({ items: await store.getSavedWisdom(req.user.id) });
});
app.post("/api/saved-wisdom", requireAuth, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  await store.addSavedWisdom(req.user.id, text);
  res.json({ ok: true });
});
app.delete("/api/saved-wisdom", requireAuth, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  await store.removeSavedWisdom(req.user.id, text);
  res.json({ ok: true });
});

// ---- Cycle settings ----
app.get("/api/cycle", requireAuth, async (req, res) => {
  res.json({ cycle: await store.getCycle(req.user.id) });
});
app.post("/api/cycle", requireAuth, async (req, res) => {
  const lastPeriod = req.body?.lastPeriod || null;
  const cycleLength = Math.max(20, Math.min(45, Number(req.body?.cycleLength) || 28));
  await store.setCycle(req.user.id, lastPeriod, cycleLength);
  await store.incrementAdviceRead(req.user.id);
  res.json({ ok: true });
});

// ---- Advice-read tracking ----
app.post("/api/track-advice", requireAuth, async (req, res) => {
  await store.incrementAdviceRead(req.user.id);
  res.json({ ok: true });
});

// SPA fallback: serve index.html for non-API, non-auth GET routes.
app.get(/^\/(?!api\/|auth\/).*/, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(
    `Ask Adam v2 on port ${PORT} | AI ${aiConfigured() ? "on (Claude)" : "fallback"} | ` +
      `providers: ${Object.entries(authConfig()).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}`
  );
});
