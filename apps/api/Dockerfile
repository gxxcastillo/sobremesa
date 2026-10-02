# Build stage
FROM oven/bun:1.3.14 AS builder

WORKDIR /app

# Copy the API app and its workspace dependencies
COPY apps/api ./apps/api
COPY libs ./libs

# bun install --frozen-lockfile validates the lockfile against every workspace
# member declared by the root package.json's globs, so sibling apps not built
# here still need their manifest present (source not needed, not copied).
COPY apps/chatbots/package.json ./apps/chatbots/package.json
COPY apps/studio/package.json ./apps/studio/package.json
COPY apps/db/package.json ./apps/db/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/eval/package.json ./apps/eval/package.json
COPY tests/package.json ./tests/package.json

# Copy workspace configuration
COPY package.json bun.lock ./
COPY nx.json tsconfig.base.json ./

# Install dependencies
RUN bun install --frozen-lockfile

# Build the API
WORKDIR /app/apps/api
RUN bun build src/main.ts --outdir dist --target bun --loader:.txt=text

# Production stage
FROM oven/bun:1.3.14-slim AS production

WORKDIR /app

# Copy built output
COPY --from=builder /app/apps/api/dist/main.js ./main.js

# Set environment
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

# Run the bundled app
CMD ["bun", "run", "main.js"]
