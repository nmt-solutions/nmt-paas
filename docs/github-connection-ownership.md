# Authenticated ownership and GitHub connections

Protected tRPC workflows require an AuthKit **user**, including when AuthKit
returns a context object with `user: null`. Missing users receive `UNAUTHORIZED`
before a router reads or writes domain data. App requests use the authenticated
owner, project lists and changes remain owner scoped, and host inventory/removal
still requires the separate AuthKit `admin` permission. Owning an app does not
grant host administration.

## Configure GitHub user authorization

Before enabling new connections, configure these server environment values for
the same GitHub App as `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`:

- `GITHUB_APP_CLIENT_ID`: the GitHub App's OAuth client ID (different from its app ID).
- `GITHUB_APP_CLIENT_SECRET`: that app's OAuth client secret.

Set the GitHub App's first **Callback URL** to
`https://<web-origin>/connect/github` and enable **Request user authorization
(OAuth) during installation**. This uses the OAuth callback in place of the old
setup-only redirect. The callback must carry `installation_id`, `state`, and
`code`. The existing WorkOS login and `/api/auth/callback` configuration is
independent and stays in place. Missing GitHub OAuth configuration rejects
Connect Github with `PRECONDITION_FAILED`; it does not prevent ordinary sign-in
or use of an existing saved installation.

The server exchanges `code` and checks all pages of `GET /user/installations`
with the returning GitHub user's token. Only an accessible, unsuspended
installation of the configured app can be linked. It also verifies installation
access with the existing installation adapter before saving the result. OAuth
tokens and the client secret stay on the server; tokens are not persisted or
returned to the browser. Provider authorization failures use a generic message.
GitHub explicitly warns that an installation ID in a setup redirect can be
spoofed; see [setup URL security](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url),
[user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
and [accessible installations](https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token).

## Callback lifetime and recovery

Each Connect Github request creates a fresh 256-bit random state. Only its
SHA-256 digest is stored, with a **15-minute** expiration. Starting another
connection replaces the pending state. A successful callback atomically checks
the authenticated owner, active record, pending state and expiration, saves the
installation, marks the attempt completed, and clears the digest and expiration.
Concurrent callbacks can complete an attempt only once. Initial connection
creation/rotation is serialized per owner in a short PostgreSQL transaction;
GitHub requests run outside it.

Missing, malformed, expired, reused, foreign-owner, and inactive state cannot
complete a connection. Numeric connection-row IDs from older callback links are
no longer valid state. Failed verification preserves an already saved
installation. Start Connect Github again after an invalid callback, lost
response, provider failure, or an installation approval that outlasts the
15-minute window. Complete it while signed in as the same platform user who
started it, and authorize a GitHub account with access to that installation.
Setup-only callbacks without an OAuth code cannot establish a connection.

## Schema rollout

Apply the additive migration
`packages/database/database/development/20261105195822_github_connection_state/migration.sql`
before deploying the web change. It adds nullable `connectionStateHash` and
`connectionStateExpiresAt` columns to `GithubAppInstallations`, retaining existing
IDs, installations and lifecycle values. Existing installation records remain
usable; old unfinished callbacks must restart. For owners with legacy duplicate
active rows, connection initiation and reads consistently use the newest row;
this migration does not delete existing records.

Development uses the committed Drizzle development migration history. For an
existing production schema, apply this same additive SQL through the deployment's
approved migration mechanism. The repository did not previously contain a
production migration history: do not generate or run a new baseline against an
existing production database. This ticket does not access production.

## Local verification

Use Node 22.15+ (the standalone Next server-marker hook uses `registerHooks`),
install workspace dependencies, and build the database and API SDK packages:

```powershell
npm ci
npm run build --workspace @repo/database
npm run build --workspace @repo/api-sdk
$env:AUTH_TEST_DATABASE_URL = 'postgres://fixture@127.0.0.1:5432/disposable_test_database'
npm run test:auth --workspace web
```

Use a disposable local PostgreSQL database with permission to create/drop schemas
and a connection URL without query parameters.
The runner refuses nonlocal URLs, creates a unique schema, applies the committed
development migrations, and drops only that schema in `finally`. Its fixtures
override application environment values; developer `.env` files are not loaded.
Tests enter through the production tRPC caller and observe request results,
connection status, visible apps/projects and host HTTP traffic. PostgreSQL is
real; GitHub responses are HTTP-boundary fixtures and host administration uses a
local HTTP fixture, without Docker operations. These tests do not prove live
WorkOS/GitHub redirects or production credential configuration.
