import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { WISDOM } from "./data/wisdom.js";
import { SITUATIONS } from "./data/situations.js";
import { CYCLE_PHASES, computePhase } from "./data/cycle.js";
import { createStore } from "./store.js";
import { configureAuth, requireAuth, authConfig, clearUserCache } from "./auth.js";
import { generateReply, aiConfigured, extractInsights } from "./ai.js";
import { embedOne, embeddingsConfigured } from "./embeddings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 5);

function today() {
  return new Date().toISOString().slice(0, 10);
}

const store = await createStore();
const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy (needed for secure cookies)
app.use(cors());
app.use(
  express.json({
    limit: "1mb",
    // Keep the raw body so we can verify Paddle webhook signatures.
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---- Billing config (Paddle) ----
const PADDLE = {
  apiKey: process.env.PADDLE_API_KEY,
  clientToken: process.env.PADDLE_CLIENT_TOKEN,
  webhookSecret: process.env.PADDLE_WEBHOOK_SECRET,
  environment: process.env.PADDLE_ENV || "sandbox",
  monthlyPriceId: process.env.PADDLE_MONTHLY_PRICE_ID,
  annualPriceId: process.env.PADDLE_ANNUAL_PRICE_ID,
};
const billingEnabled = () => Boolean(PADDLE.clientToken && (PADDLE.monthlyPriceId || PADDLE.annualPriceId));

// Auth0 (mounts /login, /logout, /callback and attaches req.appUser when logged in).
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

// Build the personalization context for Adam: partner + cycle phase, recent
// events/check-ins, known facts, and semantically-relevant past conversation (RAG).
async function buildUserContext(userId, message) {
  const parts = [];
  let queryEmbedding = null;
  try {
    const partner = await store.getPartner(userId);
    if (partner?.displayName) parts.push(`Partner's name: ${partner.displayName}.`);
    if (partner?.cycle?.lastPeriod) {
      const r = computePhase(partner.cycle.lastPeriod, partner.cycle.cycleLength || 28);
      if (r) parts.push(`Her current cycle phase: ${r.phase} (day ${r.dayOfCycle} of ${r.cycleLength}).`);
    }
    const events = await store.getRecentEvents(userId, 5);
    if (events.length) parts.push("Recent situations he raised: " + events.map((e) => e.summary || e.type).join("; ") + ".");
    const checkins = await store.getRecentCheckins(userId, 2);
    if (checkins.length) parts.push("Recent check-ins: " + checkins.map((c) => [c.mood, c.note].filter(Boolean).join(" — ")).join("; ") + ".");
    const facts = await store.getFacts(userId, 8);
    if (facts.length) parts.push("Known facts: " + facts.join("; ") + ".");

    if (embeddingsConfigured() && store.vectorEnabled) {
      try {
        queryEmbedding = await embedOne(message, "query");
        const mems = await store.searchMemories(userId, queryEmbedding, 5);
        const relevant = mems.filter((m) => m.score == null || m.score > 0.5).map((m) => m.content);
        if (relevant.length) parts.push("Relevant things he said before:\n- " + relevant.join("\n- "));
      } catch (e) {
        console.warn("memory retrieval skipped:", e.status || e.message);
      }
    }
  } catch (e) {
    console.warn("context build error:", e.message);
  }
  return { context: parts.join("\n"), queryEmbedding };
}

// Persist this exchange as long-term memory (fire-and-forget; never blocks the reply).
async function storeMemories(userId, userMsg, reply, userEmbedding) {
  if (!embeddingsConfigured() || !store.vectorEnabled) return;
  try {
    if (userEmbedding) await store.addMemory(userId, "message", userMsg, userEmbedding, { role: "user" });
    const replyEmb = await embedOne(reply, "document");
    await store.addMemory(userId, "message", reply, replyEmb, { role: "assistant" });
  } catch (e) {
    console.warn("memory store skipped:", e.status || e.message);
  }
}

// Phase 21: every few turns, distill durable facts + a session summary in the background.
async function maybeExtractInsights(userId, conversationId) {
  try {
    const n = await store.countUserMessages(userId);
    if (!n || n % 5 !== 0) return; // run on every 5th user message
    const msgs = await store.getRecentConversationMessages(conversationId, 12);
    const { facts, summary } = await extractInsights(msgs);

    if (summary && embeddingsConfigured() && store.vectorEnabled) {
      const emb = await embedOne(summary, "document").catch(() => null);
      if (emb) await store.addMemory(userId, "summary", summary, emb, { kind: "summary" });
    }
    if (facts?.length) {
      const existing = (await store.getFacts(userId, 100)).map((f) => f.toLowerCase());
      for (const f of facts) {
        const lf = f.toLowerCase();
        const dup = existing.some((e) => e.includes(lf) || lf.includes(e));
        if (!dup) {
          await store.addFact(userId, { fact: f, source: "auto" });
          existing.push(lf);
        }
      }
    }
  } catch (e) {
    console.warn("insight extraction skipped:", e.status || e.message);
  }
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
  await store.trackActiveDay(req.appUser.id, today());
  const premium = await store.isPremium(req.appUser.id);
  const remaining = premium
    ? null
    : Math.max(0, FREE_DAILY_LIMIT - (await store.getUsageCount(req.appUser.id, today())));
  const user = { ...publicUser(req.appUser), isPremium: premium };
  res.json({ user, remaining, freeLimit: FREE_DAILY_LIMIT });
});

app.patch("/api/me", requireAuth, async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  await store.updateUserName(req.appUser.id, name);
  req.appUser.name = name; // keep cached copy in sync
  res.json({ ok: true });
});

app.delete("/api/me", requireAuth, async (req, res) => {
  await store.deleteUser(req.appUser.id);
  clearUserCache(req.oidc?.user?.sub);
  res.json({ ok: true }); // client then redirects to /logout to end the Auth0 session
});

app.get("/api/stats", requireAuth, async (req, res) => {
  res.json(await store.getStats(req.appUser.id));
});

// ---- Conversations ----
async function ownedConversation(req, res) {
  const id = Number(req.params.id);
  const conv = await store.getConversation(id);
  if (!conv || conv.user_id !== req.appUser.id) {
    res.status(404).json({ error: "Conversation not found" });
    return null;
  }
  return conv;
}

app.get("/api/conversations", requireAuth, async (req, res) => {
  res.json({ conversations: await store.listConversations(req.appUser.id) });
});
app.post("/api/conversations", requireAuth, async (req, res) => {
  const conv = await store.createConversation(req.appUser.id, null);
  res.json({ conversation: { id: conv.id, title: conv.title, updated_at: conv.updated_at } });
});
app.get("/api/conversations/:id/messages", requireAuth, async (req, res) => {
  const conv = await ownedConversation(req, res);
  if (!conv) return;
  res.json({ messages: await store.getConversationMessages(conv.id) });
});
app.patch("/api/conversations/:id", requireAuth, async (req, res) => {
  const conv = await ownedConversation(req, res);
  if (!conv) return;
  await store.renameConversation(conv.id, String(req.body?.title || "").slice(0, 80));
  res.json({ ok: true });
});
app.delete("/api/conversations/:id", requireAuth, async (req, res) => {
  const conv = await ownedConversation(req, res);
  if (!conv) return;
  await store.deleteConversation(conv.id);
  res.json({ ok: true });
});

// ---- Chat ----
app.post("/api/chat", requireAuth, async (req, res) => {
  const userId = req.appUser.id;
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required." });

  // Resolve the conversation (create one if none supplied).
  let conversationId = Number(req.body?.conversationId) || null;
  if (conversationId) {
    const conv = await store.getConversation(conversationId);
    if (!conv || conv.user_id !== userId) conversationId = null;
  }
  let createdConversation = null;
  if (!conversationId) {
    createdConversation = await store.createConversation(userId, null);
    conversationId = createdConversation.id;
  }

  const premium = await store.isPremium(userId);
  // Per-user freemium limit (premium users are unlimited).
  if (!premium) {
    const used = await store.getUsageCount(userId, today());
    if (used >= FREE_DAILY_LIMIT) {
      return res.status(429).json({
        limitReached: true,
        remaining: 0,
        conversationId,
        message: `You've reached today's free limit of ${FREE_DAILY_LIMIT} questions. Upgrade to Premium for unlimited access to Adam.`,
      });
    }
  }

  await store.addMessage(userId, conversationId, "user", message);
  // Title a fresh conversation from its first message.
  if (createdConversation) {
    const title = message.length > 42 ? message.slice(0, 42).trim() + "…" : message;
    await store.renameConversation(conversationId, title);
  }
  const count = premium ? 0 : await store.incrementUsage(userId, today());
  const remaining = premium ? null : Math.max(0, FREE_DAILY_LIMIT - count);

  try {
    const history = await store.getRecentConversationMessages(conversationId, 10);
    const { context, queryEmbedding } = await buildUserContext(userId, message);
    const { reply, degraded } = await generateReply(history, context);
    await store.addMessage(userId, conversationId, "assistant", reply);
    res.json({ reply, degraded, remaining, conversationId });
    // Save this exchange to long-term memory, then occasionally distill facts — all in
    // the background so the response isn't delayed.
    storeMemories(userId, message, reply, queryEmbedding)
      .then(() => maybeExtractInsights(userId, conversationId))
      .catch(() => {});
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
  res.json({ items: await store.getSavedWisdom(req.appUser.id) });
});
app.post("/api/saved-wisdom", requireAuth, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  await store.addSavedWisdom(req.appUser.id, text);
  res.json({ ok: true });
});
app.delete("/api/saved-wisdom", requireAuth, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  await store.removeSavedWisdom(req.appUser.id, text);
  res.json({ ok: true });
});

