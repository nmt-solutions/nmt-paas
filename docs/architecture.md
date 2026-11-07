# NMT Deploy architecture

Maintained implementation reference, updated 2026-11-06 after the lifecycle program and its review fixes. The accepted [improvement spec](architecture-improvement-spec.md), [ticket breakdown](architecture-tickets.md) and [suggested architecture](suggested-architecture.md) retain their historical decisions. This describes current source behavior; it does not establish infrastructure availability or deployment health.

## Runtime and repository map

NMT Deploy imports GitHub repositories, builds them in Docker, and routes public traffic through Traefik. The supplied Docker service named `api` runs the **Go node manager**. Express remains the compatible npm development implementation.

| Location                            | Responsibility                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                          | Next.js 16.2.6 / React 19.2.4, WorkOS sessions, authenticated tRPC workflows, GitHub, admission, retirement and dispatch recovery |
| `apps/node-manager`                 | Authoritative Go/Gin host HTTP, private BullMQ-compatible Redis encoding, Docker HTTP and runtime streams                         |
| `apps/api`                          | Compatible Express host HTTP using Dockerode and the TypeScript queue producer                                                    |
| `apps/worker`                       | BullMQ registration, importable deployment executor, Docker/build adapters and cleanup operator                                   |
| `packages/database`                 | PostgreSQL/Drizzle schema, migrations, ownership/active reads and independent recovery records                                    |
| `packages/api-sdk`                  | Server-held host client; browser-safe typed runtime-log subpath                                                                   |
| `packages/queues`, `packages/redis` | TypeScript producer and IORedis connection                                                                                        |
| `packages/docker`                   | Separate Compose projects for Go API, worker, Redis, Traefik and optional Cloudflare Tunnel                                       |
| `scripts`                           | Local orchestration, redacted setup diagnostics and separately guarded destructive reset tooling                                  |

Web and PostgreSQL run separately from the supplied Compose projects. Web calls the host through server-side `ControlPanelAPIClient` with `API_KEY`; `API_BASE_URL` includes `/api/v1`. Host and worker share Docker. Redis delivers work to the worker; execution outcomes return through PostgreSQL. Containers share external `app-network`. Traefik publishes port 80. TLS/tunnel ingress and a reachable API URL are operator configuration. There is no host scheduler or remote-worker selection. npm/Turbo does not build or start Go.

## Authentication and persistence

WorkOS identifies users. User workflows require authenticated tRPC procedures and ownership checks; host-wide Docker administration additionally requires the separate `admin` permission. The host bearer authenticates the web control plane, not a browser user. The browser never receives it. GitHub completion validates the user's pending connection attempt and verifies installation access through user authorization. See [GitHub ownership](github-connection-ownership.md).

Runtime PostgreSQL selection and Drizzle migration selection both use `DB_ENV` (`development` by default): development selects `DEV_DATABASE_URL`, production selects `PROD_DATABASE_URL`. `APP_ENV` does not choose the database. Both URLs must validate even though only the selected database is connected. Development SQL/snapshots are checked in; there is no checked-in production migration directory. Use the existing release process for the selected environment; the runtime selector does not supply production migration files. See [database selection](database-environment-selection.md).

Core tables are `Projects`, `Apps`, `AppDomains`, `FrameworkConfig`, `Deployments`, `DeploymentLogs`, `EnvVars` and `GithubAppInstallations`. Additional lifecycle state:

| State                    | Purpose                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `DeploymentDispatches`   | Durable intent, owner/submission UUID, HMAC request fingerprint, attempts and leased recovery |
| `Deployments.cleanup`    | Nullable immutable artifact ledger with ownership, per-target outcomes and redacted errors    |
| `DeploymentPublications` | Immutable local image/reference and independent publication status                            |
| `Apps.retirement`        | Nullable pending/complete runtime cleanup, separate from visibility and deployment cleanup    |

Apply the complete ordered migration chain. Preserve applied SQL, identifiers and historical rows. No recovery outcome is inferred for rows without a record. Ordinary reads require eligible active deployment/app/project ancestry and ownership; eligible children are filtered too. The historical cleanup reader exposes only coordination identity, recorded start status and the ledger to the operator path. It does not reopen ordinary reads, admission, publication or logs. See [eligibility](active-resource-eligibility.md).

## Admission and dispatch

