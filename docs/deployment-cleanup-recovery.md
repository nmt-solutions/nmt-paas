# Retrying incomplete deployment cleanup

Container start remains the execution success boundary. Cleanup is a separate
outcome: a deployment can show **Container started** and **Cleanup incomplete**
at the same time. Readiness and registry publication are separate concerns.

## Persisted outcome

Apply the additive `20261105213809_deployment_cleanup` migration to the selected
database before rolling out this worker and web version. It adds one nullable
JSONB `Deployments.cleanup` column; existing records and identifiers are preserved.
Apply the complete ordered migration directory, including image publication and
app retirement. The snapshots retain all three outcomes and earlier schema entries.

Cleanup-only recovery leaves recorded image publication untouched. Publication
recovery uses the same production executor and app coordinator, but leaves the
cleanup ledger and artifacts untouched, even when cleanup remains pending. See
[publication recovery](deployment-image-publication.md) for its authenticated
owner/admin workflow.
Use the repository's database environment/migration configuration for the intended
database; do not reset it or point fixture commands at production.

The ledger stores exact Docker IDs, artifact kinds, ownership labels, replacement
identity where relevant, per-artifact results, and scrubbed removal errors. Pending
intent is saved before removal begins. Each result is saved independently. If
Docker removed an artifact but its result could not be saved, the next recovery
accepts the target's 404 as successful cleanup. PostgreSQL write errors use a
generic diagnostic rather than storing SQL statements and ledger parameters.

The owner-authorized application read includes this outcome. The application
workspace displays cleanup for the selected deployment separately from its start
status, including pending errors. A page refresh reads the persisted outcome.
Deployment logs retain the separate removal errors and recovery completion.

`pending` means at least one artifact is pending or failed. `complete` means all
tracked artifacts were removed, were already absent, or were deliberately
preserved because execution adopted them as the serving runtime/image. A null
ledger means cleanup has not been recorded, including pre-migration deployments;
it is not evidence that the host has no leftover artifacts.

## Operator recovery without redeployment

This is an operator command on the single deployment host, under the existing OS
and Docker-socket access controls. It introduces no unauthenticated HTTP endpoint
and no host-administrator API changes. Use the recorded deployment owner's user
ID; a different owner or unavailable deployment is rejected.

Ordinary execution, queued cleanup (`action: "cleanup"`), publication, admission
and log access still require active owned ancestry. The OS-authorized operator
uses the distinct `operation: "cleanup"` path and a limited historical reader for
an already recorded ledger, including after app or project retirement. That read
requires the deployment's owner and creator, app creator, and project's owner and
creator to match. It returns only app coordination identity, owner, start status
and cleanup ledger. It is not an inactive-data option on ordinary reads. Both
reads repeat inside the app lifecycle lock before Docker; denial changes no
status, ledger or history. Cleanup does not load environment values.

1. Let active deployment attempts finish, then stop this host's worker before
   running the command. Production execution, this command, and owner retirement
   share the per-app PostgreSQL lifecycle lock described in
   [app retirement](app-retirement-operations.md). Keep the supported quiesced
   recovery procedure so queued work does not immediately race the operator's review.
   Run only one recovery command at a time. Accepted queue jobs can wait for the
   worker to resume; do not delete or reset the queue.
2. Use the worker's normal environment and the database that stores the target
   deployment. From the repository root, run:

   ```sh
   npm run cleanup:deployment --workspace=worker -- 42 owner-user-id
   ```

   A compiled worker can run `node apps/worker/dist/cleanup-deployment.js 42 owner-user-id`.
   Both paths use the same production executor as BullMQ, selecting only the
   operator cleanup operation. No host HTTP or queue cleanup endpoint is added.

   Inspect the limited persisted result, including after retirement or process
   restart, without accessing Docker:

   ```sh
   npm run cleanup:deployment --workspace=worker -- 42 owner-user-id --status
   ```

   This prints only deployment ID, recorded start status and cleanup ledger.
   Missing ledgers and foreign ownership are rejected; it does not infer targets.

3. Exit **0** means tracked cleanup is complete. Exit **2** means cleanup remains
   pending: inspect the operator's `--status` result (or the active owner's cleanup display/logs), resolve the Docker removal
   problem, and repeat the command. Exit **1** means invalid input, ownership,
   configuration, database/Docker availability, or another recovery error. Repeating
   recovery is safe even after a lost acknowledgement or partial removal.
4. Refresh the active selected deployment, or repeat `--status` for a retired
   deployment, to verify cleanup and unchanged start status. Retirement status
   continues to describe runtime removal separately. Restart the normal worker
   when recovery is finished.

Recovery neither builds nor starts a container, resolves GitHub access, loads app
environment values, publishes an image, nor submits a deployment job. It uses the
local Docker connection without a registry-authentication request. Worker
configuration is still required to load its production adapters. Queue identities,
attempt counts, backoff and retention scripts are unchanged.

## Ownership and preservation

- Builders and failed runtime/images must match the recorded deployment labels
  and artifact role. Removal uses the recorded immutable Docker ID, never a
  name that could now refer to another resource.
- Superseded runtimes must retain their recorded app ownership. The exact
  replacement must still be running with this deployment/app identity before
  an existing old runtime is removed. Unidentified legacy containers and changed
  ownership are preserved with a pending error.
- A previously failed runtime that is now running or has a recorded successful
  start is preserved, as is its image. An adopted runtime remains protected even
  if the application subsequently stops. The superseded failure-cleanup intent
  is resolved as `preserved`.
- Images are removed without force; shared tags or use by other containers can
  make cleanup remain pending. Successful runtime images are not collected here.
- Container removal never requests volume removal. No image/volume/network prune,
  host reset, unrelated-app selection, or project/app retirement occurs.

If the replacement has disappeared or stopped, cleanup deliberately remains
pending rather than guessing which runtime is current. Restore/verify the
replacement through the normal execution recovery procedure before retrying.
If the database was unavailable before intent could be saved, cleanup-only mode
rejects the unavailable ledger with **Deployment not found for cleanup owner**;
use the existing deployment retry/reconciliation
workflow in [deployment-retry-recovery.md](deployment-retry-recovery.md). This
command does not infer historical ownership from diagnostic text.

## Verification and limits

`npm test --workspace=worker` exercises partial cleanup, repeated recovery,
absent artifacts, restart via a fresh executor, changed ownership, current-runtime
and image preservation, and unchanged execution outcomes. The execution module
continues to import without credentials, Docker or a queue consumer.

With a disposable loopback PostgreSQL server in `DATABASE_TEST_URL`, run
`npm run test:cleanup --workspace=web`. It applies every development migration,
checks owner/foreign/anonymous requests, renders persisted pending/complete status,
rejects an outcome write with a real PostgreSQL trigger after Docker-fixture
removal, and finishes recovery through the production operator command in a
separate Node process. Docker HTTP is a deterministic boundary fixture using real
Dockerode transport; this is not evidence of real Docker behavior.

`npm run test:recovery --workspace=worker` retains real PostgreSQL/Redis/BullMQ
production-callback coverage for post-start retry recovery. Other worker
repository, failure, diagnostics and owner deployment-result workflows remain.
`npm run test:docker --workspace=worker` requires a real local Docker daemon.
The implementation host has no Docker engine pipe: all three real-Docker cases
stop at `ENOENT //./pipe/docker_engine`. Live GitHub/registry providers, production
deployments, distributed coordination and Linux-native execution are not verified.
