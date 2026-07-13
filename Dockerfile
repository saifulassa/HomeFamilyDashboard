FROM oven/bun:1 AS runtime
WORKDIR /app

# Copy package files and install deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src/ ./src/
COPY public/ ./public/

# Create data directory for SQLite persistence
RUN mkdir -p /app/data && chmod 777 /app/data

EXPOSE 3001

ENV PORT=3001
CMD ["bun", "run", "src/index.ts"]
