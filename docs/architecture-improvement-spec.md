# Make deployment lifecycle behavior consistent and recoverable

## Problem Statement

Application owners need to deploy a repository, understand whether a deployment was accepted, follow its output, and remove an application without leaving its runtime or access behind. Today, failures can leave partial application setup, a deployment that appears queued without a confirmed queue handoff, or Docker artifacts that interfere with retrying the same deployment. Installation and startup can use different working directories, and renaming an application can affect repository cloning.

Deletion and log access also depend on the entry point used. Deleting a project and deleting an app have different effects on its runtime and related records. Live log errors can appear as ordinary output, subscriptions can fail to terminate, and history polling repeatedly retrieves growing amounts of data. The deployed Go queue producer and the TypeScript producer rely on the same BullMQ consumer without an exercised compatibility guarantee.

These inconsistencies make failures difficult for owners to recover from and force maintainers to understand decisions scattered across request handling, persistence, queue production, Docker operations, and presentation.

## Solution

Deliver the architecture improvements as a staged program around five deep modules: deployment execution, deployment admission, app and project retirement, queue production, and deployment log access. Each module owns a complete observable behavior behind a small interface, with dependency adapters kept inside its implementation where practical.

Start with focused correctness fixes and deployment execution. Preserve the existing single-host model and deployed Go node manager. Establish behavior tests at the highest useful seams, including compatibility checks with the actual BullMQ consumer. Extend the same consistency to admission, retirement, and logs without making users manage implementation details or introducing an additional network process by default.

The acceptance and lifecycle policies and test seams below were confirmed by the user on 2026-11-06.

## User Stories

