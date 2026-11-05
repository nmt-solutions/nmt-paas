# Active-resource eligibility

An app is usable only when it is active, its parent project is active, the app's
`createdBy` matches the authenticated user, and the project's `userId` matches
that same user. The database access layer owns this common rule. A queued
deployment additionally requires an active deployment whose `userId` and
`createdBy` match the delivery user. Deployment IDs alone grant no access.

App detail/configuration/environment actions, app-ID redeploy, repository-based
admission, project polling, latest-success selection, and runtime-log forwarding
all apply this rule. Project lists omit ineligible children. App-ID requests
return `NOT_FOUND`; latest-success returns no deployment; runtime-log requests
return 404. Unauthenticated requests return `UNAUTHORIZED` or HTTP 401. Requests
rejected at their initial eligibility check do not fetch GitHub configuration or
contact the deployment host. The host bearer key remains in the server-only SDK
client and is never returned to the browser.

Repository admission distinguishes an owner's retired app link from a repository
that owner has never imported. Supplying first-import configuration for a retired
link returns `NOT_FOUND`; it does not create a replacement project or app. This
check reveals no other owner's app linkage. Independent owners can still import
repositories to which their own GitHub installation grants access.

Admission rechecks eligibility after external commit resolution and before
creating a deployment. Execution reads eligibility from PostgreSQL when work is
delivered and rechecks after acquiring the app's execution turn. An ineligible
delivery rejects with `Deployment not found` without acquiring Docker resources,
overwriting status, or appending logs. BullMQ retains responsibility for ordinary
acknowledgement, three-attempt backoff, and job retention; this change does not
alter those policies. A rejected stale delivery can therefore exhaust retries
while the original deployment row retains its last recorded status.

## Operations and boundaries

Deploy the database package with web and worker so every process uses the same
eligibility rule. No schema migration or new credential is needed. An inactive
parent hides otherwise-active children immediately on subsequent reads and new
subscriptions; changing a child's flag alone cannot restore access through an
inactive parent. For an unexpected 404, inspect app status/creator, project
status/owner, and deployment status/owner using authorized database operations.
Do not reactivate a retired resource to replay an old queue job.

This ticket gates access and queued execution. It does not implement retirement
cleanup/recovery, stop a build already executing, or revoke an already-established
runtime-log subscription. Retirement orchestration and in-flight reconciliation
remain separate lifecycle work. A database check is not an atomic lock spanning
GitHub/Redis/Docker; execution still checks eligibility independently of admission.
Existing log cancellation/EOF behavior and separately permissioned host-wide
administration are preserved.

## Local verification

Use fixture-only credentials and a disposable loopback PostgreSQL server:

```powershell
$env:AUTH_TEST_DATABASE_URL = 'postgresql://fixture@127.0.0.1:55460/postgres'
npm exec turbo run build -- --filter=worker... --filter=@repo/api-sdk
npm run test:eligibility --workspace web
npm run test:auth --workspace web
npm test --workspace worker
```

The eligibility command reuses the authenticated-workflow runner. Each run applies
the real development migrations in a unique schema and drops that schema at exit.
Tests use production tRPC callers, runtime-log forwarding, PostgreSQL/Drizzle, and
the deployment-execution interface. Only external AuthKit/GitHub/host responses
and the Docker daemon are fixtures. One execution race is injected at the
persistence boundary after a real PostgreSQL snapshot. SQL is used to seed and
retire fixtures; outcomes are read through requests and execution, not private
helper state. Docker HTTP fixture results are not real-daemon evidence.

Preserve and run `npm run test:runtime-logs`, `npm run test:queue`, the database
suite, and diagnostic suites when integrating. The default queue suite exercises
both real Go and Express producers with real Redis/BullMQ; do not replace it with
an Express-only run or a deterministic queue fixture. Linux-native/race and
real-Docker checks require their corresponding local infrastructure.
