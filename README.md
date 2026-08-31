# Ask Adam

A private AI relationship mentor for men, with user accounts. Ask Adam helps men build
healthier relationships, understand emotions and communication, improve intimacy, and
understand their partner's menstrual/hormonal cycle — in the voice of a calm, wise,
respectful mentor.

## Features
- **Accounts** — sign in with Google or Facebook (OAuth / OpenID Connect). Apple and
  native mobile apps are planned for a later phase.
- **Ask Adam** — AI chat powered by Anthropic Claude, using Adam's mentor persona. Per-user history.
- **Her Cycle Guide** — estimate cycle phase and get supportive guidance (settings saved per user).
- **Real Situations** — quick advice for common scenarios.
- **Daily Wisdom** — short daily relationship advice, savable to your account.
- **My Growth** — questions asked, advice read, and days active, derived from your data.
- **Freemium** — 5 free questions/day per user, Premium (€6.99/mo) screen (payments not yet enabled).
- **Privacy** — log out and permanent account deletion built in.

## Tech
- Node.js + Express — serves the API and the static frontend from one service.
- Vanilla HTML/CSS/JS frontend (mobile-first, PWA-ready) — no build step.
- Anthropic Claude (Messages API), called server-side (key never exposed).
- Authentication via Passport (Google + Facebook); sessions via express-session.
- PostgreSQL for users, sessions, chat history, saved wisdom, cycle settings, and usage.
- Falls back to an in-memory store when no database is configured (local dev only).

## Run locally
1. Install Node.js 18+ (20 recommended).
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env`. For a quick local run you only need:
   ```
   SESSION_SECRET=any-long-random-string
   ALLOW_DEV_LOGIN=true
   # ANTHROPIC_API_KEY=sk-ant-...   (optional; without it Adam gives a fallback reply)
   ```
   With no `DATABASE_URL`, the app uses an in-memory store (data resets on restart).
4. Start: `npm start`
5. Open http://localhost:3000 and use **Continue with email (test)** to log in.

## Setting up social login (OAuth)

### Google
1. Go to https://console.cloud.google.com/apis/credentials → Create OAuth client ID (Web).
2. Authorized redirect URI: `{APP_URL}/auth/google/callback`
   - local: `http://localhost:3000/auth/google/callback`
   - prod:  `https://your-app.onrender.com/auth/google/callback`
3. Put the client id/secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

### Facebook
1. Go to https://developers.facebook.com/apps → create an app → add Facebook Login.
2. Valid OAuth Redirect URI: `{APP_URL}/auth/facebook/callback`
3. Put the app id/secret in `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET`.

`APP_URL` must match the domain the app is served from, or OAuth callbacks will fail.

## Deploy to Render.com

### Option A — Blueprint (recommended)
1. Push this folder to a GitHub repository.
2. In Render: **New +** → **Blueprint**, select your repo. `render.yaml` provisions:
   - a free **PostgreSQL** database (`ask-adam-db`),
   - the **web service** with `DATABASE_URL` and `SESSION_SECRET` wired automatically.
3. Set these secret env vars in the dashboard when prompted:
   - `ANTHROPIC_API_KEY`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`
4. Click **Apply**. After the first deploy, set `APP_URL` to your live URL
   (e.g. `https://ask-adam.onrender.com`) and add that domain's callback URLs in the
   Google/Facebook consoles. Redeploy.
5. Keep `ALLOW_DEV_LOGIN` unset/`false` in production.

### Option B — Manual
1. Create a **PostgreSQL** instance in Render; copy its Internal Connection String.
2. Create a **Web Service** from the repo: Build `npm install`, Start `npm start`,
   Health check `/api/health`.
3. Add env vars: `DATABASE_URL`, `SESSION_SECRET`, `APP_URL`, `NODE_ENV=production`,
   `ANTHROPIC_API_KEY`, and the OAuth client id/secrets.

The server listens on `process.env.PORT` (set by Render). Tables are created automatically
on first boot.

## Environment variables
| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SESSION_SECRET` | Yes | — | Signs session cookies (use a long random string) |
| `DATABASE_URL` | Prod | — | Postgres connection string (in-memory if unset) |
| `APP_URL` | For OAuth | `http://localhost:3000` | Base URL for OAuth callbacks |
| `ANTHROPIC_API_KEY` | For real AI | — | Anthropic Claude key (server-side only) |
| `ANTHROPIC_MODEL` | No | `claude-3-5-sonnet-latest` | Claude model |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | For Google login | — | Google OAuth credentials |
| `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET` | For Facebook login | — | Facebook OAuth credentials |
| `FREE_DAILY_LIMIT` | No | `5` | Free questions per day per user |
| `ALLOW_DEV_LOGIN` | No | on when not production | Email-only test login |
| `NODE_ENV` | No | `development` | Set to `production` on Render |

## Data model
`users`, `usage` (daily counts), `chat_messages`, `saved_wisdom`, `cycle_settings`,
`active_days`, plus a `session` table managed by connect-pg-simple. Deleting an account
cascades and removes all associated rows.

## Safety
Adam is prompted to be respectful and non-manipulative, to never shame the user, and to
encourage healthy, consenting relationships. It is not a substitute for therapy or medical care.

## Roadmap
- Apple "Sign in with Apple" + native iOS/Android apps (React Native/Expo or Capacitor).
- Real subscriptions (RevenueCat over App Store / Play in-app purchases; Stripe on web).
- Push notifications for Daily Wisdom, transactional email, analytics and crash reporting.