// ---- Partner profile ("her") ----
app.get("/api/partner", requireAuth, async (req, res) => {
  res.json({ partner: await store.getPartner(req.appUser.id) });
});
app.post("/api/partner", requireAuth, async (req, res) => {
  const displayName = req.body?.displayName != null ? String(req.body.displayName).trim().slice(0, 80) : null;
  const birthday = req.body?.birthday || null;
  const partner = await store.updatePartner(req.appUser.id, { displayName, birthday });
  res.json({ ok: true, partner: store.getPartnerView ? store.getPartnerView(partner) : partner });
});

// ---- Cycle settings (stored on the partner profile) ----
app.get("/api/cycle", requireAuth, async (req, res) => {
  res.json({ cycle: await store.getCycle(req.appUser.id) });
});
app.post("/api/cycle", requireAuth, async (req, res) => {
  const lastPeriod = req.body?.lastPeriod || null;
  const cycleLength = Math.max(20, Math.min(45, Number(req.body?.cycleLength) || 28));
  await store.setCycle(req.appUser.id, lastPeriod, cycleLength);
  await store.incrementAdviceRead(req.appUser.id);
  const phase = lastPeriod ? computePhase(lastPeriod, cycleLength)?.phase : null;
  await store.addEvent(req.appUser.id, { type: "cycle_updated", summary: phase ? `Cycle updated — ${phase} phase` : "Cycle updated" });
  res.json({ ok: true });
});

