FROM node:20-slim AS builder

WORKDIR /repo
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY bot/package.json bot/package.json
COPY packages/db/package.json packages/db/package.json

# ставим deps для bot и db
RUN pnpm install --frozen-lockfile --filter @app/db... --filter ./bot...

COPY bot ./bot
COPY packages ./packages

# generate только на build (как ты и требовал)
RUN pnpm --filter @app/db db:generate

RUN pnpm --filter ./bot... build


FROM node:20-slim

WORKDIR /repo
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

# ✅ копируем root + bot + packages/db node_modules
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/bot/node_modules ./bot/node_modules
COPY --from=builder /repo/packages/db/node_modules ./packages/db/node_modules

COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/bot/dist ./bot/dist
COPY --from=builder /repo/bot/entrypoint.sh ./bot/entrypoint.sh

WORKDIR /repo/bot
RUN chmod +x ./entrypoint.sh
CMD ["./entrypoint.sh"]