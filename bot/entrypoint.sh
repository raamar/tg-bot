#!/bin/sh
echo "➡️ Generating Prisma client..."
pnpm db:generate

echo "➡️ Applying DB migrations..."
pnpm db:deploy

echo "➡️ Starting bot..."
node dist/worker.js
