FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY tsconfig.json ./

# Non-root user for defense-in-depth
USER bun

EXPOSE 9098

CMD ["bun", "run", "src/index.ts"]
