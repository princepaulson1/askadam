// Authentication via Auth0 (express-openid-connect).
// Auth0 handles Google, Facebook, Apple, email/password, etc. as "Connections"
// configured in the Auth0 dashboard — the app code stays the same per provider.
import { auth } from "express-openid-connect";

// In-process cache mapping Auth0 `sub` -> our database user, to avoid a DB lookup
// on every request. Cleared on account deletion.
const userCache = new Map();

export function clearUserCache(sub) {
  if (sub) userCache.delete(sub);
}

export function authConfig() {
  return {
    auth0: Boolean(process.env.CLIENT_ID && process.env.ISSUER_BASE_URL),
  };
}

export function configureAuth(app, store) {
  if (!authConfig().auth0) {
    console.warn(
      "Auth0 not configured — set ISSUER_BASE_URL, CLIENT_ID, SECRET, BASE_URL. Auth endpoints will 401."
    );
    return;
  }

  // Mounts /login, /logout, and /callback automatically.
  app.use(
    auth({
      authRequired: false, // API + static assets are public; requireAuth guards per-user routes
      auth0Logout: true, // log out of Auth0 too, not just the local session
      baseURL: process.env.BASE_URL,
      issuerBaseURL: process.env.ISSUER_BASE_URL,
      clientID: process.env.CLIENT_ID,
      secret: process.env.SECRET,
      routes: { login: "/login", logout: "/logout", postLogoutRedirect: "/" },
      authorizationParams: {
        response_type: "id_token",
        response_mode: "form_post",
        scope: "openid profile email",
      },
    })
  );

  // Resolve the Auth0 identity to our database user and attach it as req.appUser.
  app.use(async (req, res, next) => {
    try {
      if (req.oidc?.isAuthenticated() && req.oidc.user?.sub) {
        const sub = req.oidc.user.sub;
        let u = userCache.get(sub);
        if (!u) {
          u = await store.findOrCreateUser({
            provider: "auth0",
            providerId: sub,
            email: req.oidc.user.email,
            name: req.oidc.user.name || req.oidc.user.nickname || req.oidc.user.email,
            avatarUrl: req.oidc.user.picture,
          });
          userCache.set(sub, u);
        }
        req.appUser = u;
      }
    } catch (e) {
      console.error("user resolve error:", e.message);
    }
    next();
  });
}

export function requireAuth(req, res, next) {
  if (req.appUser) return next();
  res.status(401).json({ error: "Not authenticated" });
}
