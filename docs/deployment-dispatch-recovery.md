# Accepted deployment dispatch and recovery

Import and redeploy save a Deployment and a `DeploymentDispatches` record in the
same short PostgreSQL transaction. First import also commits its project, app,
domains, framework configuration and encrypted environment values in that
transaction. A failed write or commit rolls everything back. GitHub resolution
precedes the transaction; host HTTP calls follow it. Network operations never
hold the admission transaction open.

## Submission and owner contract

Both authenticated mutations accept a UUID `submissionId`. Generate it once
before sending the request and reuse it after any timeout, disconnection or
unknown result. The identity is scoped to the authenticated user. Concurrent
duplicates resolve to the same project/app/deployment, even on first import.
An accepted replay does not resolve another commit or require GitHub to be
available. A new intentional deployment needs a new UUID and resolves a fresh
head through the existing repository flow.

The server stores an HMAC of the validated request using the existing encryption
key; it does not store plaintext environment values in the dispatch record.
Reusing an identity for a different operation, app or request returns `CONFLICT`.
Request fingerprints and host/provider errors are never returned by status
queries. Keep the configured encryption key stable across web instances.

For compatibility, callers that omit the UUID receive a generated identity in
the result. They must retain it for subsequent retries; an old caller that loses
that first response cannot deduplicate a retry without supplying a stable UUID.
The current import and redeploy UI always supplies an identity before admission.

Results retain `appId`, `projectId` and `deploymentId` and add `submissionId`,
`outcome`, `dispatchState`, `attempts` and `nextAttemptAt`:

| Outcome     | Dispatch state | Meaning and owner action                                                                                                                                                |
| ----------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted`  | `dispatched`   | The saved deployment's queue handoff was acknowledged and recorded. Open its deployment details.                                                                        |
| `uncertain` | `pending`      | Admission is saved, but the queue handoff is unconfirmed. It might already have run. Recovery retries the same deployment; leave the page or check this identity again. |
| `rejected`  | `rejected`     | The host explicitly refused the handoff with 400, 409 or 422. The saved identity remains visible. Ask the operator to investigate before making another submission.     |

Validation, authentication, ownership and pre-admission provider failures still
return the existing tRPC errors. An error or lost response is never proof that a
submission was not saved. Query `deployment.submission({ submissionId })` under
the same authenticated owner; it returns the accepted identity or `null` at the
time of that read. Retry the same UUID if no result is yet visible, since an
earlier request may still be completing. Other owners receive `null`.

The UI retains only the UUID in tab session storage, keeping it across retries
and page reloads. It checks for an existing admission before sending another
mutation, so changed form defaults after reload cannot replace accepted work.
No environment values or tokens enter browser storage. If browser storage is
disabled, the in-memory fallback covers retries during that page's lifetime.
After a known accepted/rejected result, the next intentional action gets a new
identity. Unknown results retain their identity.

Owners find saved work in Projects and the app's deployment history, including
when the host is unavailable. The app polls the owner-scoped
`deployment.dispatches({ appId })` query and shows pending/rejected handoff state
for the selected deployment. This view contains the newest 100 dispatch records;
the submission lookup remains available for older identities. Execution status
is separate: `success` continues to mean **container started**, with no readiness
probe, and dispatch acknowledgement says nothing about application start.

## Automatic recovery in the existing web process

Apply the additive `deployment_dispatch` development migration before deploying
the updated web server. It creates one table, its deployment foreign key,
owner/submission uniqueness, state constraint and a pending-due index. It
preserves existing records and intentionally creates no dispatch intents for
historical deployments. Keep the migration/snapshot chain intact when promoting
the schema with the repository's environment-specific migration procedure.

The Node Next.js startup hook starts recovery immediately and then five seconds
after each pass. Production builds and the Edge runtime do not run dispatch.
Use the existing long-lived Node web server; serverless suspension is not a
supported recovery scheduler. No new queue-owning process or endpoint is needed.
At least one web process must remain running to recover without owner traffic;
normal mutations also attempt a due handoff after committing admission.

A pass atomically leases up to ten due pending records using PostgreSQL row
locks with `SKIP LOCKED`, then releases the statement transaction before HTTP.
The lease lasts 30 seconds, longer than the existing 15-second SDK HTTP timeout.
Confirmation requires the lease token, preventing a stale dispatcher from
overwriting another attempt. A crash or confirmation-write failure leaves the
lease discoverable and retryable when it expires. Temporary host/Redis errors,
timeouts, lost responses, 401/403 configuration failures and malformed responses
remain pending. A completed failed handoff is due again after five seconds.
These are dispatch retries; the existing queue's three attempts, exponential
2/4-second delays, pause behavior and retention policy are unchanged.

Recovery uses the same host HTTP endpoint and `{ deploymentId, userId }` payload
as ordinary dispatch. Go remains the deployed producer and Express retains its
compatible development behavior. Their existing deployment-derived job identity
deduplicates re-enqueue while the job is retained. A lost acknowledgement can
therefore reconcile a completed retained job without running it again. This is
at-least-once handoff, not an unbounded exactly-once guarantee: after queue
retention evicts an unconfirmed job, recovery may deliver that same deployment
again. The existing worker's artifact reconciliation and per-app coordination
still apply. Redis's own persistence and worker execution durability remain
their existing operational responsibilities.

## Operator observation and repair

Use the owner views first. For host diagnosis, a narrow read on the selected
database is enough; do not dump environment values, request hashes or credentials:

```sql
SELECT "deploymentId", "userId", "submissionId", state, attempts,
       "nextAttemptAt", "leaseUntil", "updatedAt"
