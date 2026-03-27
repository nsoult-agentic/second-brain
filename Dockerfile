FROM oven/bun:1.3.10-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY tsconfig.json ./

# Non-root user for defense-in-depth
USER bun

EXPOSE 9098

# Auto-link ghcr.io package to repo
LABEL org.opencontainers.image.source=https://github.com/nsoult-agentic/second-brain

CMD ["bun", "run", "src/index.ts"]
