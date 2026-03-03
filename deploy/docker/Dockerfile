FROM oven/bun:1-alpine AS build
WORKDIR /app

# Install deps
COPY package.json bun.lockb* ./
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/vector/package.json ./packages/vector/
COPY packages/pipeline/package.json ./packages/pipeline/
COPY packages/truth/package.json ./packages/truth/
COPY packages/registry/package.json ./packages/registry/
COPY packages/server/package.json ./packages/server/
RUN bun install --frozen-lockfile

# Copy source
COPY packages/ ./packages/
COPY tsconfig.json ./

# Compile to single binary
RUN bun build packages/server/src/index.ts \
  --outfile dist/locigram \
  --target bun \
  --compile \
  --minify

# ── Runtime image ─────────────────────────────────────────────────────────────
FROM debian:bookworm-slim
WORKDIR /app

COPY --from=build /app/dist/index ./locigram

RUN chmod +x ./locigram

EXPOSE 3000

ENTRYPOINT ["./locigram"]
