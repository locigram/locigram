FROM oven/bun:1-alpine
WORKDIR /app

# Copy root workspace manifest
COPY package.json ./

# Copy all package manifests (workspace resolution needs them all)
COPY packages/core/package.json        ./packages/core/
COPY packages/db/package.json          ./packages/db/
COPY packages/vector/package.json      ./packages/vector/
COPY packages/pipeline/package.json    ./packages/pipeline/
COPY packages/truth/package.json       ./packages/truth/
COPY packages/registry/package.json   ./packages/registry/
COPY packages/server/package.json      ./packages/server/
COPY packages/connectors/webhook/package.json       ./packages/connectors/webhook/
COPY packages/connectors/microsoft365/package.json  ./packages/connectors/microsoft365/
COPY packages/connectors/halopsa/package.json       ./packages/connectors/halopsa/
COPY packages/connectors/ninjaone/package.json      ./packages/connectors/ninjaone/
COPY packages/connectors/gmail/package.json         ./packages/connectors/gmail/
COPY packages/connectors/qbo/package.json           ./packages/connectors/qbo/
COPY packages/connectors/surudb/package.json        ./packages/connectors/surudb/
COPY packages/connectors/email/package.json         ./packages/connectors/email/
COPY packages/connectors/sms/package.json              ./packages/connectors/sms/
COPY packages/connectors/session-monitor/package.json  ./packages/connectors/session-monitor/


# Install deps (workspace-aware)
RUN bun install

# Copy all source
COPY packages/ ./packages/
COPY tsconfig.json ./

EXPOSE 3000

CMD ["bun", "run", "packages/server/src/index.ts"]