[`services/projects.ts`](../apps/web/src/services/projects.ts) and the deployment/app tRPC routers own admission. First import honors the submitted project name and branch. GitHub metadata/commit resolution happens before the database transaction. Related project/app/domain/config/encrypted-environment/deployment/dispatch writes commit atomically. Redeploy resolves a fresh head of the latest deployment's branch using stable numeric repository identity; it is not rollback.

Accepted work has a durable deployment and submission UUID. Identical replay returns the same intent; a conflicting request fingerprint is rejected. Browser retention stores only the UUID, including uncertain retries and remounts. Import and redeploy share lookup, identity lifetime and outcome presentation, with mutations/navigation local to each screen. UI distinguishes queued acceptance, saved but uncertain confirmation and explicit dispatch rejection. A response timeout is not proof of non-acceptance. See [first import](first-import-operations.md) and [durable dispatch](deployment-dispatch-recovery.md).

The existing long-lived Node web startup hook recovers immediately and five seconds after each completed pass. It leases at most ten due records with `SKIP LOCKED` for 30 seconds, commits before host HTTP, and confirms only its matching lease token. SDK HTTP timeout is 15 seconds. Failed temporary handoffs become due after five seconds. Dispatch takes the app lifecycle lock and rechecks eligibility after waiting. A wait can outlive the lease, allowing repeated handoffs. Serverless suspension is not a supported recovery runner.

## Host and queue contract

Both hosts expose public `GET /api/v1/health`; other endpoints require the server bearer. Queue and publication endpoints accept `{ userId, deploymentId }`. Retirement posts recorded deployment IDs to `/api/v1/apps/:appId/retire`. Runtime SSE is `/api/v1/logs/stream/:deploymentId`. `/api/v1/admin/host` and `/api/v1/admin/docker/:resource` remain separately permissioned host-wide operations.

Ordinary jobs on `deployment-queue` use a stable deployment-derived identity, three attempts, exponential backoff starting at two seconds (then four), and retention of 100 completed / 1000 failed jobs. Retained duplicate acknowledgements are accepted; conflicting ownership returns 409. Deduplication ends after eviction. Publication-only work has a separate random delivery identity and `operation: "publish"`; ordinary payloads remain compatible. Go's private Lua encoding is checked against the installed BullMQ consumer and Express producer. Endpoint names or Redis command matching alone do not prove compatibility. See [queue operations](queue-compatibility-operations.md) and [acknowledgement deduplication](enqueue-acknowledgement-deduplication.md).

## Execution and recovery

[`deployment.worker.ts`](../apps/worker/src/workers/deployment.worker.ts) registers BullMQ and forwards deliveries to [`production-executor.ts`](../apps/worker/src/deployment/production-executor.ts). The shared executor owns execution/recovery; importing its behavior does not connect Docker or register a consumer. Concurrency is five jobs with per-app FIFO plus a dedicated PostgreSQL lifecycle session lock. Eligibility is reloaded inside the app turn. No database transaction spans Docker or host HTTP.

1. Acquire local Docker without registry authentication. Reconcile deterministic containers/images by deployment identity and artifact role before building.
2. Track builder acquisition before preparation, clone using stable numeric repository identity, check out the recorded commit, and install/build in the configured root under `/app`.
3. Deliver decrypted values through structured command/runtime environment entries. Remove credential-bearing `.git` metadata and generated secret files before image commit.
4. Commit with the configured root as `WORKDIR` and configured startup command. Create the runtime on `app-network` with app/deployment/runtime and Traefik labels and configured port. Start it before retiring prior runtimes. Explicit app ownership overrides domain fallback in prior selection. `outputDirectory` is stored but not consumed here.
5. Persist `success`, meaning **Container started**, and immutable publication identity. Await recorded builder/prior-runtime cleanup before acknowledging execution. Attach runtime capture and launch independent background publication.

A failed initial build/start reports failure while preserving the previous runtime. Retries adopt artifacts instead of blindly recreating them. Verified or persisted starts survive later acquisition, persistence, cleanup and publication failures. Registry authentication is supplied only during push. Publication has independent persisted status/recovery and cannot demote start success. Cleanup records intent before removal, uses immutable IDs, rechecks ownership/replacement and protects current/adopted runtimes and images.

