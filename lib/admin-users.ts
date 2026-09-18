// The two admin surfaces that list users — `GET /api/admin/users` and the
// server component behind `/admin/users` — need the same view of a row: the
// password hash never leaves the server, and `verified` and `hasPassword` are
// derived from the nullable columns.
//
// One function rather than the same expression written twice, because
// `hasPassword` stopped being cosmetic in #51: it gates the re-invite button,
// which mints a password-setting link. A copy that drifts to `false` offers an
// action the route then refuses with 409; one that drifts to `true` hides the
// button from a row that needs it, which is #33 back again for that row. See
// #52.

/** The nullable columns the view is derived from. */
export interface AdminUserSource {
  emailVerified: Date | null;
  passwordHash: string | null;
}

/**
 * Project a user row for an admin surface: drop `passwordHash` and
 * `emailVerified`, add the two booleans derived from them. Everything else on
 * the row is passed through untouched.
 *
 * `hasPassword: false` means "invitation never redeemed" — see the invariant
 * pinned in `lib/admin-users.test.ts`, which is what
 * `app/api/admin/users/invite/route.ts` relies on.
 */
export function toAdminUserView<T extends AdminUserSource>(
  user: T,
): Omit<T, "emailVerified" | "passwordHash"> & { verified: boolean; hasPassword: boolean } {
  const { emailVerified, passwordHash, ...rest } = user;
  return {
    ...rest,
    verified: emailVerified !== null,
    hasPassword: passwordHash !== null,
  };
}