// ---- Relationship timeline / check-ins (V3) ----
app.get("/api/timeline", requireAuth, async (req, res) => {
  const [events, checkins] = await Promise.all([
    store.getRecentEvents(req.appUser.id, 20),
    store.getRecentCheckins(req.appUser.id, 10),
  ]);
  res.json({ events, checkins });
});
app.post("/api/event", requireAuth, async (req, res) => {
  const type = String(req.body?.type || "note").slice(0, 40);
  const summary = req.body?.summary != null ? String(req.body.summary).slice(0, 300) : null;
  await store.addEvent(req.appUser.id, { type, summary });
  res.json({ ok: true });
});
app.post("/api/checkin", requireAuth, async (req, res) => {
  const mood = req.body?.mood != null ? String(req.body.mood).slice(0, 40) : null;
  const note = req.body?.note != null ? String(req.body.note).slice(0, 300) : null;
  await store.addCheckin(req.appUser.id, { mood, note });
  await store.addEvent(req.appUser.id, { type: "checkin", summary: [mood, note].filter(Boolean).join(" — ") || "Check-in" });
  res.json({ ok: true });
});

// ---- Advice-read tracking ----
app.post("/api/track-advice", requireAuth, async (req, res) => {
  await store.incrementAdviceRead(req.appUser.id);
  res.json({ ok: true });
});

// ---- Relationship linking (V3 Phase 22) ----
// Note on privacy: linking does NOT share either person's private Adam chats. It only
// records that two accounts are connected (basis for future shared/consented features).
app.get("/api/relationship", requireAuth, async (req, res) => {
  res.json({ relationship: await store.getRelationship(req.appUser.id) });
});
app.post("/api/relationship/invite", requireAuth, async (req, res) => {
  const code = crypto.randomBytes(5).toString("hex").toUpperCase(); // 10-char code
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await store.createInvite(req.appUser.id, code, expiresAt);
  res.json({ ok: true, code, expiresAt });
});
app.post("/api/relationship/accept", requireAuth, async (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Enter an invite code." });
  const result = await store.acceptInvite(req.appUser.id, code);
  if (result.error) return res.status(400).json(result);
  res.json({ ok: true });
});
app.post("/api/relationship/unlink", requireAuth, async (req, res) => {
  await store.unlinkRelationship(req.appUser.id);
  res.json({ ok: true });
});

