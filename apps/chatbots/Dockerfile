# Build stage
FROM oven/bun:1.3.14 AS builder

WORKDIR /app

# Copy workspace config
COPY package.json bun.lock nx.json tsconfig.base.json ./

# Copy source
COPY apps/chatbots ./apps/chatbots
COPY libs ./libs

# bun install --frozen-lockfile validates the lockfile against every workspace
# member declared by the root package.json's globs, so sibling apps not built
# here still need their manifest present (source not needed, not copied).
COPY apps/api/package.json ./apps/api/package.json
COPY apps/studio/package.json ./apps/studio/package.json
COPY apps/db/package.json ./apps/db/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/eval/package.json ./apps/eval/package.json
COPY tests/package.json ./tests/package.json

# Install dependencies
RUN bun install --frozen-lockfile

# Build with sourcemaps
WORKDIR /app/apps/chatbots
RUN bun run build.ts

# Production stage
FROM oven/bun:1.3.14-slim AS production

WORKDIR /app

# Copy built output and sourcemap
COPY --from=builder /app/apps/chatbots/dist/main.js ./main.js
COPY --from=builder /app/apps/chatbots/dist/main.js.map ./main.js.map

# Set environment
ENV NODE_ENV=production

# No EXPOSE - chatbots uses outbound Telegram polling, not HTTP
# No HEALTHCHECK - not an HTTP service

# Run the bundled app
CMD ["bun", "run", "main.js"]
