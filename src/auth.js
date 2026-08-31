// Authentication: Passport (Google + Facebook OAuth) + a gated dev login.
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as FacebookStrategy } from "passport-facebook";

const APP_URL = process.env.APP_URL || "http://localhost:3000";

export function authConfig() {
  return {
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    facebook: Boolean(process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET),
    devLogin:
      process.env.ALLOW_DEV_LOGIN === "true" || process.env.NODE_ENV !== "production",
  };
}

export function configureAuth(app, store) {
  const cfg = authConfig();

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      done(null, await store.getUserById(id));
    } catch (err) {
      done(err);
    }
  });

  // ---- Google ----
  if (cfg.google) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: `${APP_URL}/auth/google/callback`,
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const user = await store.findOrCreateUser({
              provider: "google",
              providerId: profile.id,
              email: profile.emails?.[0]?.value,
              name: profile.displayName,
              avatarUrl: profile.photos?.[0]?.value,
            });
            done(null, user);
          } catch (err) {
            done(err);
          }
        }
      )
    );
    app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
    app.get(
      "/auth/google/callback",
      passport.authenticate("google", { failureRedirect: "/?authError=google" }),
      (req, res) => res.redirect("/")
    );
  }

  // ---- Facebook ----
  if (cfg.facebook) {
    passport.use(
      new FacebookStrategy(
        {
          clientID: process.env.FACEBOOK_CLIENT_ID,
          clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
          callbackURL: `${APP_URL}/auth/facebook/callback`,
          profileFields: ["id", "displayName", "emails", "photos"],
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const user = await store.findOrCreateUser({
              provider: "facebook",
              providerId: profile.id,
              email: profile.emails?.[0]?.value,
              name: profile.displayName,
              avatarUrl: profile.photos?.[0]?.value,
            });
            done(null, user);
          } catch (err) {
            done(err);
          }
        }
      )
    );
    app.get("/auth/facebook", passport.authenticate("facebook", { scope: ["email"] }));
    app.get(
      "/auth/facebook/callback",
      passport.authenticate("facebook", { failureRedirect: "/?authError=facebook" }),
      (req, res) => res.redirect("/")
    );
  }

  // ---- Dev login (testing only) ----
  if (cfg.devLogin) {
    app.post("/auth/dev", async (req, res, next) => {
      const email = String(req.body?.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) {
        return res.status(400).json({ error: "Please provide a valid email." });
      }
      try {
        const name = req.body?.name?.trim() || email.split("@")[0];
        const user = await store.findOrCreateUser({
          provider: "dev",
          providerId: email,
          email,
          name,
          avatarUrl: null,
        });
        req.login(user, (err) => (err ? next(err) : res.json({ ok: true })));
      } catch (err) {
        next(err);
      }
    });
  }

  // ---- Logout ----
  app.post("/auth/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy(() => {
        res.clearCookie("connect.sid");
        res.json({ ok: true });
      });
    });
  });
}

export function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.status(401).json({ error: "Not authenticated" });
}
