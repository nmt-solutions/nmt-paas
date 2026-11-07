# Suggested architecture improvements

Reviewed on 2026-11-06 against commit `d3b6f23` and the working tree, using the `improve-codebase-architecture`, `codebase-design`, and `writing-for-agents` skills. [architecture.md](architecture.md) describes the current implementation; this document records proposed improvements. Application code, schemas, and runtime configuration have not been changed by this review.

## Recommendation

Start with **deployment execution**. Give deployment ordering, Docker artifact ownership, failure handling, and cleanup one deep module that can be exercised without a live Docker host. This concentrates the most frequently changed implementation and makes failure behavior testable through the same interface used by its caller.

These are candidates, not settled interface designs. Module names describe responsibilities provisionally; exact interfaces, policies, and implementation choices should follow selection and exploration.

| Priority | Candidate                                                                 | Strength        | Main gain                                                                            |
| -------- | ------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| 1        | [Deepen deployment execution](#1-deepen-deployment-execution)             | Strong          | One owner for execution ordering and Docker artifact lifecycle.                      |
| 2        | [Deepen deployment admission](#2-deepen-deployment-admission)             | Strong          | Consistent first import and redeploy, with recoverable persistence-to-queue handoff. |
| 3        | [Deepen app and project retirement](#3-deepen-app-and-project-retirement) | Strong          | Consistent ownership, visibility, and cleanup across deletion entry points.          |
| 4        | [Contain queue compatibility](#4-contain-queue-compatibility)             | Worth exploring | Keep BullMQ encoding and producer parity behind an exercised seam.                   |
| 5        | [Deepen deployment log access](#5-deepen-deployment-log-access)           | Worth exploring | One owner for stream interpretation, cancellation, and bounded log reads.            |

## Scope and evidence

The review followed the last 30 commits rather than starting with a new directory layout. Excluding lockfiles, generated database snapshots, and compiler build information, `deployment.worker.ts` appears in nine of those commits, the control-plane client in seven, `web/src/services/projects.ts` in five, and app details, Docker helpers, and several data-access modules in four each. Those changes include deployment failures, logs, deletion ordering, and the latest Node-to-Go migration.

An independent agent walked the same code with fresh context and checked the candidates against source. No `GLOSSARY.md`, `GLOSSARY-MAP.md`, or `docs/adr/` exists in this snapshot. Domain terms below follow the existing Project, App, Deployment, domain, and environment-value model. No recorded ADR was available to constrain these suggestions.

The deployed control-plane implementation is Go, selected by [the active Compose definition](../packages/docker/api/docker-compose.yml#L5). The Express implementation remains in the npm development path. Preserve the Go migration while making its compatibility obligations explicit; a shared TypeScript implementation cannot be imported into Go.

The review found no automated test files or root test command. Tests described below are proposed completion criteria; no infrastructure was started and no runtime failure was reproduced during this documentation pass.

## 1. Deepen deployment execution

**Strength:** Strong. **Dependencies:** Docker and GitHub adapters; local PostgreSQL integration; BullMQ as the caller's transport adapter.

**Files:** [active worker](../apps/worker/src/workers/deployment.worker.ts), [Docker implementation](../apps/worker/src/services/docker.ts), [GitHub implementation](../apps/worker/src/services/github.ts), [environment decryption](../apps/worker/src/services/env-vars.ts), and [deployment data access](../packages/database/src/access-layer/deployment.dal.ts).

### Friction in the current implementation

Execution policy is spread between the worker and Docker helpers. [executeCommand](../apps/worker/src/services/docker.ts#L62) accepts a Docker container, recovers deployment identity from its name, and writes database logs directly. Its caller must understand daemon handles, container naming, command ordering, and persisted status changes together. This is a broad interface even though the function has few parameters.

[Builder acquisition](../apps/worker/src/workers/deployment.worker.ts#L417) happens before the worker's cleanup `try` block; builder preparation can fail after creating a container. After runtime start, [the worker sets its started flag](../apps/worker/src/workers/deployment.worker.ts#L649) before awaiting database writes, but schedules background cleanup only afterward. Failure in that interval can leave artifacts for a retry using the same names. Success currently means container start, with no application readiness check.

The same implementation also combines mutable app names with repository identity, uses the configured root for install/build but `/app` for startup, and commits the generated `.env` and cloned repository metadata into the image. These are execution policies that need a common owner, not separate utility files for each phase.

### Deepening direction

Make one deep module own the execution attempt from loading an eligible deployment through artifact acquisition, command execution, outcome persistence, and cleanup. Keep the BullMQ callback concerned with delivery and retry reporting. Keep Docker-specific objects, naming, log capture, and cleanup ordering behind an internal seam. Repository resolution should use stable repository identity rather than a display name.

Use a production Docker adapter and a deterministic test adapter capable of failing at lifecycle transitions. Keep PostgreSQL verification local and exercise GitHub through a focused mock adapter. These adapters justify the seams through actual execution and test needs; a generic plugin architecture would add little leverage here.

```text
Before: queue caller -> worker <-> Docker handles, names, logs, database
After:  queue caller -> deployment execution module -> private adapters
```

**Deletion test:** Deleting the current helpers would move daemon operations and log writes into the worker. Splitting the worker into phase files would only move that complexity again. The deepened module earns its depth when its caller no longer coordinates those details.

**Locality and leverage:** One implementation owns artifact recovery and phase invariants. The queue caller and tests cross the same interface; changing Docker mechanics does not require rewriting deployment behavior assertions.

**Tests that establish depth:** Fail builder preparation, build, runtime start, and the database write immediately after start; verify cleanup and the recorded outcome. Retry the same delivery and verify that artifacts are reconciled without a second active replacement. Verify subdirectory startup and stable repository identity. Add a real-Docker smoke check for the production adapter. Decide the readiness and image-publication criteria before asserting a stronger meaning of success.

**First decision to explore:** Which facts make a deployment successful, and which cleanup or publication failures must change that outcome? Preserve single-worker scope initially; distributed coordination needs evidence of a multi-worker requirement.

## 2. Deepen deployment admission

**Strength:** Strong. **Dependencies:** Local PostgreSQL; an owned HTTP adapter for queue handoff; an external GitHub adapter.

**Files:** [project orchestration](../apps/web/src/services/projects.ts), [deployment router](../apps/web/src/trpc/routers/deployment.trpcs.ts), [app router](../apps/web/src/trpc/routers/app.trpc.ts), [import form](../apps/web/src/components/repositories/import-repository.tsx), [control-plane client](../packages/api-sdk/src/client.ts), and project/app/framework/environment/deployment data access.

### Friction in the current implementation

[Initial import](../apps/web/src/services/projects.ts#L148) inserts a project, app, domains, framework configuration, and environment values sequentially. [Deployment creation and queue handoff](../apps/web/src/services/projects.ts#L44) are also separate operations. A later failure can leave partial setup or a queued deployment that was never dispatched.

Branch and naming decisions differ across callers: initial import chooses the repository's default branch despite the submitted branch; the import form's editable project name is not submitted; redeploy resolves the latest deployment's branch again. The SDK has a 15-second timeout and [the app router adds a 20-second timeout](../apps/web/src/trpc/routers/app.trpc.ts#L151) without cancelling the underlying operation. A timeout therefore leaves the caller uncertain whether work was accepted.

### Deepening direction

Concentrate deployment admission in one deep module that owns eligibility, repository and branch resolution, setup persistence, and a recoverable queue handoff. Routers should translate requests and results, with transport-specific errors kept outside the domain implementation. Keep first import and redeploy as related behaviors without forcing their different setup needs into one oversized input.

Use a transaction for related PostgreSQL changes. PostgreSQL and Redis cannot be committed atomically with that transaction: choose an explicit recovery policy for dispatch failures and ambiguous timeouts. A durable dispatch record with idempotent delivery is one option to evaluate; compensation may suffice for the current deployment model. The choice needs a failure guarantee, not an extra relay added by default.

```text
Before: import / redeploy -> different setup decisions -> many inserts -> HTTP
After:  request adapters -> deployment admission module -> persistence + dispatch
```

**Deletion test:** Removing single-query data-access functions mostly moves inserts into callers. Preserve useful orchestration and deepen its missing guarantees rather than adding another forwarding module over the same sequence.

**Locality and leverage:** Branch, identity, acceptance, and recovery rules have one implementation. Import and redeploy gain the same observable acceptance behavior; tests can inject GitHub and dispatch failures at the module's seam.

**Tests that establish depth:** Fail each setup write and verify the agreed transaction outcome. Simulate unreachable control plane and a lost queue acknowledgement. Repeat a request after a timeout and verify the agreed duplicate-delivery behavior. Verify a nondefault branch, a repository rename, and a missing GitHub installation. Use real PostgreSQL for transaction assertions and a test adapter for ambiguous HTTP outcomes.

**First decision to explore:** What durable evidence proves that a deployment request was accepted when the browser sees a timeout?

## 3. Deepen app and project retirement

**Strength:** Strong. **Dependencies:** Local PostgreSQL and the owned deployment-host HTTP adapter.

**Files:** [app deletion](../apps/web/src/trpc/routers/app.trpc.ts#L114), [project deletion](../apps/web/src/trpc/routers/project.trpc.ts#L13), [app queries](../packages/database/src/access-layer/apps.dal.ts), [project queries](../packages/database/src/access-layer/project.dal.ts), [runtime-log authorization](../apps/web/src/app/api/apps/%5BappId%5D/runtime-logs/route.ts), and the control-plane client.

### Friction in the current implementation

Project deletion deactivates one row and does no runtime cleanup. App deletion attempts to remove only the latest successful container, tolerates removal failure, then deactivates the app and its project. The schema supports multiple apps per project, so those entry points encode inconsistent consequences for sibling apps.

[Project listing](../packages/database/src/access-layer/project.dal.ts#L12) filters the parent status without equivalent child filters. [Latest-success lookup](../packages/database/src/access-layer/apps.dal.ts#L34) scopes by creator but does not require an active app or project, and is used by the runtime-log path. Visibility, ownership, and runtime cleanup therefore depend on which module the caller happens to use.

### Deepening direction

Put user-facing retirement rules in one deep module: verify ownership, determine the affected apps, apply consistent visibility changes, and track runtime cleanup to an explicit outcome. App retirement and project retirement may have different consequences; make those consequences deliberate. Keep account-wide Docker administration separate from owner-scoped app actions.

Centralize the active app/project eligibility rule used by subsequent reads and deployment requests. Place Docker cleanup behind the existing host seam, using its production HTTP adapter and a failure-injection test adapter. A database transaction can protect visibility changes; network cleanup needs a retry or compensation policy of its own.

```text
Before: project delete -> flag only; app delete -> container + app + project
After:  deletion callers -> retirement module -> eligibility + visibility + cleanup
```

**Deletion test:** The project deletion function is a shallow single-table update; its name implies a broader operation than its implementation provides. Folding it into a retirement module adds depth only when that module owns the full user-visible result, including cleanup failures.

**Locality and leverage:** Ownership and visibility policy concentrate in one place. List views, log access, deployment admission, and deletion gain the same eligibility rule instead of independently interpreting `resourceStatus`.

**Tests that establish depth:** Retire one app in a two-app project; retire the project itself; attempt retirement as another user; retry after host cleanup fails; verify inactive records cannot restore app/log/deployment access. Assert both PostgreSQL state and host-adapter outcomes through the retirement interface.

**First decision to explore:** Does deleting one app preserve its project and sibling apps, and how should the user see incomplete runtime cleanup?

## 4. Contain queue compatibility

**Strength:** Worth exploring. **Dependencies:** Redis with the actual BullMQ consumer; Go and Express HTTP adapters while both implementations remain supported.

**Files:** [Go queue implementation](../apps/node-manager/main.go#L215), [TypeScript queue producer](../packages/queues/src/index.ts), [request schema](../packages/api-sdk/src/models/deployment-queue.ts), [SDK caller](../packages/api-sdk/src/client.ts#L37), [Express handler](../apps/api/src/controllers/v1/deployments/queue-deployment.ts), and the active worker.

### Friction in the current implementation

The Go migration copied BullMQ's queue representation into handwritten Redis commands and Lua, including the key prefix, events, and retry options. The TypeScript producer uses the BullMQ package. Request validation is also implemented in both languages. Queue correctness now depends on implementation details outside the HTTP caller's view, without a compatibility test proving that either producer's jobs behave the same way.

### Deepening direction

Keep the Go node manager authoritative for the deployed runtime. Put its queue encoding in a focused private adapter behind the existing enqueue seam and define compatibility by behavior observed by the real BullMQ consumer. Separate Gin request handling from that implementation so validation and transport do not own Redis internals. While Express remains supported, exercise both HTTP adapters against the same acceptance scenarios.

This is containment of a real cross-language obligation, not a request to merge Go and TypeScript source. Retiring Express is a separate support decision. Replacing the manual encoding with an official BullMQ-owning process would add an operational hop; consider that only if compatibility evidence makes maintaining the current adapter too costly.

```text
Before: Go handler -> handwritten queue encoding; Express -> BullMQ producer
After:  HTTP adapters -> isolated enqueue implementation -> verified consumer behavior
```

**Deletion test:** Removing duplicated option literals or moving Lua into a new file alone does not improve depth. The module earns leverage when callers and compatibility checks can rely on accepted jobs, retry policy, and failure behavior without learning Redis key layouts.

**Locality and leverage:** BullMQ representation knowledge belongs to one Go adapter rather than HTTP handlers. A compatibility suite protects the existing interface across both runtimes and makes BullMQ upgrades reviewable.

**Tests that establish depth:** Enqueue through Go and Express against disposable Redis; verify the real BullMQ consumer receives the payload, retries with the configured policy, respects pause/resume, and applies retention. Check malformed payloads, authentication, and unavailable Redis through HTTP. A fake Redis implementation would miss the compatibility risk this candidate exists to address.

**First decision to explore:** Is Express still a supported runtime or only migration history? That answer sets the required compatibility matrix.

## 5. Deepen deployment log access

**Strength:** Worth exploring. **Dependencies:** Owned HTTP adapters, Docker log adapters, local PostgreSQL for persisted history, and browser cancellation.

**Files:** [Go runtime stream](../apps/node-manager/main.go#L393), [Express runtime stream](../apps/api/src/controllers/v1/logs/stream-runtime-logs.ts), [SDK stream parser](../packages/api-sdk/src/client.ts#L68), [Next.js forwarding route](../apps/web/src/app/api/apps/%5BappId%5D/runtime-logs/route.ts), [app-detail log presentation](../apps/web/src/components/apps/app-details.tsx#L47), and [app history query](../packages/database/src/access-layer/apps.dal.ts#L20).

### Friction in the current implementation

A runtime line passes through Docker framing, SSE encoding, SDK decoding, Next.js re-encoding, and a second browser parser. The SDK ignores event names, so an upstream error event can become ordinary log data. The browser appends raw JSON data strings and accumulates output without a bound. Separately, app polling reloads all deployment history and logs every 2.5 seconds.

Ownership of stream lifetime is similarly scattered. Express leaves upstream stream destruction commented out. The Go handler stops its ticker and waits for a goroutine ranging over the ticker channel; stopping that ticker does not close its channel, so this teardown has no termination path once the log reader exits. This is a source-derived failure path to reproduce, not a runtime test result from this review.

### Deepening direction

Give log access a deep module that owns interpretation, stream lifetime, and bounded reads. Keep the selected deployment's persisted logs and the latest successful deployment's live runtime output as distinct behaviors. Let transport adapters own framing at each real network seam, with a shared browser consumption implementation instead of parsers embedded in presentation code.

Keep ownership checks on the server and preserve the server-held control-plane credential. A log cursor and bounded client buffer can reduce repeated work; choose history retention and reconnect behavior before adding a new log collector or streaming framework.

```text
Before: Docker -> SSE -> SDK parser -> forwarding -> browser parser + growing history
After:  log access module -> explicit transport adapters -> bounded log presentation
```

**Deletion test:** Removing the SDK parser today forces the forwarding route or browser to absorb its work. The opportunity is to own event meaning and cancellation across the existing seam, not merely rename the same parser twice.

**Locality and leverage:** Event decoding, errors, and shutdown have one owner per transport implementation. Presentation consumes interpreted output, while tests exercise the same read/stream interface across arbitrary chunking and disconnects.

**Tests that establish depth:** Split UTF-8 characters and SSE frames across chunks; distinguish heartbeat, log, and error events; disconnect the browser and verify upstream readers and heartbeat tasks terminate; replace the successful deployment during observation; verify old history stays selected; enforce output bounds. Exercise the active Go transport and any still-supported Express transport.

**First decision to explore:** Should live output reconnect automatically to a replacement deployment, and what history should survive a reconnect?

## Small corrections before a broad refactor

These are observed defects or inconsistencies that can be addressed locally. They do not justify new modules by themselves.

- Align runtime database selection in [the pool constructor](../packages/database/src/index.ts#L7) with `DB_ENV` selection in [migration configuration](../packages/database/drizzle.config.ts#L14). Runtime currently always uses the development URL. Verify both selectors without connecting to production.
- Check the authenticated user explicitly in [tRPC authentication](../apps/web/src/trpc/init.ts#L34), and tie the [GitHub callback state update](../apps/web/src/trpc/routers/github.trpc.ts#L75) to the authenticated owner. These changes should preserve the existing WorkOS session flow.
- Redact the merged environment printed by [Docker setup](../scripts/docker.mjs#L52) and token-bearing or secret-bearing failed commands emitted by [Docker command execution](../apps/worker/src/services/docker.ts#L100). Treat secret handling in committed images as an execution-policy decision in candidate 1.
- Repair and verify stream termination as part of a focused log fix even if candidate 5 is deferred. The shutdown failure does not need to wait for a larger refactor.

## Suggested sequence and completion criteria

1. Correct the database targeting, ownership, redaction, and stream-termination issues with narrow regression checks.
2. Establish a queue compatibility check before changing producer, consumer, or BullMQ versions; this can precede the full candidate-4 refactor.
3. Explore candidate 1, choose its outcome policy, and establish failure-path tests through its interface before changing execution ownership.
4. Follow with admission and retirement according to product priority. Each should own a complete observable behavior with its persistence and network failure policy.
5. Revisit the broader log-access candidate when history growth, reconnect behavior, or log changes justify it.

A candidate is complete when its callers no longer coordinate the absorbed decisions and tests prove those decisions through the module's interface. Additional files, classes, and adapter definitions do not establish depth on their own. Production adapters need focused integration checks; deterministic test adapters cover behavior and failures without reproducing vendor internals.

The proposed changes fit the existing single-host deployment model. A multi-host scheduler, general event bus, generic repository hierarchy, and broad framework/plugin system are outside the evidence-backed scope. Decide exact interfaces and domain terminology after choosing a candidate; record durable choices as ADRs when those decisions are made.