1. As an application owner, I want my first deployment to use the branch I selected, so that I deploy the intended code.
2. As an application owner, I want the project name I submit during import to be used, so that the resulting project matches my configuration.
3. As an application owner, I want failed initial setup to leave a coherent result, so that I can retry without repairing partially created records.
4. As an application owner, I want an accepted deployment to have a durable identity, so that I can find its state after the request ends.
5. As an application owner, I want an unavailable deployment host to produce an accurate result, so that I know whether my deployment will still be attempted.
6. As an application owner, I want a timeout to preserve the distinction between rejected and uncertain work, so that I do not accidentally submit duplicate deployments.
7. As an application owner, I want a retry of the same submission to resolve to the same accepted intent, so that a lost acknowledgement does not create duplicate work.
8. As an application owner, I want redeployment to resolve the current head of the previous deployment's branch, so that redeploy remains a fresh deployment rather than an implicit rollback.
9. As an application owner, I want repository identity to survive renaming my app or repository, so that presentation changes do not break cloning.
10. As an application owner, I want inaccessible repositories and missing installations to be reported clearly, so that I can correct the connection before deploying.
11. As an application owner, I want execution to check out the recorded commit, so that the built code matches deployment history.
12. As an application owner, I want installation, build, and startup to honor the configured root directory, so that applications in repository subdirectories run correctly.
13. As an application owner, I want failed dependency installation or build commands to produce a clear failed attempt, so that I can diagnose the problem from its logs.
14. As a deployment operator, I want builder preparation failures to release resources already acquired, so that failed preparation does not accumulate containers.
15. As an application owner, I want the previous runtime preserved when a replacement fails to start, so that a failed release does not unnecessarily stop the application.
16. As a deployment operator, I want a persistence failure immediately after runtime start to have a recoverable outcome, so that a running container is not abandoned between lifecycle steps.
17. As a deployment operator, I want retrying the same queue delivery to reconcile existing artifacts, so that deterministic Docker names do not prevent recovery.
18. As an application owner, I want a successful replacement to retire the previous production runtime, so that the intended deployment becomes the sole replacement for that app.
19. As an application owner, I want saved environment values to reach the build and runtime where required, so that configuration changes take effect after redeployment.
20. As an application owner, I want clone credentials and generated secret files excluded from the committed runtime filesystem, so that deploying does not retain avoidable credential material in the image.
21. As an application owner, I want operational logs to avoid token-bearing commands and environment values, so that troubleshooting does not reveal my credentials.
22. As an application owner, I want deployment status to state what has actually been verified, so that a started container is not presented as an application that passed a readiness probe.
23. As a deployment operator, I want registry publication failure reported independently of runtime start, so that I can recover image publication without misreporting whether the app started.
24. As a deployment operator, I want failed cleanup to remain visible and retryable, so that success does not hide abandoned artifacts.
25. As an application owner, I want overlapping deployments for the same app serialized within the supported worker model, so that replacement operations do not race.
26. As an application owner, I want deleting one app to preserve its project and sibling apps, so that removing one runtime does not hide unrelated applications.
27. As an application owner, I want deleting a project to retire all its apps consistently, so that its children cannot remain accessible through alternate read paths.
28. As an application owner, I want incomplete runtime cleanup to be shown accurately, so that I can distinguish hidden records from resources that have actually been removed.
29. As an application owner, I want repeated deletion requests to be safe, so that an interrupted request can be retried without inconsistent results.
30. As an application owner, I want ownership checked for app and project actions, so that another user's identifiers cannot grant access to my resources.
31. As an application owner, I want retired apps and projects excluded from deployment and log access, so that deletion is respected beyond the list view.
32. As an administrator, I want host-wide Docker administration to retain its separate permission checks, so that owner-scoped retirement does not grant host-wide privileges.
33. As a deployment operator, I want jobs accepted through the Go implementation to be consumable by the installed BullMQ worker, so that the deployed producer remains compatible with execution.
34. As a maintainer, I want the Express development implementation to satisfy the same supported queue contract, so that local development does not conceal differences from the deployed runtime.
35. As a deployment operator, I want paused queues, retry backoff, and job retention to behave consistently for both producers, so that queue operations do not depend on the producer language.
36. As a deployment operator, I want invalid requests, unauthorized requests, and Redis failures to have consistent observable outcomes, so that callers can respond reliably.
37. As an application owner, I want runtime log lines displayed as decoded text, so that JSON quoting and transport framing do not obscure the output.
38. As an application owner, I want stream errors distinguished from log messages, so that I can tell whether my app emitted a line or the log connection failed.
39. As an application owner, I want fragmented frames and UTF-8 characters reconstructed correctly, so that chunking does not corrupt output.
40. As a deployment operator, I want cancelled or completed subscriptions to release upstream readers and heartbeat tasks promptly, so that leaving a log view does not leak resources.
41. As an application owner, I want persisted logs to stay associated with the deployment I selected, so that a new release does not replace the history I am inspecting.
42. As an application owner, I want history reads and live output accumulation bounded, so that long-running applications remain usable without repeatedly loading their entire history.
43. As an application owner, I want reconnect behavior to identify which runtime I am observing, so that replacement deployments do not silently mix output.
44. As an application owner, I want control-plane credentials to stay on the server, so that viewing logs does not expose the deployment host's bearer key.
45. As a deployment operator, I want runtime database selection to agree with migration configuration, so that the selected environment targets the intended database.
46. As an application owner, I want GitHub installation callbacks tied to my own connection attempt, so that a callback cannot modify another user's installation record.
47. As a deployment operator, I want setup diagnostics to omit complete environment dumps, so that configuring the host does not print its secrets.
48. As a maintainer, I want the deployed Go implementation preserved during these changes, so that architecture work does not silently reverse the runtime migration.
49. As a maintainer, I want deployment behavior importable without registering a live queue consumer, so that I can exercise it in deterministic tests.
50. As a maintainer, I want tests to assert deployment results and artifacts through the caller's interface, so that internal refactors do not require rewriting the behavior suite.
51. As a maintainer, I want production adapters checked with local PostgreSQL, Redis, and focused Docker integration, so that deterministic tests do not become substitutes for compatibility evidence.
52. As a maintainer, I want lifecycle guarantees and operational limitations documented with each increment, so that future work does not rediscover the same implicit rules.

## Implementation Decisions

