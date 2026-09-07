// AI client — Anthropic Claude (Messages API).
// The API key is read from the environment (ANTHROPIC_API_KEY) and never logged.
import { ADAM_SYSTEM_PROMPT, fallbackReply } from "./adam.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

export function aiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Generate Adam's reply.
 * @param {Array<{role:'user'|'assistant', content:string}>} history - prior turns incl. latest user message
 * @returns {Promise<{reply:string, degraded?:boolean}>}
 */
export async function generateReply(history, context = "") {
  const key = process.env.ANTHROPIC_API_KEY;
  const latest = [...history].reverse().find((m) => m.role === "user")?.content || "";

  // Graceful fallback when no key is configured, so the app still works.
  if (!key) {
    return { reply: fallbackReply(latest), degraded: true };
  }

  const system = context
    ? `${ADAM_SYSTEM_PROMPT}\n\n# What you remember about this user (use it naturally; don't recite it)\n${context}`
    : ADAM_SYSTEM_PROMPT;

  const messages = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

  // Anthropic requires the first message to be from the user.
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length) messages.push({ role: "user", content: latest || "Hello" });

  const headers = {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };
  // Identity-linked / org-level keys require the workspace id header.
  if (process.env.ANTHROPIC_WORKSPACE_ID) {
    headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 700,
      temperature: 0.7,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Anthropic ${res.status}`);
    err.status = res.status;
    err.detail = detail.slice(0, 500);
    throw err;
  }

  const data = await res.json();
  const reply =
    Array.isArray(data?.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim()
      : "";
  return { reply: reply || fallbackReply(latest) };
}

// Phase 21: distill durable facts + a one-line summary from a conversation slice.
// Returns { facts: string[], summary: string }. Best-effort; never throws upward.
export async function extractInsights(messages) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !messages?.length) return { facts: [], summary: "" };

  const convo = messages
    .map((m) => `${m.role === "user" ? "Man" : "Adam"}: ${m.content}`)
    .join("\n")
    .slice(-6000);

  const system =
    "You extract durable, reusable facts from a conversation between a man and his " +
    "relationship mentor. Capture only stable, useful facts about him, his partner, or their " +
    "relationship (names, important dates, recurring issues, preferences, boundaries, goals). " +
    "Ignore one-off or transient details. Respond with ONLY valid JSON of the form " +
    '{"facts":["..."],"summary":"..."} — at most 5 facts, each under 15 words, and a one-sentence summary.';

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 400,
        temperature: 0,
        system,
        messages: [{ role: "user", content: convo }],
      }),
    });
    if (!res.ok) return { facts: [], summary: "" };
    const data = await res.json();
    let text = Array.isArray(data?.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("")
      : "";
    text = text.replace(/```json|```/g, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return { facts: [], summary: "" };
    const parsed = JSON.parse(text.slice(start, end + 1));
    const facts = Array.isArray(parsed.facts)
      ? parsed.facts.map((f) => String(f).trim()).filter(Boolean).slice(0, 5)
      : [];
    return { facts, summary: String(parsed.summary || "").trim() };
  } catch {
    return { facts: [], summary: "" };
  }
}
