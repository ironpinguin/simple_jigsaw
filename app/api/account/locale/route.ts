import { NextResponse } from "next/server";
import { z } from "zod";
import { hasLocale } from "next-intl";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { routing } from "@/i18n/routing";
import { getErrorT } from "@/lib/i18n-server";

// Remembering which language to write to this user in. The header's language
// switcher calls this whenever a logged-in visitor picks a locale: switching
// already means "this is my language", so there is no second control for it and
// no separate setting to keep in step with the one they just used.
//
// What it is *for* is the mail nobody in the room triggered — an admin
// notification, a takedown notice. Those recipients are not the requester, so
// the request locale is the wrong answer and only the stored one is right.
//
// `routing.locales` is the validator rather than a union in lib/roles.ts: the
// const list already exists there, and a second copy would be a second source
// of truth for the same three values.
const Schema = z.object({ locale: z.string() });

export async function PUT(request: Request) {
  const t = await getErrorT();

  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  // The column is a plain String on both providers (no Prisma enums on SQLite),
  // so this check is the only thing standing between a hand-crafted request and
  // a row whose locale silently resolves to the default for good.
  if (!parsed.success || !hasLocale(routing.locales, parsed.data.locale)) {
    return NextResponse.json({ error: t("invalidRequest") }, { status: 400 });
  }

  try {
    await prisma.user.update({
      where: { id: session.id },
      data: { locale: parsed.data.locale },
    });
  } catch (error) {
    // The caller is a fire-and-forget fetch that ignores this response, so the
    // log is the only record. Without it "my notifications are still in German"
    // has nothing behind it — the page did switch, and looks entirely correct.
    console.error(`[account] storing locale ${parsed.data.locale} for ${session.id} failed:`, error);
    return NextResponse.json({ error: t("serverError") }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
