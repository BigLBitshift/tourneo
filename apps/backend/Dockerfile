# syntax=docker/dockerfile:1
#
# Tourneo API — production image.
#
# Multi-stage so the runtime image carries compiled JavaScript and
# production dependencies only: no TypeScript, no test framework, no build
# toolchain to keep patched.
#
# The repo is an npm workspace, so both stages copy the root manifests and
# install from the root. Installing inside apps/backend alone would miss
# the hoisted dependency tree and the `overrides` block that pins
# transitive security fixes.

# ── deps ─────────────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/mobile/package.json apps/mobile/

# The mobile workspace is declared in the root manifest, so npm resolves it
# even for a backend-only build. --ignore-scripts keeps native postinstall
# steps (and Expo's) out of a server image.
RUN npm ci --ignore-scripts

# ── build ────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/backend ./apps/backend

RUN npm run build --workspace=apps/backend

# ── runtime ──────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# tini gives us a real PID 1 that forwards SIGTERM, which is what makes
# the graceful shutdown in src/index.ts actually run on deploy.
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Compiled output only. Migrations run via `npm run migrate:prod --workspace=apps/backend`,
# which points knex at dist/config/knexfile.js and dist/migrations — the
# TypeScript sources would need tsx, which is a devDependency and is
# deliberately absent from this image.
COPY --from=build /repo/apps/backend/dist ./apps/backend/dist

# Venue photos are written here. Mount a volume in production — container
# filesystems do not survive a redeploy.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

USER node
EXPOSE 3000

# Readiness, not liveness: this endpoint queries the database, so an
# instance with a dead connection is taken out of rotation instead of
# quietly serving 500s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/v1/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/backend/dist/index.js"]
