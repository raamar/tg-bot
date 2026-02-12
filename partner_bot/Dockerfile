FROM node:20-slim AS builder

WORKDIR /repo
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY partner_bot/package.json partner_bot/package.json
COPY packages/db/package.json packages/db/package.json

RUN pnpm install --frozen-lockfile --filter @app/db... --filter ./partner_bot...

COPY partner_bot ./partner_bot
COPY packages ./packages

RUN pnpm --filter @app/db db:generate
RUN pnpm --filter ./partner_bot... build


FROM node:20-slim

WORKDIR /repo
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/partner_bot/node_modules ./partner_bot/node_modules
COPY --from=builder /repo/packages/db/node_modules ./packages/db/node_modules

COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/partner_bot/dist ./partner_bot/dist
COPY --from=builder /repo/partner_bot/entrypoint.sh ./partner_bot/entrypoint.sh

WORKDIR /repo/partner_bot
RUN chmod +x ./entrypoint.sh
CMD ["./entrypoint.sh"]