// Auth.js (NextAuth v5) configuration. Email/password credentials with JWT
// sessions (credentials providers require the JWT strategy, so no database
// session/adapter tables are needed — we look the user up directly).

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./db";
import { checkEmailBanned } from "./moderation";
import { isAdminEmail } from "./admin-emails";
import { toViewer } from "./visibility";
import { isSessionStale } from "./session-freshness";

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
      // This costs a user lookup per session resolution. Accepted: most
      // protected routes already make one through getSessionUser, and a
      // "log out other devices" guarantee that is only sometimes enforced is
      // not a guarantee.
      if (!token.id) return token;
      const row = await prisma.user.findUnique({
        where: { id: token.id as string },
        select: { passwordChangedAt: true },
      });
      if (!row) return null;
      return isSessionStale(token.iat, row.passwordChangedAt) ? null : token;
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
 */
export async function getSessionUser() {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  return prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true },
  });
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
