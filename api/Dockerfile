FROM node:20-slim AS builder

WORKDIR /repo
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY api/package.json api/package.json

# важно: ставим deps именно для api
RUN pnpm install --frozen-lockfile --filter ./api...

COPY api ./api
RUN pnpm --filter ./api... build


FROM node:20-slim

WORKDIR /repo
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

# ✅ копируем И root, И api node_modules
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/api/node_modules ./api/node_modules

COPY --from=builder /repo/api/dist ./api/dist

WORKDIR /repo/api
CMD ["node", "dist/index.js"]