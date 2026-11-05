# Database environment selection

The web app and deployment worker use `@repo/database`. Its runtime pool and
Drizzle Kit configuration now share one selected connection:

| `DB_ENV`                             | Runtime and migration connection | Migration directory                      |
| ------------------------------------ | -------------------------------- | ---------------------------------------- |
| `development` (default when omitted) | `DEV_DATABASE_URL`               | `packages/database/database/development` |
| `production`                         | `PROD_DATABASE_URL`              | `packages/database/database/production`  |

`APP_ENV` and `NODE_ENV` do not select the database. Set `DB_ENV` explicitly for
production, and use the same configuration for migrations, web, and worker.
Restart those processes after changing configuration; selection happens once at
module initialization.

Both database URLs and `BASE_DOMAIN` remain required. URLs must use `postgres://`
or `postgresql://` and include a host; query options such as `sslmode=require`
remain supported. An invalid environment, missing value, or malformed URL throws
an `Invalid environment variables` error naming the field, without printing its
value. Validation runs before the runtime pool is created or migration
configuration is returned. Pool creation is lazy with respect to network access:
successful startup validation does not prove the server is reachable, credentials
work, or migrations have been applied. The first query opens a connection.

## Applying migrations

Supply credentials through the process environment or an untracked `.env` in the
working directory. Drizzle commands run from `packages/database` when invoked
through its npm workspace; they do not load the repository root `.env`
automatically. For example, with development fixture credentials already supplied:

```powershell
$env:DB_ENV = "development"
npm run db-mig --workspace=@repo/database
```

Generation, migration, and Studio all load the same `drizzle.config.ts`. Root
Turbo commands forward the same required database configuration variables.
Existing migration directories and records are preserved. The repository
currently ships the initial development migration; review the selected directory
and prepare the production migration history before applying production
migrations.

Before restarting an existing installation with `DB_ENV=production`, verify its
`PROD_DATABASE_URL` and migration history. Earlier runtime versions always used
`DEV_DATABASE_URL`, even with `DB_ENV=production`; this fix switches runtime access
to the configured production target. It does not copy records between databases.

## Regression checks

```powershell
# Configuration and startup tests: fixture URLs only, no database connection.
npm run test --workspace=@repo/database

# Real PostgreSQL workflow: use a disposable loopback server with CREATEDB rights.
$env:DATABASE_TEST_URL = "postgresql://fixture@127.0.0.1:55434/postgres"
npm run test --workspace=@repo/database
```

Without `DATABASE_TEST_URL`, the PostgreSQL workflow is explicitly skipped. With
it, the test rejects remote hosts and connection-string query overrides, creates
two uniquely named fixture databases, applies the development schema to each,
and seeds distinguishable projects. Authenticated tRPC project listing and
deletion must read and write only the database selected by `DB_ENV`, even when
`APP_ENV` selects the opposite environment. It then drops only those fixture
databases. No deployed production database, WorkOS request, Docker, or Redis is
used. Startup/configuration checks run in separate processes with dotenv pointed
at an absent fixture file, preventing developer `.env` values from participating.
