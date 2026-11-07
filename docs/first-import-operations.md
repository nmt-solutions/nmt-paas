# First import configuration and atomic setup

The import screen submits its editable project name and selected branch through
the authenticated `deployment.deploy` workflow. Project names are trimmed,
nonempty, and at most 80 characters. An explicitly supplied branch must be
nonempty. The repository still determines the app name and generated domains.
Older callers that omit the project name or branch retain the repository-derived
project name and repository default branch. Existing-app redeploy resolves a fresh
GitHub commit from the previous deployment's branch; it does not reuse its old SHA.

GitHub installation/repository access and the selected branch's current commit
are resolved before opening a PostgreSQL transaction. Environment values are
encrypted using the existing AES-256-GCM `iv:authTag:ciphertext` format and the
existing encryption key. One transaction creates the project, app, production
and preview domains, framework configuration, production environment values, and
initial deployment with the resolved commit. Domain collision selection uses the
same transaction. There is no schema migration for this increment.

A rejected local write, including a deferred constraint rejection at commit,
rolls the whole setup back. Setup errors return `INTERNAL_SERVER_ERROR` with
`Unable to initialize project. Check your projects before retrying.` Repository
and commit-resolution failures also create no setup. Database/provider diagnostic
details are not included in these errors. The project list and app details expose
the completed setup; a rejected local write has no new project to find. If the
database connection is lost during COMMIT, its acknowledgment may be uncertain:
inspect the owner's projects before retrying, since an error alone cannot prove
the transaction did not commit.

Host enqueue happens only after PostgreSQL commit, using the existing deployment
and user payload and queue policy. This transaction guarantees local setup
consistency; PostgreSQL and host/Redis acceptance are still separate operations.
If the host rejects or loses its response after the commit, the complete setup
and queued deployment record remain, and this request can return an error. Do not
assume that error means nothing was saved or that the host did not receive work.
Inspect the owner's project/app deployment history before resubmitting. Durable
dispatch recovery and submission idempotency belong to ticket #19; this change
does not claim automatic delivery recovery.

## Verification

With dependencies installed, run from the repository root in PowerShell:

```powershell
npm run build --workspace @repo/database
npm run build --workspace @repo/api-sdk
$env:IMPORT_TEST_DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:5432/postgres'
npm run test:import --workspace web
```

Use a disposable local PostgreSQL server and fixture credentials. The harness
rejects remote URLs and connection-query overrides, applies the development
migrations in a unique schema, and drops that schema afterward. It does not load
developer `.env` files. The test role needs schema/trigger/function creation and
visibility into its own `pg_stat_activity` entries. Turbo also supports
`npm exec turbo run test:import -- --filter=web` with the same database variable.

The suite uses real PostgreSQL and the production Drizzle adapter through the
authenticated tRPC caller. GitHub HTTP responses and host enqueue acknowledgments
are fixtures. Coverage includes a nondefault branch with a slash, the submitted
name and full configuration, both domain writes, every other setup write,
deferred commit rejection, rollback/retry, inaccessible repository/branch, fresh
redeploy commits, input/auth rejection, legacy defaults, and absence of an open
database transaction at repository/commit/host network boundaries. It is not a
live WorkOS/GitHub, real Redis/BullMQ, Docker, or browser interaction test.
