FROM node:20-alpine AS build

RUN corepack enable

WORKDIR /repo

ARG PUBLIC_DOMAIN
ENV PUBLIC_DOMAIN=${PUBLIC_DOMAIN}

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY distribution/package.json distribution/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/db ./packages/db

RUN pnpm install --frozen-lockfile --filter @app/db... --filter ./distribution...

COPY distribution ./distribution

RUN pnpm --filter @app/db db:generate

WORKDIR /repo/distribution
ENV NODE_ENV=production
RUN pnpm build

FROM node:20-alpine AS runner

RUN corepack enable
WORKDIR /repo

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY distribution/package.json distribution/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/db ./packages/db

RUN pnpm install --frozen-lockfile --prod --filter @app/db... --filter ./distribution...

COPY --from=build /repo/distribution/build ./distribution/build
COPY --from=build /repo/distribution/entrypoint.sh ./distribution/entrypoint.sh

WORKDIR /repo/distribution
RUN chmod +x ./entrypoint.sh

CMD ["./entrypoint.sh"]
