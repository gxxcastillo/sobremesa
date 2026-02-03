# Build stage
FROM oven/bun:1.3.6 AS builder

WORKDIR /app

# Copy the API app and its workspace dependencies
COPY apps/api ./apps/api
COPY libs/auth ./libs/auth
COPY libs/database ./libs/database
COPY libs/shared/types ./libs/shared/types
COPY libs/shared/utils ./libs/shared/utils

# Copy workspace configuration
COPY package.json bun.lock ./
COPY nx.json tsconfig.base.json ./

# Install dependencies
RUN bun install

# Build the API
WORKDIR /app/apps/api
RUN bun build src/main.ts --outdir dist --target bun --loader:.txt=text

# Production stage
FROM oven/bun:1.3.6-slim AS production

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
