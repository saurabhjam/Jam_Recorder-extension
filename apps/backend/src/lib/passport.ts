import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { prisma } from './prisma';
import { config } from '../config';

// Only register Google strategy when real credentials are provided
if (config.google.clientId && config.google.clientSecret) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.google.clientId,
        clientSecret: config.google.clientSecret,
        callbackURL: config.google.callbackUrl,
        scope: ['profile', 'email'],
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) {
            return done(new Error('No email from Google profile'), undefined);
          }

          // Upsert user: find by googleId or email, create if not exists
          let user = await prisma.user.findFirst({
            where: {
              OR: [{ googleId: profile.id }, { email }],
            },
          });

          if (user) {
            // Update googleId if not set (linking existing account)
            if (!user.googleId) {
              user = await prisma.user.update({
                where: { id: user.id },
                data: {
                  googleId: profile.id,
                  avatar: user.avatar ?? profile.photos?.[0]?.value,
                  isVerified: true,
                },
              });
            }
          } else {
            user = await prisma.user.create({
              data: {
                email,
                name: profile.displayName ?? email.split('@')[0],
                password: '', // no password for OAuth users
                avatar: profile.photos?.[0]?.value,
                googleId: profile.id,
                isVerified: true,
              },
            });
          }

          return done(null, user);
        } catch (err) {
          return done(err as Error, undefined);
        }
      },
    ),
  );
}

export { passport };
