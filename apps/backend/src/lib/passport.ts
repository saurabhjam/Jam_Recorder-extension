import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';

import { config } from '../config';
import { getUserByGoogleId, getUserByEmail, createUser } from './users-table';

if (config.google.clientId && config.google.clientSecret) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.google.clientId,
        clientSecret: config.google.clientSecret,
        callbackURL: config.google.callbackUrl,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value ?? `${profile.id}@google-oauth.local`;
          const avatar = profile.photos?.[0]?.value ?? null;

          // 1. Try to find by Google ID first (fastest path after first login)
          let user = await getUserByGoogleId(profile.id);

          // 2. Fall back to email lookup (user may have registered manually first)
          if (!user) {
            user = await getUserByEmail(email);
          }

          // 3. Auto-provision on first Google sign-in
          if (!user) {
            user = await createUser({
              name: profile.displayName || email.split('@')[0]!,
              email,
              avatar: avatar ?? undefined,
              googleId: profile.id,
            });
          }

          return done(null, user);
        } catch (err) {
          return done(err as Error);
        }
      },
    ),
  );
}

export { passport };
