# NMT Deploy architecture

Reviewed on 2026-11-05 against commit `d3b6f23` and the working tree. This is a reference for navigating and changing the repository. It describes the implementation found in source; infrastructure availability and deployment health were not checked.

## Start here

NMT Deploy is a self-hosted PaaS that imports GitHub repositories, builds them in Docker, and routes requests to deployment containers. The Next.js application owns user workflows and most database access. A control-plane HTTP interface queues deployments and exposes Docker operations. A separate TypeScript worker executes deployments.

**The Docker service named `api` currently runs the Go node manager.** The Express application in `apps/api` implements the same HTTP interface and remains available through npm development commands, but its Dockerfile is not selected by the active Compose definition. See [control-plane implementations](#control-plane-implementations) before changing either.

Use the [change map](#change-map) to find the relevant files. Source files and manifests take precedence when they diverge from this reference or the root README.

## Repository map

| Location                                                                                                                               | Responsibility and entry points                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/web`](../apps/web/package.json)                                                                                                 | Next.js 16.2.6 / React 19.2.4 application; pages, WorkOS authentication, tRPC procedures, GitHub integration, and deployment orchestration.           |
| [`apps/node-manager`](../apps/node-manager/main.go)                                                                                    | Go / Gin implementation of the control-plane HTTP interface; direct Redis and Docker Engine communication. Built by the active `api` Compose service. |
| [`apps/api`](../apps/api/src/index.ts)                                                                                                 | Express implementation of the control-plane HTTP interface; uses `@repo/queues` and Dockerode.                                                        |
| [`apps/worker`](../apps/worker/src/index.ts)                                                                                           | BullMQ consumer; imports the active [`deployment.worker.ts`](../apps/worker/src/workers/deployment.worker.ts).                                        |
| [`packages/database`](../packages/database/package.json)                                                                               | PostgreSQL pool, Drizzle schema and relations, migrations, and data-access functions.                                                                 |
| [`packages/api-sdk`](../packages/api-sdk/src/client.ts)                                                                                | Server-side `ControlPanelAPIClient`, response types, and queue-request validation schema.                                                             |
| [`packages/queues`](../packages/queues/src/index.ts)                                                                                   | TypeScript producer for `deployment-queue`, including job retry and retention options.                                                                |
| [`packages/redis`](../packages/redis/src/index.ts)                                                                                     | Shared IORedis connection used by the TypeScript queue producer and worker.                                                                           |
| [`packages/docker`](../packages/docker)                                                                                                | Separate Compose projects for Traefik, Redis, worker, API, and Cloudflare Tunnel. This directory has no npm package manifest.                         |
| [`packages/typescript-config`](../packages/typescript-config/base.json), [`packages/eslint-config`](../packages/eslint-config/base.js) | Shared compiler and lint configuration.                                                                                                               |
| [`scripts`](../scripts)                                                                                                                | Environment-file copying, Docker orchestration, and destructive reset tooling.                                                                        |
| [`.agents/skills`](../.agents/skills), [`skills-lock.json`](../skills-lock.json)                                                       | Project-local agent skills and their source lock; separate from application runtime dependencies.                                                     |

The root [package manifest](../package.json) defines npm workspaces under `apps/*` and `packages/*`, with Turborepo task orchestration in [`turbo.json`](../turbo.json). The Go application has a `go.mod` rather than a `package.json`, so npm and Turbo tasks do not build or start it.

## Runtime topology

```text
Browser
  | WorkOS session; tRPC queries/mutations; runtime-log stream
  v
Next.js web process ----------------------> WorkOS / GitHub App APIs
  |                     |
  | Drizzle / pg        | ControlPanelAPIClient, Bearer API_KEY
  v                     v
PostgreSQL        /api/v1 control-plane interface
  ^                Go node manager in Compose
  |                Express app in npm dev mode
  |                     |                 |
  |                     | queue           | admin operations / live logs
  |                     v                 v
  |                Redis / BullMQ     Docker Engine
  |                     |                 ^
  +------ TypeScript deployment worker ---+
                          |               |
                          v               v
                     GitHub clone     builder container
                                          |
                                    committed image --> GHCR push
                                          |
                                    deployment container
                                          ^
                                          |
Public traffic --> Cloudflare Tunnel* --> Traefik :80

* Tunnel ingress configuration is external to this repository.
```

PostgreSQL is external to the supplied Compose projects. The web application also runs separately; there is no web Compose definition. The supplied containers and deployed applications share the external Docker network `app-network`. The API process and worker access the same Docker daemon through its socket; there is no node registry, host scheduler, or remote-worker selection in the implementation.

## Web module

### Routes and presentation

The route tree is under [`apps/web/src/app`](../apps/web/src/app). [`routes.ts`](../apps/web/src/routes.ts) supplies route metadata for navigation and authentication, while [`app-sidebar-provider.tsx`](../apps/web/src/providers/app-sidebar-provider.tsx) selects the console shell.

| Route                                | Main behavior                                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                  | Public landing page with session-aware sign-in or console links.                                                                                                                                                     |
| `/dashboard`                         | Derives app totals and deployment success counts from `project.list`. Its availability percentage is a deployment success ratio.                                                                                     |
| `/projects`                          | Lists the user's projects and applications; supports project deletion.                                                                                                                                               |
| `/projects/new`                      | Checks GitHub connectivity and lists repositories with search and client-side pagination.                                                                                                                            |
| `/projects/new/import/[repoId]`      | Loads repository details and a framework preset; collects command overrides and initial environment values.                                                                                                          |
| `/projects/[projectId]/apps/[appId]` | Application details, configuration, environment keys, deployment history, logs, redeploy, and app deletion. Data lookup uses `appId` and the authenticated user; the route's `projectId` is not a lookup constraint. |
| `/connect/github`                    | Consumes GitHub's `installation_id` and `state` callback parameters.                                                                                                                                                 |
| `/admin`                             | Host metrics and Docker inventory/deletion through procedures requiring the `admin` permission.                                                                                                                      |

The active application-detail implementation is [`components/apps/app-details.tsx`](../apps/web/src/components/apps/app-details.tsx); import behavior lives in [`components/repositories/import-repository.tsx`](../apps/web/src/components/repositories/import-repository.tsx). UI primitives live in `components/ui`, with Tailwind CSS 4 theme tokens in [`globals.css`](../apps/web/src/app/globals.css), Radix primitives, Sonner notifications, and `next-themes`. [`components.json`](../apps/web/components.json) records the shadcn configuration. `next.config.ts` enables the React compiler.

The chart, section-card, and data-table examples under `components/charts`, `components/cards`, and `components/table` are not wired into the current dashboard. Empty `services/apps.ts`, `services/deployment.ts`, and `services/framework.ts` are placeholders; active orchestration lives elsewhere.

### Request flow and authentication

Client components use `useTRPC()` with TanStack Query. [`trpc/client.tsx`](../apps/web/src/trpc/client.tsx) batches calls to `/api/trpc` and uses SuperJSON. [`trpc/routers/_app.ts`](../apps/web/src/trpc/routers/_app.ts) mounts the `github`, `git`, `framework`, `deployment`, `app`, `project`, and `admin` routers. Routers validate inputs with Zod and call web functions or database access functions directly.

[`trpc/server.tsx`](../apps/web/src/trpc/server.tsx) also provides a server caller, prefetching, and hydration helpers. The main console screens currently fetch through client-side queries. The shared query client defaults to a 30-second stale time; application details explicitly poll every 2.5 seconds, and the admin page refreshes host metrics every 3 seconds.

WorkOS AuthKit owns user identity and sessions. [`proxy.ts`](../apps/web/src/proxy.ts) applies route authentication, [`api/auth/login`](../apps/web/src/app/api/auth/login/route.ts) redirects to WorkOS, and [`api/auth/callback`](../apps/web/src/app/api/auth/callback/route.ts) handles the return. No local user table is defined; domain rows carry WorkOS user IDs as strings.

`/api/trpc` is explicitly allowed through the authentication proxy, so its procedure checks are part of the access-control interface. [`trpc/init.ts`](../apps/web/src/trpc/init.ts) obtains `userInfo` from `withAuth()`. Its `authenticatedProcedure` currently checks the `userInfo` object, while downstream procedures access `userInfo.user.id`; it does not explicitly check `userInfo.user`. `authorizedProdcedure` additionally checks `userInfo.permissions` for the requested permission. Application operations use `requireApp()` in [`app.trpc.ts`](../apps/web/src/trpc/routers/app.trpc.ts) to load an active, owner-scoped app.

Data-access functions have different scoping rules. For example, `getUserApp()` checks app ID, creator, and active status; `getDeployment()` only checks deployment ID and active status. Authorization is therefore a caller responsibility wherever the query itself is not user-scoped. The control-plane interface trusts its shared bearer key and does not authenticate WorkOS users.

## Persistence and domain model

[`schema.ts`](../packages/database/src/schema.ts) exports table definitions and enums; [`relations.ts`](../packages/database/src/relations.ts) defines Drizzle relational reads. [`access-layer`](../packages/database/src/access-layer) contains data-access functions, exposed through package subpath exports.

| Table                    | Meaning and relationships                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GithubAppInstallations` | Connects a user to a GitHub App installation; contains an installation ID and `started` / `completed` state.                                                          |
| `Projects`               | User-owned grouping of apps and environment values.                                                                                                                   |
| `Apps`                   | A repository-backed application belonging to a project; stores mutable `appName`, repository ID, and Git provider.                                                    |
| `AppDomains`             | App hostnames for `production` and `preview`; domain strings have a uniqueness constraint.                                                                            |
| `FrameworkConfig`        | Commands, root/output directories, framework name, and port for an app. Drizzle reads it as one-to-one, although `appId` has no foreign-key or uniqueness constraint. |
| `Deployments`            | A release attempt containing app/repository IDs, branch, exact commit SHA, environment, user, and status.                                                             |
| `DeploymentLogs`         | Persisted messages belonging to a deployment.                                                                                                                         |
| `EnvVars`                | Encrypted values keyed by project and environment. App settings manage these through the app's project. There is no unique constraint on project/environment/key.     |

Projects can contain multiple apps in the schema, but the initial import flow creates a new project for each app. Domain creation inserts a production hostname and a preview hostname, adding a readable random suffix on a name collision. Both environments are represented in the schema; current deployment creation always chooses `production`. GitHub is the implemented provider even though the database enum also includes `bitbucket`.

Tables carry audit columns and `resourceStatus: active | inactive`. Deletion generally updates this status. Relational includes do not uniformly filter inactive child rows, so a parent query's active filter is not a guarantee that every returned child is active.

The runtime pool in [`src/index.ts`](../packages/database/src/index.ts) **always connects to `DEV_DATABASE_URL`**. [`drizzle.config.ts`](../packages/database/drizzle.config.ts) selects the migration database and output directory using `DB_ENV`. Consequently, setting `DB_ENV=production` changes migration targeting but does not change the runtime pool. The checked-in migration is under [`database/development`](../packages/database/database/development); there is no checked-in production migration directory in this snapshot.

## GitHub integration and deployment requests

### Connect and inspect repositories

[`github.trpc.ts`](../apps/web/src/trpc/routers/github.trpc.ts) creates an installation row and redirects to the configured GitHub App with that row's ID in `state`. The callback verifies that the supplied installation can be accessed with the App credentials and writes its installation ID. It currently updates by the supplied row ID without an ownership predicate, and does not change the installation's `state` field to `completed`.

[`services/github.ts`](../apps/web/src/services/github.ts) obtains installation-scoped Octokit clients, lists repositories, resolves commits, and detects framework presets. Repository listing makes one GitHub request; UI pagination is local to the returned results. Repository-plus-preset lookup infers the owner from the installation account.

Framework detection examines the repository root on the requested branch. It prefers a root Dockerfile, then package/config evidence for Next.js, Vite, and React, with fallback presets. Command defaults are in [`constants/frameworks.ts`](../apps/web/src/constants/frameworks.ts). Detection does not recursively discover workspace applications. In particular, the Next.js preset defaults its root directory to `apps/web`, which must be reviewed for each imported repository.

### Create and enqueue a deployment

The principal orchestration module is [`services/projects.ts`](../apps/web/src/services/projects.ts), called by [`deployment.trpcs.ts`](../apps/web/src/trpc/routers/deployment.trpcs.ts) and `app.trpc.ts`.

1. `deployment.deploy` looks for an active app with the repository ID and authenticated creator.
2. On first import, `initializeNewProjectAndDeploy()` reads repository metadata, creates a project and app, generates domains, stores framework configuration, and encrypts initial environment values.
3. Initial import deploys the repository's default branch. The incoming `branch` is used when deploying an existing app, but is not passed into initial-project creation. The import form's editable project-name state is also not part of the mutation payload; stored names are derived from the repository.
4. `deployProject()` resolves the branch to a commit SHA using GitHub, then inserts a `queued`, production deployment row.
5. `ControlPanelAPIClient.queueDeployment()` sends `{ userId, deploymentId }` to the control plane, with a 15-second request timeout.
6. The HTTP handler enqueues a job and returns. Execution is asynchronous; the web UI navigates to the application with `?deployment=<id>` to select its persisted logs.

These database writes and queue insertion are separate operations. There is no transaction spanning initial setup and no database/queue outbox. A queue failure can leave persisted setup rows or a deployment in `queued` status.

`app.redeploy` selects the latest deployment's branch, resolves the linked repository by its stable GitHub repository ID, and queues a new deployment of that branch's current head. This is a fresh deployment rather than a rollback to the previous SHA. The procedure has a 20-second response timeout around the operation; that timer does not cancel underlying work.

## Control-plane implementations

[`ControlPanelAPIClient`](../packages/api-sdk/src/client.ts) is the server-side seam between web workflows and the deployment host. `API_BASE_URL` must already include `/api/v1`; client methods append paths to it. Standard JSON responses contain `status`, `statusCode`, `message`, `data`, and `errors`.

Both [`apps/node-manager/main.go`](../apps/node-manager/main.go) and [`apps/api/src/router/v1`](../apps/api/src/router/v1) expose this interface:

| Method and path                             | Behavior                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/v1/health`                        | Public process-liveness response; does not probe Redis, Docker, or PostgreSQL. |
| `POST /api/v1/deployments/queue`            | Validates the payload and queues a deployment job.                             |
| `GET /api/v1/admin/host`                    | Reads OS memory/CPU information and Docker inventory/disk information.         |
| `GET /api/v1/admin/docker/:resource`        | Lists `containers`, `images`, or `volumes`.                                    |
| `DELETE /api/v1/admin/docker/:resource/:id` | Deletes a Docker resource; container and image removal use force.              |
| `GET /api/v1/logs/stream/:deploymentId`     | Streams logs from `deployment-<id>` as server-sent events.                     |

Every endpoint except health requires `Authorization: Bearer <API_KEY>`. Admin endpoints operate on Docker host resources, without filtering to NMT labels; the web layer enforces the user's `admin` permission before forwarding them.

The Express implementation uses `@repo/queues` and Dockerode. The Go implementation uses the Docker Engine HTTP interface over `/var/run/docker.sock`, Linux system calls for memory information, and a small Redis protocol client. Its `addBullMQJob()` function writes BullMQ-compatible keys and events using Lua under the `bull:deployment-queue:` prefix. Changes to BullMQ versions, queue names, options, or job payloads must account for this manual implementation as well as the TypeScript producer and consumer. Matching endpoint names do not establish complete behavioral parity.

The Go module declares Go 1.27.1; its Dockerfile builds with Go 1.27 on Alpine. Its Unix socket and Linux memory implementation make the supplied container the intended execution environment. TypeScript Docker helpers additionally recognize the Windows Docker named pipe.

## Deployment worker

The active implementation is [`deployment.worker.ts`](../apps/worker/src/workers/deployment.worker.ts), supported by [`services/docker.ts`](../apps/worker/src/services/docker.ts), [`services/github.ts`](../apps/worker/src/services/github.ts), and [`services/env-vars.ts`](../apps/worker/src/services/env-vars.ts).

The queue is named `deployment-queue`; its payload contains only `userId` and `deploymentId`. The worker loads app, framework, and domain details from PostgreSQL. It consumes up to five jobs concurrently and serializes deployments of the same app with an in-memory promise map. This lock applies within one worker process; it does not coordinate multiple replicas.

The TypeScript producer and Go producer configure three attempts with exponential backoff starting at 2 seconds, retaining up to 100 completed and 1,000 failed jobs. A worker error marks the deployment `failed`, persists the error message, and rethrows so the queue can retry. Retries reuse deployment IDs and deterministic Docker names; there is no general reconciliation step for artifacts left by a prior attempt.

The successful execution path is:

1. Validate the deployment, app, matching environment domain, and framework configuration.
2. Authenticate to GHCR and create `builder-<deploymentId>` from `node:22-alpine`, installing Git, Docker CLI, and Bash inside it.
3. Mark `cloning`, clone into `/app` using a GitHub installation token, and run `git checkout --detach <commit>` for the stored SHA.
4. Resolve the configured root directory under `/app`, mark `installing`, and run the configured install command there.
5. Decrypt the project's environment values and write a `.env` file in that root directory.
6. Mark `building` and run the configured build command. Commit the builder filesystem into `ghcr.io/<lowercase-GITHUB_USER_NAME>/<deploymentId>:<deploymentId>`, setting `WORKDIR /app` and a shell command for startup.
7. Find prior deployment containers using `nmt.app-id` or a matching Traefik host rule. Mark `starting`, create `deployment-<deploymentId>` on `app-network`, attach Traefik labels and the configured port, and start it.
8. Mark `success`. Attach runtime-log persistence, push the image to GHCR, and remove the builder and prior containers asynchronously. These background operations do not gate the successful job result.

Keep these implementation constraints in view when changing this flow:

- Success means Docker accepted the container start. There is no application readiness probe, automatic health-based rollback, or guarantee of zero downtime. The previous containers remain until the replacement starts, then are removed in background cleanup.
- The clone URL uses the installation account and mutable `appName` as repository identity. Renaming the app can affect cloning even though the app retains a stable repository ID.
- Install and build commands use the configured root directory, but the committed startup working directory is always `/app`. `outputDirectory` is stored without being consumed by the worker.
- The Docker preset supplies command strings, but this flow always starts from the Node builder image. The builder has a Docker CLI without a mounted Docker socket; there is no separate Dockerfile execution path here.
- `.env` is written after dependency installation. Values are not separately injected with Docker's runtime `Env` option, and the committed filesystem includes the generated file. The cloned `.git` metadata also remains in the committed filesystem.
- Prior-container matching uses app ID across environments. Extending the current production-only request flow to previews requires reviewing replacement selection as well as adding a deployment environment input.

`deployment.worker.old.ts` and `deployment.worker.old.2.ts` are historical implementations, not imported by the worker entry point. The checked-in [`builder.Dockerfile`](../apps/worker/docker/builder.Dockerfile) is also not used by `createBuilderContainer()`, which prepares its container programmatically.

## Logs, configuration, and deletion

### Logs

Persisted deployment logs and live runtime logs follow different paths:

- Builder command output and deployment phase/error messages are inserted into `DeploymentLogs`. The worker also attaches a Docker runtime stream and serializes its database writes with `DeploymentLogQueue`. Application-detail polling reads deployment history with its logs through `app.get`; `?deployment=<id>` selects the displayed release.
- The application-log panel connects to [`/api/apps/[appId]/runtime-logs`](../apps/web/src/app/api/apps/%5BappId%5D/runtime-logs/route.ts). This Next.js handler explicitly checks the session, validates the app ID, selects the owner's latest successful deployment, and proxies the SDK's control-plane stream. The browser receives no control-plane bearer key.

The control plane tails 100 Docker log lines, follows stdout/stderr, and sends SSE heartbeat comments every 15 seconds. Runtime logs track the latest successful deployment, independently of the deployment selected for historical logs. Persisted runtime capture depends on the worker's in-process stream attachment; it is not a separate log collector that restores subscriptions on restart. Neither database log retrieval nor browser accumulation has a pagination/retention limit in the application implementation.

### Environment values and configuration

[`web/services/env-vars.ts`](../apps/web/src/services/env-vars.ts) encrypts values with AES-256-GCM and stores `base64(iv):base64(authTag):base64(ciphertext)`. The key is `ENV_ENCRYPTION_KEY`, decoded as exactly 32 bytes from 64 hexadecimal characters. The worker has a corresponding decryption implementation; the web and worker must use the same key and format.

Application detail queries return environment key metadata, without decrypted values. Adding a value inserts a row; deleting one deactivates the row after checking that it belongs to the app's project. Saving build settings or environment values changes persisted configuration; the UI prompts for redeployment to apply the changes. App renaming does not regenerate existing domains.

### Deletion

`project.deleteProject` deactivates the project row and does not stop its containers or deactivate child records. `app.delete` attempts to force-remove the latest successful deployment container, then deactivates the app and its project. Container-removal failures are logged and do not prevent the database updates. Images, environment rows, domains, and deployment history are not comprehensively deleted by these operations. See [`project.trpc.ts`](../apps/web/src/trpc/routers/project.trpc.ts) and [`app.trpc.ts`](../apps/web/src/trpc/routers/app.trpc.ts) before extending deletion behavior.

## Configuration and operations

TypeScript environment modules load `dotenv/config` and validate configuration with Zod at module import. The complete required set depends on the imported packages, not just the application's own environment schema. Both database URLs are required by the database validator even though runtime selection currently behaves as described above.

| Configuration group                                              | Consumers / source                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| WorkOS credentials, cookie password, callback URI                | Web AuthKit integration and [`web/src/env/vars.ts`](../apps/web/src/env/vars.ts).                                          |
| GitHub App ID, slug, private key                                 | Web GitHub integration and worker cloning; literal `\n` sequences in the configured private key are converted to newlines. |
| `GITHUB_USER_NAME`, `GITHUB_PAT`                                 | Worker GHCR authentication, image names, and pushes.                                                                       |
| `DEV_DATABASE_URL`, `PROD_DATABASE_URL`, `DB_ENV`, `BASE_DOMAIN` | Database configuration, migrations, and hostname generation.                                                               |
| `ENV_ENCRYPTION_KEY`                                             | Web encryption and worker decryption.                                                                                      |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`                     | Queue producers and worker.                                                                                                |
| `API_APP_PORT`, `API_KEY`                                        | Control-plane listener and shared bearer authentication.                                                                   |
| `API_BASE_URL`, `API_KEY`                                        | SDK configuration loaded by the web's server-side client.                                                                  |
| `CLOUDFLARE_TUNNEL_TOKEN`                                        | Tunnel Compose project and the setup script.                                                                               |

[`scripts/copy-env.mjs`](../scripts/copy-env.mjs) copies the root `.env` into each immediate child of `apps` and `packages`. It does not recurse into `packages/docker/<service>`. [`scripts/docker.mjs`](../scripts/docker.mjs) loads the root environment and passes it to Compose during `setup`.

`npm run docker -- setup` checks configuration, creates `app-network`, and starts Traefik, Redis, worker, API, then Cloudflare. Its wait function checks that containers are running; the separate Redis health-wait helper is not called. Setup requires the Cloudflare token and always starts the tunnel, although the README describes the tunnel as optional. The Cloudflare Compose file also declares `env_file: .env` in its own directory, which the environment-copy helper does not populate. The Compose wrapper currently prints its merged process environment, so its output can contain configured secrets.

Other `npm run docker -- <command>` invocations run the Compose command in each immediate Docker-project directory. They do not repeat setup's environment propagation or environment copying; service-local Compose interpolation requirements still apply.

| Compose project                                                  | Host integration                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`traefik`](../packages/docker/traefik/docker-compose.yml)       | Publishes port 80; Docker provider discovers explicitly labeled applications on `app-network`. No TLS entry point or certificate resolver is configured here.                        |
| [`redis`](../packages/docker/redis/docker-compose.yml)           | Publishes 6379; password authentication, append-only persistence, `redis-data` volume, and a health check.                                                                           |
| [`worker`](../packages/docker/worker/docker-compose.yml)         | Builds the TypeScript worker image; mounts the Docker socket; receives database, GitHub, registry, Redis, and encryption configuration.                                              |
| [`api`](../packages/docker/api/docker-compose.yml)               | Builds the Go node manager; mounts the Docker socket; publishes no host port and has no Traefik routing labels. The separately hosted web app needs an explicitly reachable API URL. |
| [`cloudflare`](../packages/docker/cloudflare/docker-compose.yml) | Starts the token-authenticated tunnel on `app-network`; ingress and public hostname mapping are outside the checked-in configuration.                                                |

[`scripts/reset.mjs`](../scripts/reset.mjs), invoked through `npm run reset -- --force`, drops the selected PostgreSQL `public` schema, invokes the migration command, and removes all Docker containers, images, volumes, custom networks, and builder cache on the selected Docker host. It is host-wide rather than scoped to Compose or NMT labels. Production reset additionally requires `ALLOW_PRODUCTION_RESET=true`.

## Change map

| Change                                                | Read or modify together                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import, framework detection, preset defaults          | [`services/github.ts`](../apps/web/src/services/github.ts), [`constants/frameworks.ts`](../apps/web/src/constants/frameworks.ts), [`import-repository.tsx`](../apps/web/src/components/repositories/import-repository.tsx), `git.trpc.ts`, `framework.trpc.ts`. |
| Deployment creation or redeploy                       | [`services/projects.ts`](../apps/web/src/services/projects.ts), [`deployment.trpcs.ts`](../apps/web/src/trpc/routers/deployment.trpcs.ts), [`app.trpc.ts`](../apps/web/src/trpc/routers/app.trpc.ts), deployment DAL.                                           |
| Queue contract or retry behavior                      | SDK request schema/client, TypeScript queue producer, Go `addBullMQJob()`, active worker.                                                                                                                                                                       |
| Build, startup, container replacement, routing labels | Active worker, worker Docker helpers, framework configuration, Traefik Compose definition.                                                                                                                                                                      |
| App settings, secrets, and log presentation           | `app.trpc.ts`, `app-details.tsx`, web/worker environment-value modules, runtime-log route, SDK stream, both control-plane implementations.                                                                                                                      |
| Persistence                                           | Table definitions, relations, DAL, and Drizzle-generated migrations; account for runtime/migration database-selection differences.                                                                                                                              |
| Host administration                                   | Web `admin.trpc.ts` / admin page, SDK admin methods, Go handlers, Express admin router.                                                                                                                                                                         |
| Runtime packaging                                     | Active Compose definitions and Dockerfiles; the root workspace graph alone does not cover Go.                                                                                                                                                                   |
| Navigation or authentication                          | `routes.ts`, `proxy.ts`, AuthKit route handlers, `trpc/init.ts`, procedure ownership checks.                                                                                                                                                                    |

## Build and verification reference

Root `npm run lint`, `npm run check-types`, and `npm run build` dispatch through Turbo. Builds depend on upstream package builds, with `.next` and `dist` outputs cached. Shared TypeScript packages export compiled `dist` files; development processes need those dependencies built before importing them. The root manifest permits Node 18+, while supplied Node container images use Node 22.

`npm run dev` starts the npm workspace dev scripts, including the Express app and TypeScript worker alongside Next.js. It does not start Go, Redis, PostgreSQL, or the Compose projects. Database generation, migration, and Studio commands are defined in [`packages/database/package.json`](../packages/database/package.json); choose `DB_ENV` with the runtime-pool caveat in mind.

No automated test files, root test script, or CI workflow were found in the inspected source tree. npm checks cover npm workspaces; Go needs a separate check using its declared toolchain, for example the existing container build from the repository root:

```sh
docker build -f apps/node-manager/docker/Dockerfile -t nmt-node-manager .
```

Before editing Next.js code, follow [`apps/web/AGENTS.md`](../apps/web/AGENTS.md), which requires consulting the relevant version-specific guide in `node_modules/next/dist/docs/`. Keep this reference current when changing runtime selection, job contracts, deployment lifecycle, persistence, or configuration flow.
