# Architecture improvement ticket breakdown

Approved and published on branch `improvements` on 2026-11-06 from [spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). All 21 tickets are published as ready-for-agent sub-issues with their native blockers verified. The parent had no comments or sub-issues at review time; its title, body, labels, and open state were preserved.

## Published breakdown

1. **[T01: Use the selected database for runtime and migrations](https://github.com/nmt-solutions/nmt-paas/issues/4)** — **Blocked by:** None (can start immediately). **Delivers:** Runtime reads and writes and migration commands consistently target the database selected by the configured environment.
2. **[T02: Enforce authenticated ownership and GitHub connection state](https://github.com/nmt-solutions/nmt-paas/issues/5)** — **Blocked by:** None (can start immediately). **Delivers:** Protected application actions and GitHub installation callbacks accept only an authenticated owner, while host-wide administration retains its separate permission check.
3. **[T03: Redact setup and deployment diagnostics](https://github.com/nmt-solutions/nmt-paas/issues/6)** — **Blocked by:** None (can start immediately). **Delivers:** Operators can diagnose setup and command failures without printing complete environments, clone tokens, or generated secret-bearing commands.
4. **[T04: Terminate runtime-log subscriptions cleanly](https://github.com/nmt-solutions/nmt-paas/issues/7)** — **Blocked by:** None (can start immediately). **Delivers:** Closing a log view, upstream completion, or an interrupted connection releases its Docker readers and heartbeat work in both supported host implementations.
5. **[T05: Prove queue compatibility through the real BullMQ consumer](https://github.com/nmt-solutions/nmt-paas/issues/8)** — **Blocked by:** None (can start immediately). **Delivers:** Jobs submitted through deployed Go and development Express demonstrably satisfy the existing worker's queue contract.
6. **[T06: Prefactor execution into an importable deployment entry point](https://github.com/nmt-solutions/nmt-paas/issues/9)** — **Blocked by:** None (can start immediately). **Delivers:** The production queue callback and deterministic behavior tests run a deployment through the same importable execution entry point, preserving current behavior.
7. **[T07: Deploy the recorded repository commit from the configured root](https://github.com/nmt-solutions/nmt-paas/issues/10)** — **Blocked by:** [#9](https://github.com/nmt-solutions/nmt-paas/issues/9). **Delivers:** An app or repository rename does not break deployment, and installation, build, and startup use the intended repository, exact commit, and root directory.
8. **[T08: Clean up failed build and startup attempts](https://github.com/nmt-solutions/nmt-paas/issues/11)** — **Blocked by:** [#9](https://github.com/nmt-solutions/nmt-paas/issues/9). **Delivers:** Failures during preparation, installation, build, or runtime start leave a clear failed attempt and release temporary artifacts while preserving the previous runtime.
9. **[T09: Reconcile repeated deliveries and failures after runtime start](https://github.com/nmt-solutions/nmt-paas/issues/12)** — **Blocked by:** [#8](https://github.com/nmt-solutions/nmt-paas/issues/8), [#11](https://github.com/nmt-solutions/nmt-paas/issues/11). **Delivers:** A delivery retry or persistence failure after container start reconciles the same deployment instead of abandoning it or creating a second active replacement.
10. **[T10: Report container-start success accurately in deployment views](https://github.com/nmt-solutions/nmt-paas/issues/13)** — **Blocked by:** [#9](https://github.com/nmt-solutions/nmt-paas/issues/9). **Delivers:** Owners see that a successful deployment started its container, without an unsupported claim that the application passed a readiness probe.
11. **[T11: Recover image publication without redeploying](https://github.com/nmt-solutions/nmt-paas/issues/14)** — **Blocked by:** [#12](https://github.com/nmt-solutions/nmt-paas/issues/12). **Delivers:** A started app remains accurately reported while owners or operators can see and retry a failed registry publication for the same deployment.
12. **[T12: Retry incomplete Docker cleanup and expose its outcome](https://github.com/nmt-solutions/nmt-paas/issues/15)** — **Blocked by:** [#12](https://github.com/nmt-solutions/nmt-paas/issues/12). **Delivers:** Temporary builders and superseded runtimes that could not be removed remain visible as incomplete cleanup and can be retried safely.
13. **[T13: Apply environment values without retaining build credentials](https://github.com/nmt-solutions/nmt-paas/issues/16)** — **Blocked by:** [#6](https://github.com/nmt-solutions/nmt-paas/issues/6), [#10](https://github.com/nmt-solutions/nmt-paas/issues/10). **Delivers:** Saved environment values reach the build and runtime, while clone credentials and generated secret files are excluded from the committed image filesystem.
14. **[T14: Make first import atomic and honor selected configuration](https://github.com/nmt-solutions/nmt-paas/issues/17)** — **Blocked by:** [#5](https://github.com/nmt-solutions/nmt-paas/issues/5). **Delivers:** Import creates a coherent project/app/deployment setup using the submitted project name and branch, or rolls that setup back as one failed operation.
15. **[T15: Deduplicate host enqueue acknowledgements](https://github.com/nmt-solutions/nmt-paas/issues/18)** — **Blocked by:** [#8](https://github.com/nmt-solutions/nmt-paas/issues/8). **Delivers:** Retrying the same deployment enqueue through Go or Express acknowledges the same tracked work rather than creating duplicate queue jobs.
16. **[T16: Recover accepted dispatch and resolve uncertain submissions](https://github.com/nmt-solutions/nmt-paas/issues/19)** — **Blocked by:** [#12](https://github.com/nmt-solutions/nmt-paas/issues/12), [#17](https://github.com/nmt-solutions/nmt-paas/issues/17), [#18](https://github.com/nmt-solutions/nmt-paas/issues/18). **Delivers:** Import and redeploy have a durable accepted identity and recoverable dispatch intent, so outages and timeouts do not lose accepted work or cause duplicate submissions.
17. **[T17: Apply active-resource eligibility to app workflows](https://github.com/nmt-solutions/nmt-paas/issues/20)** — **Blocked by:** [#5](https://github.com/nmt-solutions/nmt-paas/issues/5), [#9](https://github.com/nmt-solutions/nmt-paas/issues/9). **Delivers:** An inactive app or project cannot be recovered through alternate list/detail/log/deployment paths, including a queued execution request.
18. **[T18: Retire one app without affecting its project or siblings](https://github.com/nmt-solutions/nmt-paas/issues/21)** — **Blocked by:** [#12](https://github.com/nmt-solutions/nmt-paas/issues/12), [#20](https://github.com/nmt-solutions/nmt-paas/issues/20). **Delivers:** Deleting an app retires that app and its owned runtime while preserving the project and sibling apps, with incomplete cleanup visible and recoverable.
19. **[T19: Retire a project and all its apps with recoverable cleanup](https://github.com/nmt-solutions/nmt-paas/issues/22)** — **Blocked by:** [#21](https://github.com/nmt-solutions/nmt-paas/issues/21). **Delivers:** Deleting a project consistently retires all its apps and removes their owned runtimes, while unfinished cleanup remains recoverable.
20. **[T20: Preserve runtime log text, error events, and subscription identity](https://github.com/nmt-solutions/nmt-paas/issues/23)** — **Blocked by:** [#7](https://github.com/nmt-solutions/nmt-paas/issues/7). **Delivers:** Runtime logs appear as decoded text with distinct error/termination outcomes and a clear runtime identity across the host, forwarding route, and browser.
21. **[T21: Bound selected-deployment history and live log buffers](https://github.com/nmt-solutions/nmt-paas/issues/24)** — **Blocked by:** [#23](https://github.com/nmt-solutions/nmt-paas/issues/23). **Delivers:** Owners can inspect old deployment logs and long-running live output without repeated full-history downloads, unbounded browser memory, or losing their selected deployment.

## Slicing and execution rules

- Each ticket delivers one demonstrable operational or user-facing behavior through every affected part of the application. Unchanged tiers do not need artificial edits.
- T06 is behavior-preserving prefactoring and lands before execution changes that use its entry point. Other tickets include any narrow prefactoring needed to deliver their own behavior; none is a schema-only, UI-only, or test-scaffolding-only tranche.
- Blockers are functional prerequisites. Numerical order is a proposed implementation order, not an instruction to serialize independent work. Shared files may require coordination, which is not by itself a blocking edge.
- The initial frontier is T01–T06. Once their blockers are complete, remaining branches can advance independently. In particular, the database fix is not an artificial prerequisite for every ticket using local PostgreSQL fixtures.
- Each ticket fits one focused implementation context. It includes behavior tests through the confirmed execution/request/host seams, the production-adapter integration needed for its behavior, applicable lint/type/build/Go checks, and an update to the relevant lifecycle or operational documentation. These shared requirements cover spec stories 50–52.
- Tests use fixture credentials and disposable/local dependencies; the work does not require production access, host resets, or removing unrelated Docker resources.
- Keep Go authoritative in the deployed model and Express compatible while supported. Preserve the approved single-host scope, container-start success policy, and other confirmed spec decisions.
- No codebase-wide mechanical rename is required by this plan. Refactoring keeps existing callers usable until their owning ticket migrates them, so each ticket can land with its checks passing.

## Approved ticket bodies

The reviewed ticket bodies are retained below. Published issues use the issue-template headings and native blocking relationships; bodies with native blockers omit the textual Blocked by section. The index above links each review ID to its published GitHub issue.

## T01: Use the selected database for runtime and migrations

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 45; shared completion requirements cover stories 50–52.

### What to build

Runtime reads and writes and migration commands consistently target the database selected by the configured environment.

### Acceptance criteria

- [ ] Development and production configurations select their respective configured database in both runtime startup and migration configuration.
- [ ] A workflow using fixture configuration proves runtime access uses the selected connection rather than a hard-coded development connection.
- [ ] Invalid or missing required configuration fails clearly; verification never connects to a production database.
- [ ] Regression coverage and operational documentation describe selection and startup behavior.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

None (can start immediately).

## T02: Enforce authenticated ownership and GitHub connection state

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 30, 32, 46; shared completion requirements cover stories 50–52.

### What to build

Protected application actions and GitHub installation callbacks accept only an authenticated owner, while host-wide administration retains its separate permission check.

### Acceptance criteria

- [ ] An AuthKit context without a user is rejected by protected workflows before domain data is read or written.
- [ ] A GitHub callback can update only the authenticated owner's active connection attempt and a valid accessible installation.
- [ ] Missing, malformed, reused, or foreign-owner callback state cannot modify another connection record.
- [ ] App/project ownership and administrator-only host actions are verified through authenticated request entry points; ordinary sign-in and valid connection remain usable.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

None (can start immediately).

## T03: Redact setup and deployment diagnostics

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 21, 47; shared completion requirements cover stories 50–52.

### What to build

Operators can diagnose setup and command failures without printing complete environments, clone tokens, or generated secret-bearing commands.

### Acceptance criteria

- [ ] Setup output contains useful validation and stage information without dumping the process environment or configured secret values.
- [ ] Execution errors and persisted deployment messages redact token-bearing clone commands and generated environment values while retaining actionable stage and exit information.
- [ ] Tests use fixture secrets to verify setup output, thrown errors, and persisted error messages through their production entry points.
- [ ] Unrelated non-sensitive diagnostics remain available; the operational notes explain redaction limits.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

None (can start immediately).

## T04: Terminate runtime-log subscriptions cleanly

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 40; shared completion requirements cover stories 50–52.

### What to build

Closing a log view, upstream completion, or an interrupted connection releases its Docker readers and heartbeat work in both supported host implementations.

### Acceptance criteria

- [ ] The active Go and supported Express streaming endpoints terminate after upstream EOF and client cancellation within a bounded test deadline.
- [ ] Heartbeats stop without waiting for a ticker channel that cannot close, and underlying Docker stream readers are closed.
- [ ] Cancellation propagates from the browser-facing forwarding route through the SDK to the host stream; repeated open/close cycles leave no owned subscription work behind.
- [ ] Existing log output and heartbeat behavior are preserved for active subscriptions, with HTTP-stream regression coverage for both runtimes.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

None (can start immediately).

## T05: Prove queue compatibility through the real BullMQ consumer

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 33, 34, 35, 36, 48, 51; shared completion requirements cover stories 50–52.

### What to build

Jobs submitted through deployed Go and development Express demonstrably satisfy the existing worker's queue contract.

### Acceptance criteria

- [ ] Each HTTP producer submits the supported payload to disposable Redis and the repository's actual BullMQ consumer receives it.
- [ ] Pause/resume, three-attempt exponential backoff starting at two seconds, and completed/failed retention are exercised without replacing Redis with a command mock.
- [ ] Authentication, malformed payloads, and unavailable Redis have consistent observable outcomes across both producers; fix demonstrated incompatibilities without changing valid caller payloads.
- [ ] Go queue encoding is contained behind its existing private seam, with no additional queue-owning network process and no reversal of the deployed Go migration.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

None (can start immediately).

## T06: Prefactor execution into an importable deployment entry point

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 49, 50; shared completion requirements cover stories 50–52.

### What to build

The production queue callback and deterministic behavior tests run a deployment through the same importable execution entry point, preserving current behavior.

### Acceptance criteria

- [ ] Importing execution behavior neither registers a live queue consumer nor opens Docker, Redis, GitHub, or database connections as an import side effect.
- [ ] The production BullMQ callback delegates execution to one behavior interface while retaining delivery acknowledgement and retry reporting.
- [ ] A representative successful production deployment and command failure are characterized through that interface with injected dependency adapters.
- [ ] The existing callback is migrated to the entry point in this ticket; no unused parallel implementation or generic phase framework is introduced.
- [ ] The minimal test harness and focused production-adapter smoke check needed to verify the slice ship with it.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

None (can start immediately).

## T07: Deploy the recorded repository commit from the configured root

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 9, 10, 11, 12; shared completion requirements cover stories 50–52.

### What to build

An app or repository rename does not break deployment, and installation, build, and startup use the intended repository, exact commit, and root directory.

### Acceptance criteria

- [ ] Repository access resolves from the stable repository identifier rather than the app's mutable display name or an assumed owner.
- [ ] Execution checks out the recorded commit and reports inaccessible repositories or missing installations as clear attempt failures.
- [ ] Install, build, and runtime startup consistently use the configured root, including a non-root application directory.
- [ ] Behavior tests exercise app/repository rename, the selected commit, a subdirectory app, and denied GitHub access through the execution entry point.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T06: Prefactor execution into an importable deployment entry point** — Provides the shared execution entry point and explicit execution context.

## T08: Clean up failed build and startup attempts

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 13, 14, 15; shared completion requirements cover stories 50–52.

### What to build

Failures during preparation, installation, build, or runtime start leave a clear failed attempt and release temporary artifacts while preserving the previous runtime.

### Acceptance criteria

- [ ] Resource ownership begins at acquisition, including builder preparation before ordinary command execution starts.
- [ ] Failure at each preparation/install/build/start transition records an actionable failed attempt and removes the temporary resources it owns.
- [ ] A replacement that cannot start leaves the previous runtime available; unrelated apps and host resources are untouched.
- [ ] Cleanup failure remains distinguishable from the original command/start failure rather than hiding it.
- [ ] Failure-injection tests assert persisted outcomes and observable artifacts, supplemented by a focused real-Docker check.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T06: Prefactor execution into an importable deployment entry point** — Establishes one owner for execution artifacts and failure injection.

## T09: Reconcile repeated deliveries and failures after runtime start

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 16, 17, 18, 25; shared completion requirements cover stories 50–52.

### What to build

A delivery retry or persistence failure after container start reconciles the same deployment instead of abandoning it or creating a second active replacement.

### Acceptance criteria

- [ ] Failure immediately after runtime start has a recoverable persisted or discoverable outcome, including failure of the subsequent status/log write.
- [ ] Retrying the same deployment adopts or reconciles its identified artifacts and does not create a second active replacement.
- [ ] Previous production containers are retired only after replacement start; a successful retry converges to the intended runtime.
- [ ] Overlapping deployments for one app serialize within the supported single-worker process, release coordination state, and do not serialize unrelated apps unnecessarily.
- [ ] Tests exercise actual queue retry behavior, post-start persistence failure, existing Docker names, and same-app concurrency through the execution interface.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T05: Prove queue compatibility through the real BullMQ consumer** — Establishes the actual BullMQ redelivery/retry contract used by this slice.
- **T08: Clean up failed build and startup attempts** — Provides artifact ownership and failed-attempt cleanup to reconcile.

## T10: Report container-start success accurately in deployment views

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 22; shared completion requirements cover stories 50–52.

### What to build

Owners see that a successful deployment started its container, without an unsupported claim that the application passed a readiness probe.

### Acceptance criteria

- [ ] The execution outcome and public deployment views describe the confirmed container-start guarantee consistently.
- [ ] App details, deployment history, and dashboard wording do not present a readiness or uptime measurement that was not performed.
- [ ] Existing deployment identifiers and supported status behavior remain compatible; no readiness probe or health-based rollback is added.
- [ ] A workflow test follows a completed execution into its displayed result and verifies the documented guarantee.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T06: Prefactor execution into an importable deployment entry point** — Provides the execution outcome consumed by existing deployment views.

## T11: Recover image publication without redeploying

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 23; shared completion requirements cover stories 50–52.

### What to build

A started app remains accurately reported while owners or operators can see and retry a failed registry publication for the same deployment.

### Acceptance criteria

- [ ] Registry publication has a recorded outcome distinct from runtime start, visible through an appropriate authenticated deployment view.
- [ ] A publication failure does not convert a successfully started runtime into a reported startup failure or expose registry credentials.
- [ ] Retry resumes publication of the same identified image without rebuilding or starting another runtime, including after worker restart.
- [ ] Owner/administrator checks govern recovery actions, and successful retry clears the outstanding publication failure.
- [ ] Failure/restart/retry coverage exercises the execution interface and a focused registry-adapter check.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T09: Reconcile repeated deliveries and failures after runtime start** — Provides durable/discoverable attempt identity and safe execution reconciliation.

## T12: Retry incomplete Docker cleanup and expose its outcome

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 24; shared completion requirements cover stories 50–52.

### What to build

Temporary builders and superseded runtimes that could not be removed remain visible as incomplete cleanup and can be retried safely.

### Acceptance criteria

- [ ] Cleanup success/failure is recorded separately from runtime-start success and remains visible after a process restart or page refresh.
- [ ] A retry removes only artifacts owned by the deployment and treats resources already absent as successfully cleaned up.
- [ ] The current runtime and unrelated apps, images, volumes, and host resources are preserved.
- [ ] An authenticated recovery action or documented operator workflow retries cleanup without rebuilding or redeploying the app.
- [ ] Tests cover partial cleanup, repeated recovery, restart, and failed removal while asserting artifacts and user-visible status.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T09: Reconcile repeated deliveries and failures after runtime start** — Provides stable artifact identity and recovery semantics for follow-up work.

## T13: Apply environment values without retaining build credentials

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 19, 20, 21; shared completion requirements cover stories 50–52.

### What to build

Saved environment values reach the build and runtime, while clone credentials and generated secret files are excluded from the committed image filesystem.

### Acceptance criteria

- [ ] The existing encrypted storage format and encryption key compatibility are preserved.
- [ ] Configured values are supplied to the build and runtime where required, including a subdirectory app, without relying on a generated secret file remaining in the image.
- [ ] Credential-bearing repository metadata and generated secret files are removed before image commit; required application artifacts remain usable.
- [ ] Fixture-secret tests inspect the committed filesystem and diagnostics, then verify the deployed app receives its runtime configuration.
- [ ] Document that intentionally public values compiled into application assets cannot be made secret by removing an environment file.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T03: Redact setup and deployment diagnostics** — Provides the diagnostic redaction used while handling build/runtime credentials.
- **T07: Deploy the recorded repository commit from the configured root** — Provides the resolved repository identity and consistent execution root.

## T14: Make first import atomic and honor selected configuration

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 1, 2, 3, 8, 10; shared completion requirements cover stories 50–52.

### What to build

Import creates a coherent project/app/deployment setup using the submitted project name and branch, or rolls that setup back as one failed operation.

### Acceptance criteria

- [ ] The import form submits its editable project name and selected branch; persisted setup and the resolved deployment commit reflect both.
- [ ] Related project/app/domain/framework/environment/deployment setup is committed consistently in PostgreSQL, with external repository resolution outside the transaction where practical.
- [ ] Failure at each local setup write rolls back the related setup and produces a clear request result.
- [ ] Existing-app redeploy still resolves the current head of its previous branch rather than silently rolling back to an old commit.
- [ ] Authenticated workflow tests use local PostgreSQL and a GitHub adapter to exercise a nondefault branch, write failures, and inaccessible repositories.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T02: Enforce authenticated ownership and GitHub connection state** — Provides the authenticated owner and verified GitHub connection used by admission.

## T15: Deduplicate host enqueue acknowledgements

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 7, 33, 34, 35, 36; shared completion requirements cover stories 50–52.

### What to build

Retrying the same deployment enqueue through Go or Express acknowledges the same tracked work rather than creating duplicate queue jobs.

### Acceptance criteria

- [ ] A stable deployment-derived delivery identity is honored by both supported producers without changing the valid user/deployment payload.
- [ ] Concurrent or repeated identical enqueue requests converge on the same tracked work; conflicting reuse is rejected clearly rather than replacing its payload.
- [ ] An acknowledgement lost after queue acceptance can be retried safely while the queue retains that job.
- [ ] Existing pause/resume, retry/backoff, and retention behavior passes the real Redis/BullMQ compatibility suite.
- [ ] Document the tracked-job retention limit of producer deduplication; execution reconciliation remains responsible for redeliveries after that record expires.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T05: Prove queue compatibility through the real BullMQ consumer** — Provides the real-consumer compatibility suite that protects both producers.

## T16: Recover accepted dispatch and resolve uncertain submissions

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 4, 5, 6, 7, 8; shared completion requirements cover stories 50–52.

### What to build

Import and redeploy have a durable accepted identity and recoverable dispatch intent, so outages and timeouts do not lose accepted work or cause duplicate submissions.

### Acceptance criteria

- [ ] Related admission state and a recoverable dispatch intent are persisted consistently before acceptance is reported; the same stable submission identity resolves to the same accepted deployment.
- [ ] Accepted, rejected, and uncertain results are distinguished in the request contract and UI; retrying after a timeout preserves the submission identity.
- [ ] Host/Redis outages or response loss after enqueue leave recoverable intent, and dispatch resumes after recovery or process restart without requiring a new deployment submission.
- [ ] Recovery runs within the existing deployment model without a new queue-owning network process or a network request held inside a long database transaction.
- [ ] Real PostgreSQL/Redis workflow tests cover rollback, unavailable host, lost acknowledgement, duplicate submissions, restart, and eventual delivery of the accepted intent.
- [ ] Operational notes explain how owners find the accepted deployment and how pending dispatch is observed and recovered.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T09: Reconcile repeated deliveries and failures after runtime start** — Makes repeated deliveries safe when dispatch recovery cannot prove whether a job already ran.
- **T14: Make first import atomic and honor selected configuration** — Provides atomic admission of the initial project/app/deployment setup.
- **T15: Deduplicate host enqueue acknowledgements** — Makes an ambiguous host acknowledgement safely retryable.

## T17: Apply active-resource eligibility to app workflows

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 30, 31, 44; shared completion requirements cover stories 50–52.

### What to build

An inactive app or project cannot be recovered through alternate list/detail/log/deployment paths, including a queued execution request.

### Acceptance criteria

- [ ] A common ownership and active-app/active-project eligibility rule is enforced by app detail, repository lookup, deployment admission, and execution.
- [ ] Project listings exclude inactive children, and latest-success/runtime-log access cannot bypass the app or project's active status.
- [ ] Unauthenticated and foreign-owner requests disclose no private data; the host credential remains server-held.
- [ ] Tests exercise an inactive parent with an otherwise active child, an inactive app, foreign ownership, and delivery of queued work after retirement through the confirmed request/execution seams.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T02: Enforce authenticated ownership and GitHub connection state** — Provides authenticated ownership semantics for user-scoped actions.
- **T06: Prefactor execution into an importable deployment entry point** — Provides the execution entry point that enforces eligibility for queued work.

## T18: Retire one app without affecting its project or siblings

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 26, 28, 29, 30; shared completion requirements cover stories 50–52.

### What to build

Deleting an app retires that app and its owned runtime while preserving the project and sibling apps, with incomplete cleanup visible and recoverable.

### Acceptance criteria

- [ ] Owner-authorized app retirement deactivates that app while the project and sibling apps remain visible, deployable, and running.
- [ ] All runtime artifacts selected for removal belong to the retiring app; unrelated Docker resources are preserved.
- [ ] Visibility changes are consistent and repeated retirement requests are idempotent; queued/in-flight retries cannot restore the retired app.
- [ ] Failed host cleanup is persisted and shown in an appropriate owner-accessible retirement result/status view, with a safe retry path after refresh or restart.
- [ ] A two-app project workflow demonstrates app retirement, sibling preservation, host failure/recovery, repeated requests, and foreign-owner denial.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T09: Reconcile repeated deliveries and failures after runtime start** — Supplies reconciliation of in-flight/repeated execution so retirement cannot be undone by a retry.
- **T17: Apply active-resource eligibility to app workflows** — Provides consistent visibility and eligibility rules for retired resources.

## T19: Retire a project and all its apps with recoverable cleanup

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 27, 28, 29, 31, 32; shared completion requirements cover stories 50–52.

### What to build

Deleting a project consistently retires all its apps and removes their owned runtimes, while unfinished cleanup remains recoverable.

### Acceptance criteria

- [ ] Project and child-app visibility changes commit consistently, and every affected app is excluded from subsequent reads, log access, admission, and queued execution.
- [ ] Runtime cleanup uses the established app-retirement behavior and retains per-app completion/failure outcomes without stopping unrelated projects.
- [ ] Repeated project retirement and recovery after partial host failure converge safely to the same retired state.
- [ ] Owners can inspect and retry incomplete cleanup through an authorized outcome view or workflow; host-wide administration remains separately permissioned.
- [ ] A multi-app project integration test covers rollback, partial cleanup, restart, repeated requests, and preservation of another user's project.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T18: Retire one app without affecting its project or siblings** — Provides the app-retirement behavior and observable cleanup outcomes to compose.

## T20: Preserve runtime log text, error events, and subscription identity

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 37, 38, 39, 40, 43, 44; shared completion requirements cover stories 50–52.

### What to build

Runtime logs appear as decoded text with distinct error/termination outcomes and a clear runtime identity across the host, forwarding route, and browser.

### Acceptance criteria

- [ ] Supported Go and Express transports reconstruct fragmented Docker output and UTF-8 text, with log/error/termination meaning preserved across SSE forwarding.
- [ ] TypeScript transport consumption has shared protocol semantics rather than presentation-embedded duplicate parsers; the browser does not display JSON quoting as log text.
- [ ] A subscription stays tied to the identified successful runtime; reconnect identifies its runtime and does not silently mix replacement-deployment output.
- [ ] Control-plane credentials remain on the server and cancellation/EOF continues to release all subscription resources.
- [ ] End-to-end stream tests cover split frames, partial lines, heartbeats, typed errors, EOF, cancellation, and explicit reconnect behavior without asserting private parser state.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T04: Terminate runtime-log subscriptions cleanly** — Provides correct cancellation and termination behavior to preserve during protocol consolidation.

## T21: Bound selected-deployment history and live log buffers

### Parent

[Spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3). Spec stories: 41, 42, 43; shared completion requirements cover stories 50–52.

### What to build

Owners can inspect old deployment logs and long-running live output without repeated full-history downloads, unbounded browser memory, or losing their selected deployment.

### Acceptance criteria

- [ ] History reads are paged or cursor-based, bounded, and scoped to the selected deployment rather than reloading every deployment's logs during routine app polling.
- [ ] New deployments do not replace the selected historical release or reset its log position.
- [ ] Live output accumulation is bounded with explicit truncation behavior and documented configured limits.
- [ ] The view preserves the established runtime identity/reconnect behavior while receiving new output and switching between persisted history and live logs.
- [ ] Workflow tests exercise growing history, ongoing polling, new releases, truncation, and reconnect while asserting requested data volume and visible selection.
- [ ] Verify this behavior through the confirmed test seams, run the affected checks, and update its lifecycle or operational documentation.

### Blocked by

- **T20: Preserve runtime log text, error events, and subscription identity** — Provides the interpreted log stream and stable subscription identity used by the bounded view.

## Coverage and publication

All 52 spec stories are covered by the per-ticket references and shared completion requirements. There are 21 tickets and 21 blocking edges, with no cycles or redundant transitive blocker declarations.

Published all 21 `ready-for-agent` sub-issues under [spec issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3) in dependency order. Verified every issue body, title, open state, label, parent relationship, and all 21 native blocking edges. The parent's title, body, labels, and open state are unchanged.

Use [GitHub's native sub-issue relationships](https://docs.github.com/en/rest/issues/sub-issues) and [native blocking dependencies](https://docs.github.com/en/rest/issues/issue-dependencies), whose read endpoints are available for this repository. For tickets with native blockers, omit the textual Blocked by section from the published body; for root tickets, retain “None (can start immediately).” Verify every child, label, body, and blocking edge after publication.

The GitHub connector does not expose the native relationship operations, and its issue-write integration was inaccessible during spec publication. The authenticated GitHub CLI is available for the required publication operations. No parent-issue edit or closing action is part of this task.

The user approved all 21 slices and their blocking edges before publication, as required by the [to-tickets skill](../.agents/skills/to-tickets/SKILL.md). The initial implementation frontier is issues #4-#9; the remaining issues become available when their native blockers are completed.