// ---- Billing (Paddle) ----
// Public-safe config the checkout button needs (client token + price ids are not secret).
app.get("/api/billing/config", (req, res) => {
  res.json({
    enabled: billingEnabled(),
    environment: PADDLE.environment,
    clientToken: PADDLE.clientToken || null,
    monthlyPriceId: PADDLE.monthlyPriceId || null,
    annualPriceId: PADDLE.annualPriceId || null,
  });
});

// Current subscription status for the logged-in user.
app.get("/api/billing/status", requireAuth, async (req, res) => {
  const ent = await store.getEntitlement(req.appUser.id);
  res.json({
    premium: await store.isPremium(req.appUser.id),
    status: ent?.status || "inactive",
    plan: ent?.plan || null,
    currentPeriodEnd: ent?.current_period_end || ent?.currentPeriodEnd || null,
  });
});

// Open the Paddle customer portal (manage/cancel/update card).
const paddleApiBase = () => (PADDLE.environment === "live" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com");
app.post("/api/billing/portal", requireAuth, async (req, res) => {
  const ent = await store.getEntitlement(req.appUser.id);
  const customerId = ent?.provider_customer_id || ent?.customerId;
  if (!customerId || !PADDLE.apiKey) return res.status(400).json({ error: "No subscription to manage yet." });
  try {
    const r = await fetch(`${paddleApiBase()}/customers/${customerId}/portal-sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PADDLE.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const d = await r.json();
    const url = d?.data?.urls?.general?.overview;
    if (!url) return res.status(502).json({ error: "Couldn't open the portal." });
    res.json({ url });
  } catch {
    res.status(502).json({ error: "Couldn't open the portal." });
  }
});

// Paddle webhook: source of truth for entitlement changes. Verifies the signature
// (HMAC-SHA256 over "ts:rawBody") when a secret is configured.
app.post("/api/paddle/webhook", async (req, res) => {
  try {
    if (PADDLE.webhookSecret) {
      const header = req.headers["paddle-signature"] || "";
      const parts = Object.fromEntries(String(header).split(";").map((kv) => kv.split("=")));
      const ts = parts.ts;
      const h1 = parts.h1;
      const signed = `${ts}:${req.rawBody?.toString("utf8") || ""}`;
      const expected = crypto.createHmac("sha256", PADDLE.webhookSecret).update(signed).digest("hex");
      if (!ts || !h1 || expected !== h1) {
        console.warn("Paddle webhook: signature mismatch");
        return res.status(400).json({ error: "invalid signature" });
      }
    }

    const event = req.body;
    const type = event?.event_type || "";
    const data = event?.data || {};
    const userId = Number(data?.custom_data?.user_id);

    if (userId && type.startsWith("subscription.")) {
      const status =
        type === "subscription.canceled"
          ? "canceled"
          : data.status || "active"; // active | trialing | past_due | canceled | paused
      const priceId = data?.items?.[0]?.price?.id;
      const plan = priceId === PADDLE.annualPriceId ? "annual" : priceId === PADDLE.monthlyPriceId ? "monthly" : null;
      await store.setEntitlement(userId, {
        status,
        plan,
        provider: "paddle",
        customerId: data.customer_id,
        subscriptionId: data.id,
        currentPeriodEnd: data?.current_billing_period?.ends_at || null,
      });
      console.log(`Paddle webhook: user ${userId} -> ${status} (${plan || "?"})`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Paddle webhook error:", err.message);
    res.status(200).json({ ok: true }); // ack anyway so Paddle doesn't hammer retries
  }
});

// SPA fallback: serve index.html for non-API, non-auth GET routes.
app.get(/^\/(?!api\/|login|logout|callback).*/, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(
    `Ask Adam v2 on port ${PORT} | AI ${aiConfigured() ? "on (Claude)" : "fallback"} | ` +
      `providers: ${Object.entries(authConfig()).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}`
  );
});
