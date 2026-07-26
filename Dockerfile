# Multi-stage build for the jigsaw app.
#
#   dev    – hot-reloading development server (used by docker-compose.override.yml)
#   build  – produces the optimized production build
#   runner – slim(ish) production image that runs `next start`
#
# Both dev and runner sync the Prisma schema with `prisma db push` on startup,
# so no separate migration step is required. The datasource provider is chosen
# via DATABASE_PROVIDER ("postgresql" default | "sqlite"); the build stage bakes
# the matching Prisma client, so pass it as a build arg for a SQLite image
# (docker-compose.sqlite.yml does this).

FROM node:22-alpine AS base
WORKDIR /app
# openssl + libc6-compat are needed by Prisma's query engine and by sharp on Alpine.
RUN apk add --no-cache libc6-compat openssl
ENV NEXT_TELEMETRY_DISABLED=1

# ---- dependencies ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---- development ----
FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
# Source is bind-mounted by compose; generate the client and sync the DB for the
# active provider, then start the dev server (exec so it receives signals).
CMD ["sh", "-c", "npm run db:generate && npm run db:push && exec npx next dev"]

# ---- production build ----
FROM base AS build
ARG DATABASE_PROVIDER=postgresql
ENV DATABASE_PROVIDER=$DATABASE_PROVIDER
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate the Prisma client for the chosen provider, then build (Next bundles
# the client, so build- and run-time providers must match).
RUN node scripts/prisma.mjs generate && npx next build

# ---- production runner ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/lib/generated ./lib/generated
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
EXPOSE 3000
# The client is already baked for the build-time provider; just sync the schema
# to the database for the active provider, then start.
CMD ["sh", "-c", "npm run db:push && exec npx next start"]