The OS-authorized `cleanup:deployment` operator can inspect/retry an existing ledger after app or project retirement, with recorded owner/creator checks and the same lifecycle lock. It never builds, starts, fetches environment/GitHub, publishes or enqueues. Ordinary queued cleanup remains active-only. See [execution entry point](deployment-execution-entry-point.md), [repository context](deployment-repository-context.md), [retry recovery](deployment-retry-recovery.md), [cleanup recovery](deployment-cleanup-recovery.md), [publication recovery](deployment-image-publication.md) and [environment/credentials](deployment-environment-credentials.md).

This remains a single-host, one-worker-per-host model. Locks do not establish distributed-worker support or exactly-once execution. There is no readiness probe, health-based rollback or zero-downtime guarantee. The programmatic Node builder is used even for Docker presets; the builder Dockerfile and `deployment.worker.old*` are not active paths. Interrupted background publication needs explicit recovery; it is not scanned automatically. Filesystem fixtures do not prove real Docker image-layer secret exclusion. See [start guarantee](deployment-container-start.md), [failed cleanup](failed-deployment-cleanup.md) and [redaction](diagnostic-redaction.md).

## Retirement and logs

App retirement atomically hides the app, domains and deployments and records pending cleanup while preserving its project, shared environment values and siblings. Project retirement takes project lock namespace `2222`, then child app namespace `2121` in ascending ID order on one dedicated session. It commits all visibility together and releases that complete lock set before invoking each app's normal cleanup. Both workflows share the transaction-scoped child transition. Dedicated wait sessions stay outside the query pool; budget connections accordingly.

Host cleanup lists and re-inspects immutable container IDs. It accepts matching app/deployment/runtime labels, or the exact pre-upgrade `deployment-{id}` name with both matching ownership labels and no role label. Conflicting roles, changed ownership and name/domain-only guesses never grant deletion. Builders, images, volumes, networks and unrelated resources stay outside runtime retirement. 404 is complete; partial removal/lost acknowledgements remain pending. Owner-only retired app/project views allow refresh/restart and idempotent retry. Foreign children stay private and keep aggregate cleanup pending. Recovery never reactivates visibility. See [app retirement](app-retirement-operations.md) and [project retirement](project-retirement-operations.md).

App metadata polling does not eagerly load logs. Selected history uses an owner/active-scoped cursor reader: 100 records by default, 200 maximum, 4096 PostgreSQL characters/message and explicit clipping. New releases do not replace selected history or scroll position. Live output retains at most 1000 lines / 131072 UTF-16 units with truncation indicated. These bounds do not cap total metadata, database retention or Docker retention.

The server-only runtime route selects an eligible successful runtime and forwards typed SSE with explicit identity, decoded text, errors and termination. Both hosts reconstruct Docker framing, fragmented UTF-8 and partial lines. EOF/cancellation releases readers and heartbeat work. Subscriptions stay pinned to their starting runtime; reconnect identifies the current runtime. Docker tail is 100 lines; SSE heartbeat is 15 seconds. Worker persistence is an in-process attachment, not a restart-restored collector. See [typed logs](runtime-log-protocol-and-reconnect.md), [subscription lifetime](runtime-log-subscription-lifecycle.md) and [bounded history](bounded-deployment-log-history.md).

## Change and verification reference

Change admission with `services/projects.ts`, dispatch DAL/recovery and both submission screens; execution with the executor, production wiring and Docker adapters; retirement with both DALs, their shared transition and both host handlers. Queue identity/policy changes need both producers and the real BullMQ suite. Schema changes require the full migration chain and physical upgrade evidence.

Root build/lint/type commands use Turbo and compiled dependency `dist` exports. Web/worker/API scripts exercise authenticated requests, owner UI in JSDOM, execution, recovery and host streams. `npm run test:queue` exercises both hosts with local Redis/BullMQ. Run Go test/vet/build separately using declared Go 1.27.1. Local workflows use disposable PostgreSQL/Redis. Docker HTTP/provider fixtures do not establish real-daemon or live-registry compatibility. Real Docker, live providers/registry, Linux-native/race and distributed-worker operation require separate evidence. Opt-in Docker smoke suites remain available.

Before editing Next.js, follow [`apps/web/AGENTS.md`](../apps/web/AGENTS.md) and its installed version-specific guides. Keep this reference current when changing runtime selection, job contracts, deployment lifecycle, persistence or configuration.
