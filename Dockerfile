# Multi-stage build for the jigsaw app.
#
#   dev    – hot-reloading development server (used by docker-compose.override.yml)
#   build  – produces the optimized production build
#   runner – slim(ish) production image that runs `next start`
#
# Both dev and runner sync the Prisma schema with `prisma db push` on startup,
# so no separate migration step is required. One image serves both databases:
# the build generates a Prisma client for each provider, and DATABASE_PROVIDER
# ("postgresql" default | "sqlite") picks one at container start — for the
# schema sync and for the app (lib/db.ts). It is not a build arg any more.

FROM node:26-alpine AS base
WORKDIR /app
# openssl + libc6-compat are needed by Prisma's query engine and by sharp on Alpine.
RUN apk add --no-cache libc6-compat openssl
ENV NEXT_TELEMETRY_DISABLED=1

# ---- dependencies ----
FROM base AS deps
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# postinstall generates both Prisma clients through this script.
COPY scripts/prisma.mjs ./scripts/prisma.mjs
RUN npm ci

# ---- NSFW model ----
# Not committed to git (see lib/nsfw/local.ts) — fetched here and baked into
# the runner image instead, pinned to the exact commit the design's spike
# verified, with the sha256 checked so an upstream change to the file can't
# silently change what ships. node:26-alpine already carries busybox wget
# (the compose healthcheck uses it too), so no extra package is needed.
FROM base AS model
RUN wget -q -O /tmp/nsfw.onnx \
      "https://huggingface.co/OwenElliott/image-safety-classifier-xs/resolve/54f4560bd9c5ee92d45dc30418a8f8680e80de6d/onnx/image-safety-classifier-xs.onnx" \
    && echo "8c28c49d9075f3ad15ebdc2961f02d5b3f99be944815b848b49c9f0e6f3fb689  /tmp/nsfw.onnx" | sha256sum -c - \
    && mkdir -p /app/models \
    && mv /tmp/nsfw.onnx /app/models/nsfw.onnx

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
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate both Prisma clients, then build. Next bundles both; lib/db.ts
# constructs only the one DATABASE_PROVIDER names at runtime.
#
# .next/cache is the build's own cache — turbopack's, roughly 180 MB — and
# nothing at runtime reads it; the runner would otherwise ship it. Next creates
# the directory again if it needs one (the image optimiser's cache).
RUN node scripts/prisma.mjs generate && npx next build && rm -rf .next/cache

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
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY --from=model /app/models ./models
EXPOSE 3000
# Both clients are already generated; sync the schema to the database for the
# provider this container is started with, then start.
CMD ["sh", "-c", "npm run db:push && exec npx next start"]
