# Build stage
FROM oven/bun:1.3.6 AS builder

WORKDIR /app

# Copy workspace config
COPY package.json bun.lock nx.json tsconfig.base.json ./

# Copy source
COPY apps/chatbots ./apps/chatbots
COPY libs ./libs

# Install dependencies
RUN bun install

# Build with sourcemaps
WORKDIR /app/apps/chatbots
RUN bun run build.ts

# Production stage
FROM oven/bun:1.3.6-slim AS production

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
