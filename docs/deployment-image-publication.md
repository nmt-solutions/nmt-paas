# Recovering image publication

Container start and image publication are separate outcomes. Deployment `success`
continues to mean **Container started**; application readiness is not checked.
The existing worker starts registry publication in the background after confirming
start and awaiting replacement cleanup. A failed publication never changes that
deployment to a startup failure or restarts its runtime.

## Durable state and rollout

Apply the additive `deployment_publication` development migration through the
existing database migration/release process before deploying this worker/web
change. Select the intended database with the existing `DB_ENV` rule. It adds only
`DeploymentPublications`, keyed by the existing deployment ID, and preserves
existing deployment records and identifiers. Historical deployments without a
publication record display **No publication recorded**; publication success is not
inferred or backfilled.

The ordered development snapshots include publication before cleanup. The later
cleanup snapshot retains the publication table and adds its nullable ledger
column. Apply the complete migration directory; existing migration SQL is
unchanged. The installed migrator tracks applied migration names, so it also
applies publication when cleanup has already been recorded.

After Docker starts the runtime, the executor records its immutable local image ID
and the deployment's registry reference before acknowledging execution. Normal
redelivery reconciles the running container and that same publication identity.
An identity conflict preserves the original record and reports recovery pending.
The publication record contains no registry credentials.

| Publication status | Meaning                                                                                                       | Recovery                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `pending`          | Image identity saved; publication has not begun.                                                              | Retry publication if background work was interrupted.  |
| `publishing`       | A push began; confirmation has not been saved.                                                                | After worker interruption, retry the same publication. |
| `failed`           | Push or confirmation persistence failed. A bounded, redacted diagnostic is saved when PostgreSQL is writable. | Correct the cause, then retry publication.             |
| `published`        | Docker's push stream confirmed a manifest and the result was saved.                                           | Repeated recovery is a no-op.                          |

Layer progress (`Pushed`) and clean stream EOF alone do not confirm manifest
publication. Docker transport errors, registry error records (including errors in
HTTP 200 progress streams), malformed/truncated responses, and missing manifest
confirmation fail publication. The adapter reconstructs fragmented JSON/UTF-8 and
does not print raw progress records. Registry passwords and Docker's encoded
authentication header are redacted before errors are persisted or reported.

If PostgreSQL rejects the result write, the worker attempts to save a separate
publication failure. Storage errors use an actionable recovery message in the
owner view; raw queries remain out of the status card. If both writes fail, the persisted `pending`/`publishing`
state remains recoverable. A registry push may already have succeeded; replaying
that same image safely confirms it again. Runtime status is unchanged.

## Owner and operator recovery

Select the deployment in the app workspace. **Image publication** shows its own
outcome and diagnostic. **Retry publication** queues publication of that recorded
image. A queue acknowledgement is not registry confirmation; watch the status.
The view polls every 2.5 seconds, independently of deployment log subscriptions.

The authenticated tRPC procedures are `deployment.publication({ deploymentId })`
and `deployment.retryPublication({ deploymentId })`. The deployment owner or a
user with the existing `admin` permission can inspect/retry. Inactive deployment,
app, or project records and foreign owners receive a generic not-found response.
Recovery requires an already started deployment and a recorded image. An
administrator's request still delivers the deployment owner's ID to the worker.
The host bearer key remains server-side.

Both Go and Express expose the server-authenticated
`POST /api/v1/deployments/publication` endpoint with the existing
`{ userId, deploymentId }` request envelope. It produces publication-only work on
`deployment-queue`, with the existing three attempts, exponential 2/4-second retry
delays, and retention of 100 completed/1000 failed jobs. Normal deployment jobs,
their stable identities, and the existing producer Lua script remain unchanged.
Explicit publication requests use a separate random `publication-…` delivery ID
so a retained completed/failed deployment job cannot suppress recovery.

The production BullMQ callback calls the same executor with `operation: "publish"`.
It reloads the authorized publication record, serializes with the same per-app
FIFO and the dedicated PostgreSQL app lifecycle session lock, checks active-owner
eligibility and the saved outcome again, and pushes only the recorded image. It never
clones, builds, creates/starts a container, updates deployment status, attaches
runtime logs, or retires a runtime. Recovering an older image therefore preserves
the app's newer running deployment. Repeated or concurrent recovery safely skips
an image already confirmed by another attempt in this worker process.

The owner-scoped deployment read is repeated inside the app turn before push.
The shared production executor also serves cleanup-only recovery. Publication
leaves the cleanup ledger and its artifacts unchanged, including pending cleanup;
cleanup leaves publication unchanged and uses local Docker without registry
authentication or queue imports. See [cleanup recovery](deployment-cleanup-recovery.md)
for that separate operator command.

Before push, the registry reference must still resolve to the saved immutable
image ID and matching deployment/image-role labels. Missing images, changed tags,
or foreign artifacts fail visibly; recovery does not rebuild or publish a
substitute. Preserve the local image/reference until publication completes. No
registry credentials, host reset, broad cleanup, or resource selection is accepted
from the browser.

## Limits and verification

This remains the supported single-host worker model. The shared production executor
combines its process-local FIFO with the PostgreSQL lifecycle lock for ordinary,
cleanup-only and publication-only work, including background publication. Retirement
uses the same database lock. Dedicated sessions keep lock waiters outside the normal
query pool; sessions close in `finally`. Eligibility is checked after both coordinators
before publication. Deploy the web and worker updates together. This does not establish
multi-worker support or an automatic database recovery scanner, or guarantee that
background publication has finished when a deployment job
completes. An interrupted background push needs explicit recovery; recovery jobs
then use the existing BullMQ retries. A lost HTTP acknowledgement can be retried
without redeployment; [durable dispatch](deployment-dispatch-recovery.md) handles
ordinary admission recovery. Local Docker acquisition and runtime/image adoption
do not authenticate against GHCR. Only publication supplies registry authentication
to the push adapter. A fresh delivery that fails before discovery preserves an
already recorded successful start; genuine initial build/start failures still
report failure. Cleanup recovery is also a separate outcome.

`npm test --workspace=worker` exercises the shared execution interface with a
Docker HTTP fixture. `TEST_DATABASE_URL=<disposable loopback PostgreSQL URL>
REDIS_SERVER_BIN=<optional local redis-server path> npm run test:publication
--workspace=web` exercises real PostgreSQL, real Redis/BullMQ, production worker
registration/restart, owner/admin requests, registry failure, and publication
confirmation-write failure. Each harness owns and removes only its own fixture
database/Redis resources. `npm run test:queue` checks both real Go/Express HTTP
producers against the installed BullMQ consumer; `QUEUE_TEST_PRODUCERS=Express`
is a documented subset, not Go execution evidence.

The focused registry-adapter evidence uses the actual Dockerode client against a
disposable Docker HTTP boundary, including authentication, progress/error framing,
and immutable-image checks. It is not a real Docker daemon or a live GHCR push.
Run the preserved opt-in `npm run test:docker --workspace=worker` on an allowed
host with a disposable daemon; those three smoke cases exclude live registry
publication. Live registry credentials/publication, daemon image/tag semantics,
and multi-worker behavior are not established by deterministic fixtures. Record
host execution-policy failures separately from passed producer tests.
