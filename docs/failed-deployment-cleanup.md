# Failed deployment cleanup

The deployment execution entry point owns resources acquired by an unsuccessful
attempt, including acquisition during builder preparation. The production builder
adapter registers its container with execution immediately after Docker creation,
before starting it or installing builder packages. An error pulling the base image
or creating the builder does not authorize removal of a container with the same
name that this attempt did not acquire.

If preparation, cloning, checkout, installation, environment configuration, build,
image commit, runtime creation, or runtime start fails before Docker accepts the
replacement start, execution:

1. Attempts to remove its acquired replacement container and builder.
2. Attempts to remove the image ID returned by its successful image commit, if any.
   Image removal does not use force, so Docker can protect images still referenced
   by other containers or tags. The pulled base image is shared and is retained.
3. Saves `failed` and the scrubbed original diagnostic, then rejects to BullMQ.

Cleanup is awaited before rejection. Each acquired artifact is attempted even if
another removal fails; Docker 404 means that artifact is already cleaned up.
Container removal uses the acquired handles and does not request volume deletion.
The failure path never selects previous runtimes, unrelated apps, images, volumes,
or host resources for removal. The previous runtime remains available when the
replacement cannot start. Start acceptance is the existing success boundary; this
does not establish application readiness.

## Inspecting an incomplete cleanup

Open the failed deployment's persisted history. The original preparation,
command, or start diagnostic remains the attempt failure. A separate line such as
`Cleanup failed for builder <container-id>: ...`,
`Cleanup failed for runtime <container-id>: ...`, or
`Cleanup failed for image <image-id>: ...` identifies an unsuccessful removal.
Both diagnostics are scrubbed in the same per-attempt scope, including registered
clone credentials, decrypted environment values, and the registry password.

These lines survive a history reload. The separate cleanup ledger now records
pending artifact IDs and outcomes before removal, and the workspace displays them
for the selected deployment. Use the documented
[cleanup-only operator recovery](deployment-cleanup-recovery.md) after resolving a
removal problem; it preserves the runtime-start outcome and does not rebuild.
Same-deployment reconciliation after post-start persistence failure or worker
restart is described in [deployment retry recovery](deployment-retry-recovery.md).
There is no host-wide cleanup in either workflow.

If persistence is unavailable, failed-status or diagnostic writes can fail; their
scrubbed errors go to worker output without replacing the original rejection.
Successful starts retain background publication; replacement retirement is now
awaited inside per-app coordination and can be retried through the same delivery.

## Verification

Run the deterministic execution suite, which uses the production command adapter
against a disposable Docker HTTP fixture:

```sh
npm test --workspace=worker
```

It covers preparation before and after acquisition, builder start, preparation
command exit, install/build failures, image commit, runtime creation/start,
partial cleanup, already-absent resources, acquisition conflicts, and preservation
of previous and unrelated resources. These are behavior tests at the same execution
entry point used by the production BullMQ callback, not real Docker checks.

Build the database package, then run the PostgreSQL workflow with
`TEST_DATABASE_URL` pointing to a disposable local server whose fixture user can
create databases:

```sh
npm run build --workspace=@repo/database
npm run test:failures --workspace=worker
npm run test:diagnostics --workspace=worker
```

`test:failures` creates and drops its own database, applies the committed development
migrations, uses production deployment/log DAL adapters, and reloads owner history
through `getUserApp`. Seven scenarios check saved failure and cleanup diagnostics
alongside observable Docker fixture artifacts. It requires a real PostgreSQL
server; without `TEST_DATABASE_URL` it reports a skip. The existing diagnostics
suite also checks the production queue callback and credential redaction.

For a focused check on a disposable local Docker daemon:

```sh
npm run test:docker --workspace=worker
```

The suite retains the clone-failure smoke check and adds failure of builder start
before ordinary command execution. The added check changes the builder executable
at the Docker boundary to a missing fixture path, then uses the real daemon and
production adapter to create, fail to start, and remove the builder. It verifies
failed status, preparation diagnostics, and absence of the acquired builder. It
pulls `node:22-alpine`, checks its unique builder name was absent, and restricts
fallback removal to that builder. It creates no host networks, publishes no image,
and uses no application credentials. Persistence in this Docker-only check is a
fixture; the PostgreSQL workflow above provides separate persistence evidence.

The implementation environment's Docker pipe was unavailable, so the explicit
real-Docker command failed at connection. No daemon compatibility check passed.
Real Redis delivery, GitHub access, and registry publication were not exercised.
