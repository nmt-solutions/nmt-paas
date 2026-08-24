# NMT Deploy

NMT Deploy is a self-hosted PaaS for deploying GitHub repositories to Docker. It provides a GitHub-connected deployment workflow, automatic framework configuration, production domains, encrypted environment variables, and live build/runtime logs.

## Features

- GitHub App repository import with WorkOS authentication.
- Framework-aware defaults for Next.js, React, Vite, Node.js, Docker, and other projects.
- Background deployments using BullMQ, Redis, and Docker.
- Traefik routing with generated production domains and optional Cloudflare Tunnel exposure.
- Deployment history with status, branch, commit, timestamp, and log viewing.
- Live deployment-log refresh, streamed runtime logs, fullscreen logs, and redeploy actions.
- Encrypted application environment variables and clear redeploy prompts after configuration changes.

## Architecture

```text
Browser (Next.js / apps/web)
        │ tRPC + authenticated API routes
        ▼
PostgreSQL ◀── API service (apps/api) ──▶ Redis / BullMQ
   ▲                                            │
   │                                            ▼
   └──────── worker (apps/worker) ──▶ Docker ──▶ Traefik ──▶ deployed app
```

| Area | Location | Responsibility |
| --- | --- | --- |
| Web | `apps/web` | Next.js workspace, authentication, tRPC, app management, and logs |
| API | `apps/api` | Authenticated control-plane endpoints and deployment queueing |
| Worker | `apps/worker` | Repository cloning, Docker builds, deployment lifecycle, and log persistence |
| Database | `packages/database` | Drizzle schema, migrations, and data-access layer |
| Queue | `packages/queues` | BullMQ deployment queue |
| Docker operations | `packages/docker` | Compose definitions for Redis, worker, API, Traefik, and Cloudflare |

## Prerequisites

- Node.js 18+ and npm 11+
- Docker Engine with Docker Compose v2
- PostgreSQL database (Neon PostgreSQL is supported)
- Redis
- A GitHub App installation with repository read access
- WorkOS credentials

## Setup

1. Install dependencies.

   ```sh
   npm install
   ```

2. Create a root `.env` file. The Docker setup command copies it into the workspaces before starting services. Do not commit it.

3. Configure the required variables.

   | Variable | Purpose |
   | --- | --- |
   | `APP_ENV` | `development` or `production` |
   | `DB_ENV` | Selects `DEV_DATABASE_URL` or `PROD_DATABASE_URL` |
   | `DEV_DATABASE_URL` / `PROD_DATABASE_URL` | PostgreSQL connection strings |
   | `BASE_DOMAIN` | Base domain for generated application domains |
   | `ENV_ENCRYPTION_KEY` | Encrypts application environment values |
   | `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD` | WorkOS authentication |
   | `NEXT_PUBLIC_WORKOS_REDIRECT_URI` | WorkOS callback URL |
   | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` | GitHub App credentials |
   | `GITHUB_PAT`, `GITHUB_USER_NAME` | Container-registry publishing credentials |
   | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Redis connection |
   | `API_APP_PORT`, `API_KEY` | Control-plane API configuration |
   | `CLOUDFLARE_TUNNEL_TOKEN` | Cloudflare Tunnel token, when used |

4. Apply migrations.

   ```sh
   npm run db-mig --workspace=@repo/database
   ```

5. Start the web app locally.

   ```sh
   npm run dev --workspace=web
   ```

6. Start the control-plane services.

   ```sh
   npm run docker -- setup
   ```

   This starts Traefik, Redis, the worker, API, and Cloudflare Tunnel, creating `app-network` when necessary.

## Common commands

```sh
# Start all workspace development processes
npm run dev

# Build, lint, or type-check every workspace
npm run build
npm run lint
npm run check-types

# Generate or apply database migrations
npm run db-gen --workspace=@repo/database
npm run db-mig --workspace=@repo/database

# Run a Docker Compose command for every stack service
npm run docker -- ps
npm run docker -- down
```

## Deployment workflow

1. Sign in and connect the GitHub App installation.
2. Create a project and choose a repository and branch.
3. Review the detected framework preset; override build settings only when required.
4. Add production environment variables.
5. Deploy. The application opens the app details page and follows the new deployment logs.
6. Use the **Deployments** tab for previous releases. Select a release to open its logs; fullscreen logs are available from the log panel.
7. Use **Redeploy** to queue the same branch again. Saved environment or build changes require a new deployment, and the UI presents a **Redeploy now** action.

## Docker services

Compose definitions live in `packages/docker`:

- `traefik` — routes HTTP traffic to deployment containers.
- `redis` — BullMQ backing store with a persistent `redis-data` volume.
- `worker` — runs builds and deployments; requires Docker socket access.
- `api` — provides queue and runtime-log endpoints; requires Docker socket access.
- `cloudflare` — optional public tunnel.

## Destructive full reset

`npm run reset -- --force` is a destructive recovery command. It drops the selected database’s `public` schema, reapplies Drizzle migrations, then removes **all** Docker containers, images, volumes, custom networks, and build cache from the current Docker host.

```sh
npm run reset -- --force
```

It targets `DEV_DATABASE_URL` when `DB_ENV=development`. Production resets are blocked unless `ALLOW_PRODUCTION_RESET=true` is set explicitly. Run this only against a dedicated database and Docker host.

## Security and release checklist

- Never commit `.env` files, database URLs, API keys, GitHub keys, tokens, or `ENV_ENCRYPTION_KEY`.
- Protect the Docker socket and `API_KEY`; both can control deployment containers.
- Scope the GitHub App to the repositories the workspace should deploy.
- Verify the WorkOS callback URL, GitHub App callback, `BASE_DOMAIN`, database environment, and Cloudflare configuration before release.

```sh
npm run lint
npm run check-types
npm run build
```
