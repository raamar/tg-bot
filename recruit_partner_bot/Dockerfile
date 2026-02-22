FROM node:20-slim AS builder

WORKDIR /repo
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY recruit_partner_bot/package.json recruit_partner_bot/package.json
COPY packages/db/package.json packages/db/package.json

RUN pnpm install --frozen-lockfile --filter @app/db... --filter ./recruit_partner_bot...

COPY recruit_partner_bot ./recruit_partner_bot
COPY packages ./packages

RUN pnpm --filter @app/db db:generate
RUN pnpm --filter ./recruit_partner_bot... build


FROM node:20-slim

WORKDIR /repo
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/recruit_partner_bot/node_modules ./recruit_partner_bot/node_modules
COPY --from=builder /repo/packages/db/node_modules ./packages/db/node_modules

COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/recruit_partner_bot/dist ./recruit_partner_bot/dist
COPY --from=builder /repo/recruit_partner_bot/entrypoint.sh ./recruit_partner_bot/entrypoint.sh

WORKDIR /repo/recruit_partner_bot
RUN chmod +x ./entrypoint.sh
CMD ["./entrypoint.sh"]