- **Delivery scope:** Treat the five improvements as a staged program. Correct database targeting, authentication/ownership checks, diagnostic redaction, and stream termination first. Establish queue compatibility checks before changing its producer or consumer behavior. Deepen deployment execution next, followed by admission and retirement; broader log-access work follows the core lifecycle work.
- **Deployment model:** Preserve the existing single-host, production-deployment model and deployed Go node manager. Keep Express compatible while it remains the development runtime. Removing Express requires a separate support decision.
- **Module depth:** Give each behavior one owner. Keep request translation and queue registration outside the domain implementation. Hide Docker handles, naming conventions, vendor framing, and low-level persistence mechanics behind private seams. Add an adapter only when production and test needs justify it.
- **Execution entry point:** Expose one importable deployment-execution interface used by the BullMQ callback and behavior tests. Importing the behavior must not create a queue consumer or require a live Docker connection. The callback owns delivery acknowledgement and retries; the execution module owns attempt outcome and artifacts.
- **Repository and execution context:** Resolve repository access using the stable repository identity. Carry explicit deployment identity into execution and log capture rather than reconstructing it from Docker names. Use a consistent configured working directory for installation, build, and startup, and check out the recorded commit.
- **Artifact ownership:** Track resources as soon as they are acquired, including during builder preparation. A retry reconciles artifacts for the same deployment rather than blindly creating them again. Preserve the previous runtime until the replacement starts, and retain enough outcome information to recover if persistence fails after that start.
- **Success policy:** Preserve container start as the initial definition of execution success. Describe that fact accurately in the interface and user-facing status. A readiness probe and health-based rollback are outside this increment. Registry publication and old-artifact cleanup remain separate outcomes; their failures must be observable and retryable without being confused with a failed start.
- **Environment and credential handling:** Preserve encrypted storage and the web/worker encryption format. Provide required values through controlled build and runtime configuration, remove credential-bearing repository metadata and generated secret files before image commit, and redact sensitive command content from diagnostics. Public values intentionally compiled into application assets cannot be made secret by removing an environment file.
- **Admission consistency:** Honor the submitted branch and project name on first import. Resolve a fresh commit on redeploy. Use a PostgreSQL transaction for related initial setup changes and keep network operations outside the transaction where possible. Accepted work must have a durable deployment identity and a recoverable dispatch intent.
- **Dispatch recovery:** Use a durable dispatch record or equivalent persisted state plus stable idempotency to recover the persistence-to-queue handoff. Define accepted, rejected, and uncertain results explicitly. Lost acknowledgements and response timeouts must not be treated as proof that dispatch never happened. A PostgreSQL transaction alone does not make Redis or HTTP acceptance atomic; no new network process is required by this decision.
- **Retirement policy:** App retirement affects that app and its runtime while preserving the project and sibling apps. Project retirement affects the project and all its apps. Apply a common active-resource and ownership rule to subsequent reads, admission, and log access. Make retirement idempotent; persist visibility changes consistently and expose incomplete host cleanup as a recoverable outcome.
- **Permissions:** Require an authenticated user for user-scoped workflows, verify GitHub connection state belongs to that user, and retain the separate administrator permission for host-wide Docker actions. Owner-scoped retirement must not use host-wide authority to select unrelated resources.
- **Queue compatibility:** Contain Go's handwritten BullMQ encoding in a private adapter. Keep the existing queue payload, queue identity, three-attempt exponential-backoff policy starting at two seconds, and completed/failed retention behavior unless an explicit contract change is approved. Define compatibility through behavior observed by the actual BullMQ consumer, not by matching Redis command sequences.
- **Log meaning and lifetime:** Distinguish log, error, and termination outcomes. Keep Docker framing and SSE framing inside their transport adapters and remove protocol parsing from presentation code. Cancellation or upstream completion must stop the associated readers and heartbeat work without waiting on a channel that cannot close.
- **Log selection:** Persisted history follows the selected deployment. A live subscription remains associated with the successful runtime identified when it starts; a reconnect identifies the runtime it will follow. Automatic migration between runtimes is outside the initial increment. Bound history reads and live buffers, and document the configured limits and truncation behavior.
- **Persistence changes:** Introduce only the persisted dispatch, idempotency, and recovery state needed to meet the agreed outcomes. Preserve existing records and domain identifiers. Exact schema and migration design belongs to implementation review; introduce no generic repository hierarchy.
- **Configuration:** Use the same environment-selection rule for runtime database access and migrations, and make it verifiable without connecting to production. Keep complete environment values out of setup output.
- **Completion:** A module is deepened only when callers stop coordinating the absorbed decisions and behavior tests exercise those decisions through the module's interface. Renaming functions or dividing an implementation into more files does not establish completion.

## Testing Decisions

Good tests assert observable outcomes: accepted deployment identity, persisted lifecycle state, visible resources, emitted log content, replacement artifacts, and terminated subscriptions. They must survive changes to private helpers and avoid asserting helper-call order or copies of vendor internals.

Prefer the existing authenticated request and host HTTP seams. The only new behavior entry point for the first implementation increment is the highest-level execution interface already called conceptually by the queue worker. Its production caller and tests must use the same interface.

