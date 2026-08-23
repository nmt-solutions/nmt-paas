FROM node:22-alpine AS base

WORKDIR /app

FROM base AS deps

COPY package.json package-lock.json turbo.json ./

COPY apps/api/package.json ./apps/api/package.json

COPY packages/api-sdk/package.json ./packages/api-sdk/package.json
COPY packages/queues/package.json ./packages/queues/package.json
COPY packages/redis/package.json ./packages/redis/package.json

COPY packages/eslint-config/package.json ./packages/eslint-config/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json

RUN npm ci

FROM base AS build

COPY --from=deps /app/node_modules ./node_modules

COPY package.json package-lock.json turbo.json ./

COPY apps/api ./apps/api

COPY packages/api-sdk ./packages/api-sdk
COPY packages/queues ./packages/queues
COPY packages/redis ./packages/redis

COPY packages/eslint-config ./packages/eslint-config
COPY packages/typescript-config ./packages/typescript-config

RUN npx turbo run build --filter=api

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json

COPY --from=build /app/packages/api-sdk/dist ./packages/api-sdk/dist
COPY --from=build /app/packages/api-sdk/package.json ./packages/api-sdk/package.json

COPY --from=build /app/packages/queues/dist ./packages/queues/dist
COPY --from=build /app/packages/queues/package.json ./packages/queues/package.json

COPY --from=build /app/packages/redis/dist ./packages/redis/dist
COPY --from=build /app/packages/redis/package.json ./packages/redis/package.json

COPY --from=build /app/node_modules ./node_modules

WORKDIR /app/apps/api

CMD ["node", "dist/index.js"]