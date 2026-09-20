// Auth.js (NextAuth v5) configuration. Email/password credentials with JWT
// sessions (credentials providers require the JWT strategy, so no database
// session/adapter tables are needed — we look the user up directly).

import { cache } from "react";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./db";
import { checkEmailBanned } from "./moderation";
import { isAdminEmail } from "./admin-emails";
import { toViewer } from "./visibility";
import { isSessionStale } from "./session-freshness";
import { resolveRequestLocale } from "./i18n-server";
import { routing } from "@/i18n/routing";

/**
 * The one user read a page render needs, memoized for its length.
 *
 * auth() is not request-cached in next-auth 5 beta, so every call re-runs the
 * jwt callback below, and a render calls auth() more than once — the locale
 * layout and the page each do, and getSessionUser() does again before its own
 * query. Sharing one read between the freshness check and getSessionUser
 * collapses those: measured on /de/my, three user-row reads became one.
 *
 * **Only for React renders.** React.cache stores on the RSC flight request, and
 * Next's route-handler runtime establishes no such scope, so in `app/api/**`
 * every call gets a fresh cache and still pays its own query — two reads for a
 * route that calls getSessionUser, as before. That is most of this app's
 * auth() calls, `/api/image/[...key]` per gallery thumbnail included. Making
 * those one read too would mean memoizing on something request-scoped that
 * route handlers also have, which is a bigger change than this.
 *
 * React.cache keys on the argument, so two different users in one render still
 * get their own row.
 */
const readSessionUser = cache(async (id: string) =>
  prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, passwordChangedAt: true },
  }),
);

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "E-Mail", type: "email" },
        password: { label: "Passwort", type: "password" },
      },
      authorize: async (creds) => {
        const email = String(creds?.email ?? "")
          .toLowerCase()
          .trim();
        const password = String(creds?.password ?? "");
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        // No user, or an invited account that has not set a password yet.
        if (!user || !user.passwordHash) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

        // Banned addresses/domains cannot log in, even with a valid password.
        if (await checkEmailBanned(email)) return null;

        // Email must be confirmed first.
        if (!user.emailVerified) return null;

        // Keep the ADMIN allow-list authoritative on every login.
        let role = user.role;
        if (isAdminEmail(email) && role !== "ADMIN") {
          await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
          role = "ADMIN";
        }

        // First sight of this person's own language, for accounts nobody ever
        // established one for: every row predating the column, and every
        // account an admin created outright (there is no activation step in
        // that path to observe them at). They navigated to the login page
        // themselves, so unlike an invite link the URL and cookie are their
        // own choice and resolveRequestLocale is the right reader.
        //
        // Only when it is null. A row that already holds a language holds one
        // somebody chose — at signup, at invite activation, or with the
        // switcher — and signing in from a differently configured machine must
        // not silently undo that. Skipping the default keeps the write off the
        // common path, where storing "de" changes nothing any reader does.
        if (user.locale === null) {
          try {
            const locale = await resolveRequestLocale();
            if (locale !== routing.defaultLocale) {
              await prisma.user.update({ where: { id: user.id }, data: { locale } });
            }
          } catch (error) {
            // Nobody asked for this write, so it must never be what stops a
            // login. The account simply keeps falling back to the default and
            // the next sign-in tries again.
            console.error(`[auth] storing the sign-in locale for user ${user.id} failed:`, error);
          }
        }

        return { id: user.id, email: user.email, name: user.name ?? null, role };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role?: string }).role ?? "USER";
        return token;
      }

      // Every later call. Sessions are stateless JWTs, so a cookie taken before
      // a password change would otherwise keep working until it expired — which
      // is the whole reason this feature stamps passwordChangedAt. Returning
      // null ends the session.
      //
      // This costs a user lookup. In a page render it is not an extra one:
      // readSessionUser above is the same memoized read getSessionUser makes,
      // so a render that already resolved its user pays nothing. In a route
      // handler, where that memo does not apply, it is a second query per
      // auth() call. Accepted either way — a
      // "log out other devices" guarantee that is only sometimes enforced is
      // not a guarantee. If the lookup itself throws (the database is
      // unreachable), @auth/core catches it and clears the session cookie the
      // same as a stale token would — a transient outage signs the user out
      // rather than risk serving a page on an unverified session, which is the
      // direction we want it to fail.
      //
      // A token with no id cannot be checked against anything, so it is
      // refused rather than trusted.
      if (!token.id) return null;
      const row = await readSessionUser(token.id as string);
      if (!row) return null;
      if (isSessionStale(token.iat, row.passwordChangedAt)) return null;
      // The row is already here, so take the role from it rather than leaving
      // the claim frozen at sign-in: a demoted admin otherwise keeps the Admin
      // link in the nav (app/[locale]/layout.tsx) until the token expires.
      // getSessionViewer has always read the role from the database for the
      // same reason; this brings the JWT claim into line with it, free.
      token.role = row.role;
      return token;
    },
    session({ session, token }) {
      if (token.id && session.user) {
        session.user.id = token.id as string;
        session.user.role = (token.role as string) ?? "USER";
      }
      return session;
    },
  },
});

/**
 * Resolve the current user from the JWT session AND confirm it still exists in
 * the database. Sessions are stateless (JWT), so a cookie can outlive its user
 * (e.g. after the DB was reset). Returns null in that case so protected routes
 * can respond with 401 instead of failing later on a foreign-key violation.
 *
 * Inside a React render the row is read once and reused (readSessionUser), so
 * this answers from whatever that first read saw — per render, not per call.
 * Code that mutates a user and then re-checks it in the same render would read
 * the pre-mutation row; nothing does that today, and a route handler gets a
 * fresh read per call in any case.
 */
export async function getSessionUser() {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await readSessionUser(id);
  // Narrowed back to the three fields callers have always had: passwordChangedAt
  // is read for the freshness check only and must not start appearing in the
  // API responses that hand this object straight back.
  return user && { id: user.id, email: user.email, role: user.role };
}

/** Like getSessionUser, but returns null unless the user is an ADMIN. */
export async function requireAdmin() {
  const user = await getSessionUser();
  // Role via toViewer so the string column is validated at one boundary only.
  return user && toViewer(user)?.role === "ADMIN" ? user : null;
}

/**
 * The current user as a Viewer for visibility checks. Deliberately built on
 * getSessionUser, not the raw session: the role must come from the database,
 * not the JWT claim, so a demoted admin loses private-puzzle access with the
 * demotion instead of when their token expires.
 */
export async function getSessionViewer() {
  return toViewer(await getSessionUser());
}
