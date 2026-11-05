# Deployment success means container start

The worker records the existing `success` deployment status after Docker accepts
the runtime container's start request. The execution promise resolves after that
status and its completion log are written. The log says:

> Container started for APP at DOMAIN. Application readiness has not been checked.

This is a historical execution result. The app can still be initializing, fail to
serve a request, or exit after start. No readiness probe, uptime measurement,
health-based rollback, or continuing runtime check is performed by deployment
execution. Deployment IDs, status values, and the latest-success lookup remain
compatible with existing records and clients.

## Reading the owner views

- App details label the latest deployment result **Container started** and explain
  that application readiness has not been checked. This describes the latest
  attempt, including when an older runtime survives a failed replacement.
- Deployment history uses the same label for successful attempts and keeps their
  original deployment IDs, branches, commits, and logs. Selecting a release opens
  that release's logs; the result does not certify its runtime is still running.
- Dashboard and project-list badges use **Container started**. The dashboard's
  **Container starts** counts retained deployment records with `status=success`.
  **Container start rate** divides that count by all recorded deployments in the
  workspace, including pending and failed attempts, rounded to a whole percent.
  It displays a dash when there are no records. These are deployment-history
  statistics, not application health or availability measurements.

To investigate an attempt, open its app, select the deployment in history, and
inspect the deployment and application output. Check the application's endpoint
separately to establish whether it serves the expected response. Registry image
publication still runs in the background. Replacement retirement now finishes
inside per-app coordination; failed persistence or cleanup rejects the delivery
for retry while preserving the accepted start. The start result alone does not
establish retirement completion. See [deployment retry recovery](deployment-retry-recovery.md).

## Local verification

Use a disposable loopback PostgreSQL server with database-creation permission and
Node with experimental module-mock support. The workflow
creates a uniquely named database, applies the checked-in development migrations,
and drops that database afterward. Never use a production database URL.

```powershell
npm ci
npx turbo run build --filter=@repo/api-sdk --filter=@repo/database
$env:DATABASE_TEST_URL = 'postgresql://fixture@127.0.0.1:55443/postgres'
npm run test:deployment-result --workspace=web
npm test --workspace=worker
```

The workflow executes the production execution interface with real PostgreSQL
persistence, then reads through the authenticated app and project tRPC callers.
It renders the actual React views, switches to deployment history, and checks
the start count and percentage against mixed successful and failed records.
Docker is a deterministic local HTTP fixture; GitHub clone access and environment
values are fixture adapters. JSDOM supplies a DOM, not a real browser. Only
Next's build-only `server-only` import guard is bypassed so the server and client
parts can share this Node test process. Internal persistence, routers, query
hooks, components, and execution logic are not mocked.

The test skips when `DATABASE_TEST_URL` is absent. A passing fixture workflow
does not establish real Docker, Redis/BullMQ delivery, GitHub, registry, or
production authentication compatibility. The optional real-Docker smoke command
remains `npm run test:docker --workspace=worker`.
