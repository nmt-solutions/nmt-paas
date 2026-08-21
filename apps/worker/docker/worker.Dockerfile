FROM node:22-alpine AS base

WORKDIR /app

FROM base AS deps

COPY package.json package-lock.json turbo.json ./

COPY apps/worker/package.json ./apps/worker/package.json

COPY packages/database/package.json ./packages/database/package.json
COPY packages/redis/package.json ./packages/redis/package.json
COPY packages/eslint-config/package.json ./packages/eslint-config/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json

RUN npm ci

FROM base AS build

COPY --from=deps /app/node_modules ./node_modules

COPY package.json package-lock.json turbo.json ./

COPY apps/worker ./apps/worker

COPY packages/database ./packages/database
COPY packages/redis ./packages/redis
COPY packages/eslint-config ./packages/eslint-config
COPY packages/typescript-config ./packages/typescript-config

RUN npx turbo run build --filter=worker

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json

COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/database/package.json ./packages/database/package.json

COPY --from=build /app/packages/redis/dist ./packages/redis/dist
COPY --from=build /app/packages/redis/package.json ./packages/redis/package.json

COPY --from=build /app/node_modules ./node_modules

WORKDIR /app/apps/worker

CMD ["node", "dist/index.js"]