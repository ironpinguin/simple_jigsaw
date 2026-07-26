// The role/type "enum" values, kept as string unions in app code because the
// database columns are plain strings (Prisma enums are not supported on SQLite,
// and we want one schema that runs on both PostgreSQL and SQLite).

export const ROLES = ["USER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const TOKEN_TYPES = ["EMAIL_VERIFY", "INVITE"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

export const BAN_TYPES = ["EMAIL", "DOMAIN"] as const;
export type BanType = (typeof BAN_TYPES)[number];
