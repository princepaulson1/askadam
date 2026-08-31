// Simple in-memory per-IP daily rate limiter for the freemium free tier.
// NOTE (V1 limitation): resets when the server restarts/redeploys, and is per
// instance. Good enough for MVP; swap for Redis/DB when you scale.

const counters = new Map(); // ip -> { date: 'YYYY-MM-DD', count: n }

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function checkAndIncrement(ip, limit) {
  const day = today();
  const entry = counters.get(ip);
  if (!entry || entry.date !== day) {
    counters.set(ip, { date: day, count: 1 });
    return { allowed: true, remaining: Math.max(0, limit - 1) };
  }
  if (entry.count >= limit) {
    return { allowed: false, remaining: 0 };
  }
  entry.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - entry.count) };
}

export function getRemaining(ip, limit) {
  const entry = counters.get(ip);
  if (!entry || entry.date !== today()) return limit;
  return Math.max(0, limit - entry.count);
}
