# Repository and working directory during execution

The shared deployment executor uses the accepted Deployment's `repoId` to resolve
the repository through the owner's active GitHub App installation. GitHub's
repository-by-ID response supplies the current clone URL. App display names and
the installation account's login do not select the clone path. Renaming an app or
repository therefore preserves its identity. Moving a repository still requires
the connected installation to have access at its new location.

Execution checks out the Deployment's recorded `commit` in detached mode before
installing dependencies. The stored `branch` describes that deployment; execution
does not resolve its latest head or fall back to it if the recorded commit is
unavailable. Admission of a fresh redeploy remains responsible for selecting a
fresh commit.

The repository is cloned into `/app`. The configured root is relative to that
directory: `./services/api` and `services/api` select `/app/services/api`; an empty
root, `./`, or `/` selects `/app`. Installation, environment-file creation, and
build use that directory. The committed image records the same `WORKDIR`, which
the runtime inherits before executing the configured start command. Start commands
can therefore use paths relative to the app root, such as `node dist/server.js`.

## Diagnosing a failed attempt

- A missing or inactive owner installation produces `GitHub installation not
found` with instructions to connect the GitHub App and grant repository access.
  Another owner's installation is never substituted.
- An installation removed at GitHub produces `GitHub installation unavailable`
  with instructions to reconnect, even if the local connection record remains.
- Repository lookup failure identifies the repository ID and connected
  installation. Check the installation's selected repositories and access after a
  rename, transfer, deletion, or permission change.
- An unavailable recorded commit fails the checkout stage. Inspect the recorded
  commit and repository history; execution does not silently deploy another
  revision.
- An incorrect root normally fails installation/build when project files are
  absent. Correct the app's root and commands before submitting another deployment.

These failures are persisted as failed attempts with scrubbed diagnostics and
reject the execution promise for the existing queue retry policy. Builders are
removed by the existing failure cleanup; previous and unrelated runtimes remain
running when repository lookup or checkout fails. The shared diagnostic scope,
command stage labels, and runtime-start success policy remain in effect.
Environment delivery and credential-file removal are separate lifecycle work;
this change does not add readiness checks or alter publication/cleanup recovery.

## Verification

From the repository root, install dependencies and build the database package
before running the PostgreSQL workflow:

```sh
npm ci --ignore-scripts
npm run build --workspace=@repo/database --workspace=@repo/redis
npm test --workspace=worker
TEST_DATABASE_URL=postgres://fixture@127.0.0.1:55440/postgres npm run test:repository --workspace=worker
TEST_DATABASE_URL=postgres://fixture@127.0.0.1:55440/postgres npm run test:diagnostics --workspace=worker
npm run lint --workspace=worker
npm run check-types --workspace=worker
npm run check-types:test --workspace=worker
npx turbo run build --filter=worker
```

Use a disposable local PostgreSQL server whose fixture user can create/drop
databases. The repository workflow creates a unique database, applies the real
migrations, persists setup/attempts through the production database layer, and
reads results through the app workflow. It exercises the production GitHub and
Docker command adapters through the execution entry point. Only the Octokit and
Docker service boundaries are fixtures; no live GitHub credentials are required.
Without `TEST_DATABASE_URL`, this workflow explicitly skips.

The deterministic Docker HTTP fixture models revision-specific build artifacts
and runtime working-directory inheritance. Its subdirectory test observes the
recorded release's output with a different branch head available. It also checks
unavailable-commit failure and previous-runtime preservation. This models the
behavior contract and does not prove compatibility with a real Docker daemon,
GitHub installation, registry, or Redis/BullMQ service.

`npm run test:docker --workspace=worker` remains the opt-in real Docker preparation
and failure smoke check described in [the execution note](deployment-execution-entry-point.md).
In this implementation environment it failed at connection with
`ENOENT //./pipe/docker_engine`; real-container execution could not be verified.
