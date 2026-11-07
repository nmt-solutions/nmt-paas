# Project retirement and per-app runtime recovery

`project.deleteProject({ projectId })` retires an authenticated owner's project and every child app. One PostgreSQL transaction deactivates the project, apps, app domains and deployments and initializes missing per-app retirement outcomes to `pending`. Any write or commit failure rolls back the whole visibility change and makes no host cleanup request. Existing IDs, configuration, environment values, logs, execution status, cleanup ledgers and publication records are retained. Previously completed app retirement stays complete.

Retired ancestry uses the existing active-resource rule: app/project reads, repository linkage, admission, selected deployment data, latest successful runtime identity and runtime-log access are unavailable. Ordinary queued execution and operation-only cleanup/publication recovery recheck eligibility inside their app turn and cannot recreate a retired runtime. The deployment-attempt cleanup and image-publication outcomes remain separate from retirement.

## Owner discovery and retry

The **Retired projects** panel on `/projects` shows persisted per-app completion and pending messages after active project cards disappear. **Retry cleanup** repeats the project workflow, preserving completed apps and retrying unfinished ones. The same authorized request interfaces are:

```ts
await caller.project.retired();
await caller.project.retirementStatus({ projectId });
await caller.project.deleteProject({ projectId }); // retire or recover
```

The outcome contains project identity, visibility, an aggregate `retirement`, and `apps` with identity, visibility and individual `retirement` outcomes. The aggregate is derived from the durable `Apps.retirement` records: an inactive project is complete only when every child is inactive with completed cleanup. An empty retired project is complete. No additional migration or competing aggregate ledger is needed. Existing inactive projects with active children or null app retirement state remain pending until an owner retries; no historical record is silently backfilled or declared cleaned.

Foreign identities receive `NOT_FOUND` for project status/retirement, and their retired-project listing excludes the project. Anonymous callers receive `UNAUTHORIZED`. Project ownership requires both its user and creator identity; app cleanup retains the established app-creator/project-owner checks. Inconsistent manually linked foreign app records therefore keep the aggregate pending for separately authorized inspection. Their identity/outcome is omitted from the owner view and their runtime cannot be removed through this workflow. The ordinary owner cannot use administrator Docker operations.

## Coordination, failures and restart

The visibility phase opens a dedicated short-lived PostgreSQL session, takes project lock namespace `2222`, then takes existing app lifecycle locks in namespace `2121` in ascending app-ID order. It waits for every in-flight child before changing any visibility. The application query pool is used only after lock acquisition, so waiters cannot consume the pool needed by a lock holder. App execution and app retirement never acquire the project lock. All acquired locks are released by closing the session in `finally`, including on failed transaction/commit.

After the visibility transaction commits, the entire multi-app lock set is released. Cleanup then calls the existing app retirement workflow for each child, taking its normal single-app lock. It does not nest app retirement under an already-held app lock. No transaction spans host HTTP. Other projects can retire or execute while this project waits or cleans up. Deploy web and workers with the existing lifecycle coordination together; account for dedicated lock sessions in the PostgreSQL connection budget.

Cleanup uses the same bounded SDK request and owner-scoped Go/Express `POST /apps/:appId/retire` behavior documented in [app retirement operations](app-retirement-operations.md). Only label-verified immutable runtime container IDs associated with the owner's persisted deployment identities can be removed. Images, builders, volumes, networks and unrelated containers are preserved. Project retirement does not call host-wide administration.

Each app's outcome is persisted independently. A host outage, partial removal, lost acknowledgement or failed outcome write leaves that app pending without skipping later siblings. Host/provider errors are replaced with safe owner messages. A request-process crash after the visibility commit leaves durable pending records; PostgreSQL releases its session locks. After refresh or process restart, repeat the owner workflow. A runtime already removed before acknowledgement is safely observed absent, and completed apps make no further cleanup HTTP request. Recovery never reactivates the project or its children. Recovery is owner initiated; it requires no new queue payload, dispatcher or background process.

## Local verification

Use a disposable loopback PostgreSQL database, then build dependencies and run:

```sh
npm exec turbo run build -- --filter=@repo/database --filter=@repo/api-sdk --filter=@repo/redis
npm run test:retirement --workspace=web
npm run test:retirement --workspace=api
cd apps/node-manager
go test -count=1 ./...
go vet ./...
```

The web suite applies every development migration into an owned temporary schema. It exercises multi-app write/deferred-commit rollback, in-flight/queued exclusion, independent projects, host response loss, per-app outcome persistence failure, partial cleanup, actual killed/restarted request processes, repeated requests, foreign/anonymous denial, more concurrent requests than query-pool slots, and the owner panel over real tRPC HTTP/JSDOM. Its host is the supported Express implementation with Dockerode against a disposable Docker HTTP fixture; Go tests exercise the authoritative authenticated host handler with a Docker HTTP fixture. These establish local adapter behavior, not real Docker-daemon or live-provider compatibility. The existing opt-in Docker smoke suites still require a suitable disposable daemon. Linux cross-compilation is static evidence; Linux-native execution and race testing require an allowed Linux host.
