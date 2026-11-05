# Deployment retry and replacement recovery

Execution success means Docker accepted container start. It does not verify
application readiness or continued availability. The production BullMQ callback
still passes the existing `{ userId, deploymentId }` request to one executor and
rejects unsuccessful attempts to BullMQ. Queue identity, payload, three attempts,
2/4-second exponential retry delays, and retention policies are unchanged.
Producer acknowledgement deduplication is a separate concern.

## After a replacement starts

Execution preserves the started runtime, image, and any remaining builder when
the success status or confirmation log cannot be saved. The retry error and,
when writable, deployment history identify `Runtime started; recovery pending`.
Status and diagnostic writes are independent: failure of one does not prevent
the other. If outcome persistence works, `success` still describes the accepted
container start; an unavailable database can leave the last saved `starting`
status. Neither status alone establishes whether the queue attempt completed.
Inspect the job outcome and deployment history together.

Docker identity remains discoverable even if both database writes fail. A fresh
executor finds the exact deployment runtime name and checks both `nmt.app-id` and
`nmt.deployment-id` labels. A running runtime is adopted without restarting or
rebuilding it. An identified created/stopped runtime is started in place. A
failed inspection preserves the existing runtime for another attempt.
Recovery reloads configured environment secrets into its fresh diagnostic scope
before attaching runtime output, including when it reuses an image without a
build. If that read fails, a running runtime is preserved and the delivery retries.

Only after replacement start and its confirmation writes does execution retire
prior app runtimes. Retirement and temporary-builder removal finish inside the
app lock. A failed removal records a separate scrubbed `Cleanup failed for ...`
diagnostic and rejects the attempt for retry, preserving the started replacement
and its start-success status. Retry rescans remaining artifacts; Docker 404
counts as already removed. There may be a period with both old and new runtimes
running during recovery. There is no readiness probe or zero-downtime guarantee.
Registry publication and runtime log capture retain their background behavior.

## Artifact reconciliation

| Discoverable artifact                                                        | Retry behavior                                                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `deployment-<id>`, matching app/deployment labels                            | Adopt the running container, or start the same stopped container, then retry confirmation and retirement.              |
| Deployment image tag with matching deployment label and `nmt.artifact=image` | Reuse the committed image and create the runtime without cloning/building again.                                       |
| `builder-<id>` with matching deployment label and `nmt.artifact=builder`     | Remove a partial builder before a fresh build; remove it during finalization if a runtime/image can already be reused. |
| Conflicting runtime/image identity, or an unlabeled/foreign builder          | Preserve it and report the conflict; deterministic names alone do not authorize acquisition.                           |

New builder labels survive image commit; the image and runtime carry their own
artifact roles. A fresh build still resolves the numeric repository identity,
checks out the recorded commit, and uses the configured directory for install,
build, image WORKDIR, and startup. Pre-start failures retain the acquisition and
non-forced image cleanup rules in [failed deployment cleanup](failed-deployment-cleanup.md).
Shared base images, volumes, and unrelated apps are outside cleanup ownership.

To recover an exhausted job, first restore the failed dependency, inspect its
scrubbed history and exact Docker identities, then retry that same deployment's
failed job through BullMQ's supported retry operation. Do not create a new
deployment merely to clear a Docker-name conflict. Legacy artifacts without the
new ownership labels need operator inspection; execution will not guess their
ownership or relabel them. Keep worker output when persistence is unavailable.
Incomplete artifact removals now have a focused durable ledger and
[cleanup-only operator recovery](deployment-cleanup-recovery.md). That workflow
does not rebuild or redeploy and leaves the runtime-start outcome unchanged.

## Supported concurrency

Run one worker process per deployment host, with one executor shared by all five
concurrent BullMQ processors. Its per-app FIFO coordination covers artifact
inspection, building, start, persistence, retirement, and failure reporting. Each
attempt releases coordination in `finally`; the last waiter removes its entry.
Another app can proceed while one app waits on Docker or persistence. Locks order
execution attempts as they arrive, including delayed retries; they do not promise
submission-time ordering. These FIFO locks are process-local. Production execution
also takes the per-app PostgreSQL lifecycle lock shared with owner retirement and
cleanup recovery; see [app retirement](app-retirement-operations.md). The supported
model remains one worker process per host; this increment does not establish a
multi-worker scheduler or distributed delivery guarantee.

## Verification

```sh
npm run build --workspace=@repo/database --workspace=@repo/redis
npm test --workspace=worker
npm run test:recovery --workspace=worker
npm run test:failures --workspace=worker
npm run test:diagnostics --workspace=worker
npm run test:queue
npm run test:docker --workspace=worker
```

`test:recovery` requires `TEST_DATABASE_URL` for a disposable local PostgreSQL
server with database-creation permission, and `redis-server` on PATH or an absolute
`REDIS_SERVER_BIN`. It owns a fresh password-protected Redis process and a unique
database, applies the committed development migrations, then delivers jobs through
the production worker with the installed real BullMQ. PostgreSQL triggers reject
the post-start status or log write for two attempts; the third attempt completes
after real 2/4-second delays. Assertions use owner-facing history, job outcomes,
and Docker's interface. Only Docker and GitHub are deterministic boundaries.

`test:queue` additionally requires Go (or absolute `GO_BIN`) and checks both real
Go and Express producers. `test:docker` requires a real disposable Docker daemon;
fixture success and type checking do not establish real-daemon compatibility.
The recovery smoke case checks adoption/retirement by actual container IDs with
fixture persistence. Report missing Docker evidence explicitly when unavailable.
