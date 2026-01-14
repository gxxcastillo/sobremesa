# Build stage
FROM oven/bun:1.3.6 AS builder

WORKDIR /app

# Copy the chatbots app and its workspace dependencies
COPY apps/chatbots ./apps/chatbots
COPY libs/database ./libs/database
COPY libs/shared/types ./libs/shared/types
COPY libs/shared/utils ./libs/shared/utils
COPY libs/queue ./libs/queue
COPY libs/telegram ./libs/telegram
COPY libs/agents ./libs/agents
COPY libs/ingester ./libs/ingester

# Copy workspace configuration
COPY package.json bun.lock ./
COPY nx.json tsconfig.base.json ./

# Install dependencies
RUN bun install

# Build the chatbots app
WORKDIR /app/apps/chatbots
RUN bun build src/main.ts --outdir dist --target bun --minify

# Production stage
FROM oven/bun:1.3.6-slim AS production

WORKDIR /app

# Copy built output
COPY --from=builder /app/apps/chatbots/dist/main.js ./main.js

# Set environment
ENV NODE_ENV=production

# No EXPOSE - chatbots uses outbound Telegram polling, not HTTP
# No HEALTHCHECK - not an HTTP service

# Run the bundled app
CMD ["bun", "run", "main.js"]