| Confirmed test seam                                                         | Behavior covered                                                                                                  | Verification approach                                                                                                                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment-execution interface used by the BullMQ callback                  | Build/start ordering, explicit execution context, artifact ownership, failure recovery, and retry reconciliation. | Deterministic Docker adapter, focused GitHub mock adapter, local PostgreSQL verification, and a focused real-Docker smoke suite.              |
| Existing authenticated application workflows through the tRPC caller        | First import, redeploy, owner eligibility, retirement, selected history, and user-visible acceptance outcomes.    | Local PostgreSQL with transaction checks and injected host/GitHub failure outcomes; assert results through the request interface.             |
| Existing deployed host HTTP interface, with Express checked while supported | Authentication, enqueue compatibility, queue operations, runtime stream meaning, and termination.                 | Disposable Redis with the actual BullMQ consumer, fake Docker HTTP streams for failure/chunking cases, and focused production-adapter checks. |

The multiple seams correspond to existing process and transport responsibilities. Do not introduce a seam for every phase, data-access function, or formatter merely to make it individually testable.

- **Execution:** Exercise builder preparation failure after acquisition, installation failure, build failure, startup failure, persistence failure immediately after startup, repeated delivery, a configured subdirectory, repository/app rename, serialization for the same app, and preservation of the previous runtime. Assert cleanup and recovery outcomes as well as returned status.
- **Admission:** Fail each related setup write, reject dispatch, lose the acknowledgement after acceptance, retry the same submission, select a nondefault branch, rename the repository, and remove GitHub access. Verify transaction results and durable dispatch/idempotency outcomes without contacting external production systems.
- **Retirement:** Use a project containing two apps; retire one app and then the project; repeat requests; use another user's identity; fail host cleanup; and verify that retired resources are excluded from reads, log access, and deployment admission.
- **Queue:** Enqueue through each supported HTTP implementation and observe the real worker's payload, pause/resume behavior, retry/backoff, completion, and failure retention. Verify invalid payloads, bearer authentication, and unavailable Redis. Keep time-sensitive checks bounded and deterministic where possible.
- **Logs:** Split Docker frames, SSE messages, partial lines, and UTF-8 characters across arbitrary chunks. Verify event meaning, decoded output, upstream EOF, cancellation, prompt heartbeat termination, reconnect identity, historical selection, and bounded output. Check the browser's consumption behavior without reading private parser state.
- **Configuration and credentials:** Verify both database environment selections using fixture values, explicit unauthenticated-user rejection, foreign-owner GitHub state rejection, redaction of fixture secrets, and exclusion of avoidable credential files from the committed runtime filesystem.
- **Prior art:** No automated test files, root test command, or CI workflow were found in the reviewed source tree. Existing router callers, host endpoints, queue options, and persisted domain records provide behavior to characterize; add the smallest suitable harness rather than inventing a parallel architecture for tests.
- **Required checks:** Run the affected TypeScript lint, type, and build checks, Go checks using its declared toolchain, and the integration suites needed by the changed adapters. Mark unexercised infrastructure-dependent cases explicitly rather than treating a mock as proof of production compatibility.

## Out of Scope

- A multi-host scheduler, remote-worker selection, distributed coordination, or additional deployment environments.
- A general event bus, workflow framework, plugin architecture, or generic persistence abstraction.
- Replacing Go with TypeScript, merging their source implementations, or retiring Express without a separate support decision.
- A new queue-owning network process solely to avoid testing the existing Go compatibility adapter.
- Application readiness probes, health-based rollback, or a zero-downtime guarantee in the first execution increment.
- A full-featured Dockerfile build path, recursive framework discovery, or new framework presets.
- A new centralized log collector, universal streaming framework, or automatic runtime-subscription migration in the initial log increment.
- Bulk deletion of unrelated Docker resources, destructive host reset, or infrastructure provisioning as part of implementing the spec.

## Further Notes

- This spec synthesizes all five candidates from [suggested-architecture.md](suggested-architecture.md), with [architecture.md](architecture.md) as the current-state reference. Neither source document is replaced by this spec.
- The review is based on commit `d3b6f23` and the working tree on 2026-11-06. Source-derived failure paths have not been reproduced by this specification task.
- No project glossary or ADR directory was present. Use the existing Project, App, Deployment, domain, and environment-value terms. Record durable architecture decisions when implementation choices are confirmed.
- Published as [GitHub issue #3](https://github.com/nmt-solutions/nmt-paas/issues/3) with the `ready-for-agent` label.
- The user confirmed the draft, its test seams, its success/dispatch-recovery/retirement/reconnect policies, and publication on 2026-11-06. These decisions were accepted during specification review rather than during the earlier architecture scan.
