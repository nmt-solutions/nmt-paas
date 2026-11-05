# App retirement and runtime recovery

An owner deletes an app through the existing app page or `app.delete({ appId })` authenticated workflow. The app, its domains, and deployment eligibility become inactive in one PostgreSQL transaction. Its project, shared environment values, and sibling apps remain active. App detail, redeploy, repository lookup, latest-success/runtime logs, and queued execution continue to use the common active-resource rule from #20.

Retirement does not claim a host outage removed a container. `app.retirementStatus({ appId })` remains readable by the app creator who owns its project, including after retirement. It returns the app identity and a persisted `retirement` outcome: `pending` or `complete`, with a safe message. Foreign and unauthenticated callers cannot inspect or retry it. The retired app page shows that outcome after refresh and offers **Retry cleanup** while pending. Bookmark its existing `/projects/<projectId>/apps/<appId>` address before navigating away. Repeating the delete action is the same recovery workflow; it never reactivates the app.

## Coordination and failure boundaries

The shared production executor and retirement request take the same PostgreSQL session advisory lock, namespace `2121`, keyed by app ID. Ordinary execution, cleanup-only recovery, publication-only recovery and background publication retain the existing in-process FIFO turn and reload owner/active eligibility after acquiring the database lock. An in-flight operation finishes before retirement deactivates and removes its runtime; queued or restarted deliveries then reject the retired app without status/history writes or Docker acquisition. Other app IDs can progress independently. Deploy the updated worker and web application together; an older worker does not participate in this lock.

Each lock uses a short-lived dedicated PostgreSQL session, so concurrent waiters cannot exhaust the application query pool and deadlock its holder. Account for those sessions in the host connection budget. The lock spans cleanup, but no database transaction spans host HTTP. Visibility changes and initial pending state commit before cleanup begins. Process death releases the session lock; the pending record survives. If Docker removes a runtime but acknowledgement or the outcome write fails, a fresh owner request rescans the host and safely observes absence. A visibility transaction failure rolls back all its writes and makes no cleanup request. Request cancellation or a lost HTTP response is not evidence of cleanup completion: reread the persisted outcome and retry pending cleanup.

## Host contract and ownership

The authoritative Go node manager exposes bearer-authenticated `POST /api/v1/apps/:appId/retire` with `{ "deploymentIds": [42] }`. The server-side SDK supplies the retired app's owner-scoped persisted deployment IDs. Express supports the same contract. The response's `data.complete` distinguishes completed cleanup from partial failure; host transport failures leave the app pending. Raw host/provider errors are not persisted or returned as owner messages.

This endpoint accepts no arbitrary Docker ID and does not use `/admin/docker`. It lists containers, selects the app's runtime labels and recorded deployment identities, re-inspects each immutable container ID, and removes only verified `nmt.app-id`, `nmt.deployment-id`, `nmt.artifact=runtime` ownership. A disappeared container (404) is complete; changed/unverified ownership remains pending. Deterministic deployment names identify suspicious legacy/colliding resources for a pending outcome, never grant removal authority. Legacy containers lacking verified ownership require separately authorized operator inspection; this workflow will not guess ownership from a name or domain.

Images, builders, volumes, networks, and unrelated containers are preserved. Deployment-attempt temporary/superseded-artifact recovery belongs to #15's separate deployment cleanup ledger/operator workflow; an app retirement outcome must not overwrite that ledger or claim it collected those resources. Host-wide administration retains its existing separate administrator permission. [Project retirement](project-retirement-operations.md) commits visibility for the project and every child together, then reuses this app cleanup/recovery workflow after releasing its multi-app locks.

## Local verification

Set `AUTH_TEST_DATABASE_URL` to a disposable loopback PostgreSQL server and build database/SDK dependencies, then run:

```sh
npm run test:retirement --workspace=web
npm run test:retirement --workspace=api
cd apps/node-manager
go test -count=1 ./...
go vet ./...
# Opt-in, on an initially empty disposable Docker daemon with a local alpine:3.20 image:
NMT_RETIREMENT_DOCKER_SMOKE=1 go test -count=1 -run TestAppRetirementRealDocker .
```

The web suite applies every development migration in an owned temporary schema, exercises authenticated request workflows with the production PostgreSQL DAL and Express/Dockerode transport, restarts owner requests in separate Node processes, and renders the actual app page in JSDOM. Go tests call the authenticated host HTTP handler with a Docker HTTP fixture. Those Docker/GitHub fixtures verify request and recovery behavior; they do not establish real-daemon/provider compatibility. Run the retained worker real-Docker smoke suite on a Docker-capable host. Report actual unavailable infrastructure explicitly.
