# Deployment execution entry point

`apps/worker/src/deployment/execute-deployment.ts` exports
`createDeploymentExecutor(dependencies)`. Construct one executor per worker
process, then call `executeDeployment({ userId, deploymentId })`. The production
BullMQ callback in `apps/worker/src/workers/deployment.worker.ts` and the behavior
tests use this same interface. Importing the execution module does not import
production adapters, validate environment variables, connect to infrastructure,
or register a consumer.

The dependencies cover Docker, GitHub repository access, deployment/log storage,
environment-value retrieval, and registry configuration. Production wiring stays
in the worker registration module. `services/docker.ts` supplies the existing
authenticated Docker connector and binds the Docker command adapter to persistent
log storage. Tests inject fixture adapters at these external boundaries.

## Outcome and delivery contract

- A resolved execution means Docker accepted the new runtime's start and the
  deployment success state/log were saved and replacement retirement finished.
  It does not establish application
  readiness or a zero-downtime guarantee.
- Execution preserves clone, recorded-commit checkout, install, build, image
  commit, and runtime start behavior. Saved configuration reaches install/build
  and runtime through process environments; repository metadata is removed before
  commit. It retains process-local serialization of deployments for the same app. All callers of
  that process must share the executor instance.
- Before runtime start, failure attempts to persist `failed` and its scrubbed diagnostic,
  then rejects with a sanitized error. Failure-reporting errors do not hide that
  diagnostic. Original stacks, causes, requests and command properties are
  discarded. A failed build removes its temporary builder and leaves the previous
  runtime running. Diagnostic redaction encloses the whole execution, failure
  persistence and background work for every caller of the entry point.
- The queue callback returns the execution promise. BullMQ owns acknowledgement
  on resolution and failure/retry handling on rejection. Queue name, payload,
  concurrency (five), three attempts, exponential backoff starting at two
  seconds, and completed/failed retention remain unchanged.
- Runtime log capture and registry publication remain background work after
  success. Builder removal and prior-runtime retirement are awaited inside app
  coordination, after replacement start. Post-start persistence or cleanup
  failures retain the started replacement, report recovery pending, and reject
  to BullMQ for reconciliation without changing a verified start to `failed`.

The [retry recovery increment](deployment-retry-recovery.md) reconciles identified
artifacts on repeated deliveries and after post-start persistence failure.
Separate persisted publication/cleanup outcomes remain later work.
Builder preparation now registers acquired containers inside execution's failure
cleanup scope; failed attempts also release their committed image and save
independent cleanup diagnostics. See [failed deployment cleanup](failed-deployment-cleanup.md)
for ownership, failure behavior, checks, and recovery limits. Ticket #10's
[stable repository lookup and consistent startup working directories](deployment-repository-context.md)
remain in effect.
Ticket #16 documents [environment delivery and image credential removal](deployment-environment-credentials.md).

## Checks and operational use

Run from the repository root after `npm ci` (Node 22.15+ for the import-isolation
test hooks):

```sh
npm test --workspace=worker
npm run check-types:test --workspace=worker
npm run lint --workspace=worker
npm run check-types --workspace=worker
npx turbo run build --filter=worker
```

The deterministic suite exercises success, stage-labeled command failure,
sanitized error propagation, persisted statuses/logs, runtime configuration, and preservation of
unrelated containers through the execution interface. A fresh child process with
no application credentials rejects live adapter imports and checks that execution
imports and exits promptly. The pure diagnostic utility may be imported; live
service adapters remain blocked. The production Docker command adapter is exercised
against a disposable local Docker HTTP fixture, including its hijacked command
stream and nonzero exit. These fixtures do not prove real PostgreSQL, Redis,
GitHub, registry, or Docker daemon compatibility.

For a focused real Docker adapter smoke check on a disposable local daemon:

```sh
npm run test:docker --workspace=worker
```

This opt-in check uses the production builder and command adapter through the
execution entry point. It requires access to the local default Docker socket
(`//./pipe/docker_engine` on Windows, `/var/run/docker.sock` elsewhere), pulls
`node:22-alpine`, and installs the existing Alpine builder packages. It supplies
fixture storage and a deliberately nonexistent local repository path, verifies
clone-command failure, saved diagnostics, and builder removal, and never reaches
image publication or runtime creation. It restricts fallback cleanup to its own
unique builder name after verifying that name was absent. No application
credentials, PostgreSQL, Redis, GitHub access, or host network provisioning are
required. An unavailable daemon fails this explicit check; it is not counted as a
pass or silently skipped.

The implementation environment had no Docker daemon (`ENOENT` for the Windows
pipe), so the real-daemon check could not run beyond its connection attempt.
PostgreSQL/Redis and real registry publication were not exercised by this slice.
