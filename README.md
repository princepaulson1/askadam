# Ask Adam

A private AI relationship mentor for men, with user accounts via Auth0. Ask Adam helps men
build healthier relationships, understand emotions and communication, improve intimacy, and
understand their partner's menstrual/hormonal cycle — in the voice of a calm, wise,
respectful mentor.

## Features
- **Accounts via Auth0** — sign in with Google, Facebook, email/password and more.
  Providers are configured in the Auth0 dashboard; no per-provider app code.
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
- Authentication via **Auth0** (`express-openid-connect`); encrypted cookie sessions.
- PostgreSQL for users, chat history, saved wisdom, cycle settings, and usage.
- Falls back to an in-memory store when no database is configured (local dev only).

## Auth0 setup
Create a **Regular Web Application** in the Auth0 dashboard, then set:
- **Allowed Callback URLs:** `https://ask-adam.onrender.com/callback`, `http://localhost:3000/callback`
- **Allowed Logout URLs:** `https://ask-adam.onrender.com`, `http://localhost:3000`
- Enable the **Google** / **Facebook** (and later Apple) connections under Authentication → Social.

From the application's settings you need:
- **Domain** → `ISSUER_BASE_URL` (e.g. `https://your-tenant.us.auth0.com`)
- **Client ID** → `CLIENT_ID`

Login uses Auth0's ID-token flow, so **no client secret is required** by the app.
`SECRET` is a random string this app uses to encrypt its own session cookie.

## Run locally
1. Install Node.js 18+ (20 recommended).
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and fill in:
   ```
   ISSUER_BASE_URL=https://your-tenant.us.auth0.com
   CLIENT_ID=your-client-id
   SECRET=a-long-random-string
   BASE_URL=http://localhost:3000
   ANTHROPIC_API_KEY=sk-ant-...   (optional; without it Adam gives a fallback reply)
   ```
   With no `DATABASE_URL`, the app uses an in-memory store (data resets on restart).
4. Start: `npm start`
5. Open http://localhost:3000 and click **Log in / Sign up**.

## Deploy to Render.com

### Blueprint (recommended)
1. Push this repo to GitHub.
2. In Render: **New +** → **Blueprint**, select your repo. `render.yaml` provisions a free
   Postgres database and the web service, and auto-generates `SECRET`.
3. Set these env vars in the dashboard:
   - `ANTHROPIC_API_KEY` (secret)
   - `ISSUER_BASE_URL` (your Auth0 domain)
   - `CLIENT_ID` (your Auth0 app client id)
   - `BASE_URL` (your live URL, e.g. `https://ask-adam.onrender.com`)
4. Click **Apply**. Tables are created automatically on first boot.

The server listens on `process.env.PORT` (set by Render).

## Environment variables
| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ISSUER_BASE_URL` | Yes | — | Auth0 tenant domain (issuer) |
| `CLIENT_ID` | Yes | — | Auth0 application client id |
| `SECRET` | Yes | — | Encrypts the app's session cookie (long random string) |
| `BASE_URL` | Yes | `http://localhost:3000` | Public app URL; must match Auth0 callback/logout URLs |
| `DATABASE_URL` | Prod | — | Postgres connection string (in-memory if unset) |
| `ANTHROPIC_API_KEY` | For real AI | — | Anthropic Claude key (server-side only) |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-6` | Claude model |
| `FREE_DAILY_LIMIT` | No | `5` | Free questions per day per user |
| `NODE_ENV` | No | `development` | Set to `production` on Render |

## Data model
`users`, `usage` (daily counts), `chat_messages`, `saved_wisdom`, `cycle_settings`,
`active_days`. Deleting an account cascades and removes all associated rows.
Sessions are stored in an encrypted cookie by Auth0's SDK (no session table needed).

## Safety
Adam is prompted to be respectful and non-manipulative, to never shame the user, and to
encourage healthy, consenting relationships. It is not a substitute for therapy or medical care.

## Roadmap
- Apple "Sign in with Apple" + native iOS/Android apps.
- Real subscriptions (RevenueCat over App Store / Play in-app purchases; Stripe on web).
- Push notifications, transactional email, analytics and crash reporting.