FROM "DeploymentDispatches"
WHERE state IN ('pending', 'rejected')
ORDER BY "nextAttemptAt";
```

For pending records, restore the web-to-host connection, bearer configuration,
Redis availability and database access, then allow the normal poll/lease delay.
Restarting the web process also starts a pass; it does not discard intent or
reset active leases. Database failures produce a fixed, scrubbed recovery warning.
No raw HTTP body, Axios configuration, secret or command is logged by recovery.

For a rejected record, investigate validation or conflicting ownership at the
host. Do not delete the deployment or unrelated Redis/Docker resources. After
repairing the underlying problem and confirming the saved deployment's ownership,
an operator can re-arm **only that record** with a parameterized statement:

```sql
UPDATE "DeploymentDispatches"
SET state = 'pending', "nextAttemptAt" = now(),
    lease = NULL, "leaseUntil" = NULL, "updatedAt" = now()
WHERE "deploymentId" = $1 AND "userId" = $2 AND state = 'rejected';
```

Do not prune dispatch records while owners may replay their submission IDs.
They are the durable identity ledger, independent of Redis job retention. This
ticket introduces no general lifecycle ledger, registry-publication retries,
failed-artifact cleanup process, retirement policy or eligibility policy.

## Verification

`npm run test:import --workspace=web` uses disposable local PostgreSQL through
authenticated tRPC callers. It covers all initial setup rollback points,
dispatch-record rollback, concurrent duplicates, identity conflict, stable
redeploy commits, owner lookup, auth and host failure. Set
`IMPORT_TEST_DATABASE_URL` to an isolated loopback PostgreSQL server.

`npm run test:dispatch --workspace=web` also requires `redis-server` on PATH or
an absolute `REDIS_SERVER_BIN`. It owns a fresh loopback Redis process, runs the
actual Express producer and installed BullMQ consumer, injects response loss at
an HTTP proxy, and starts fresh processes through the production web startup
hook. It covers eventual recovery, lost acknowledgements, host refusal, real
Redis outage, actual PostgreSQL confirmation failure/lease expiry, and the owner
UI's lost-response retry through the real tRPC router and JSDOM. The fixture
runner owns and removes its schema and processes. GitHub and WorkOS identities
are fixtures; it does not execute Docker builds or contact live providers.

Run the default `npm run test:queue` on an allowed Go/Redis host to retain both
producer compatibility checks. No real Docker, live GitHub, WorkOS or registry
evidence is implied by these dispatch suites.
