# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# `git` is required by lefthook/prepare postinstall scripts that run during pnpm install.
#
# **`python3 make g++` are for a fallback that could not run** (#773). `better-sqlite3` is a
# production dependency of the relay and its own install script is
# `prebuild-install || node-gyp rebuild --release`. Alpine ships none of node-gyp's toolchain, so
# the right-hand side could never execute: any time `prebuild-install` did not produce a binary the
# install failed, and the log named a missing Python rather than what actually went wrong.
#
# That is not hypothetical and it is not only about missing prebuilds. `prebuild-install` reports a
# failed *download* as "No prebuilt binaries found", so a network blip reads as an absent artifact —
# measured on one PR's arm64 leg while `main`'s leg fetched the same `linuxmusl-arm64` binary in
# 0.15s from the same base image digest. Re-running was enough there; a release is not the place to
# find that out.
#
# Removing the fallback instead was the other option and it is not available: that script belongs to
# the dependency. The cost of this one is builder-stage size and, when the fallback does fire, a
# source compile of a few minutes — so an unusually slow build here is worth reading as "the
# download failed" rather than as a mystery. The runtime stage is a fresh image that copies only
# `/app/out`, so the shipped image does not carry any of this.
RUN apk add --no-cache git python3 make g++

# Install pnpm
RUN npm install -g pnpm@9.15.1

# Copy workspace configuration and lockfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy all packages for building and workspace resolution
COPY packages ./packages
COPY playground/package.json ./playground/
COPY docs/package.json ./docs/

# Install dependencies across the entire monorepo
RUN pnpm install --frozen-lockfile

# Build required dependencies and the relay package itself.
# Dashboard is built so its static assets are placed in relay/public.
# protocol comes first: dashboard and relay both resolve its types from dist/, which does not
# exist in a clean checkout. This order has to match the root `build` script — they are two
# separate lists of the same graph, which is what #261 (topological build) would remove.
RUN pnpm --filter @tapflowio/protocol build
RUN pnpm --filter @tapflowio/agent-core build
RUN pnpm --filter @tapflowio/dashboard build
RUN pnpm --filter @tapflowio/relay build

# Extract the relay package and its production dependencies to an isolated folder
RUN pnpm deploy --filter @tapflowio/relay --prod /app/out

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /app

# Ensure the working directory is owned by the non-root 'node' user
RUN chown node:node /app

# Switch to the non-root user provided by node:alpine
USER node

# Copy the deployed application from the builder
COPY --from=builder --chown=node:node /app/out ./

# Create data directory as the node user for volume mount
RUN mkdir -p /app/.tapflow/data
VOLUME ["/app/.tapflow/data"]

# Set environment to production
ENV NODE_ENV=production

# The default port for relay
EXPOSE 4000

# Entry point for the relay server
CMD ["node", "dist/server.js"]
