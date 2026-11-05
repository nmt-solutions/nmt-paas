# Setup and deployment diagnostics

`npm run docker -- setup` reports required variable names, validation results,
service names, Compose actions, and process exit codes. It does not print the
process environment. Child stdout and stderr are captured and scrubbed before
being displayed, including warnings on successful commands. Output appears when
each command completes. Each captured stream has a 16 MiB limit; `ENOBUFS` means
the command exceeded that diagnostic limit, rather than a missing credential.
Environment values are still forwarded to Compose.

Deployment command failures report a stage (builder preparation, clone,
checkout, dependency installation, environment configuration, or build) and exit
code. The command text is omitted, so generated clone URLs and `.env` heredocs
cannot appear in the worker error or BullMQ failure reason. Docker API failures
retain their scrubbed message; raw stacks, causes, request objects and command
properties from the original error are discarded. Deployment history still
records the failed status and diagnostic message.

The worker registers the GitHub installation token before cloning and decrypted
project environment values before writing the environment file. Redaction is
scoped to the deployment attempt, including its background log capture, so five
concurrent queue jobs do not share a growing global credential list. Known
process credentials (including `GITHUB_PAT`, database URLs, private keys, API
keys and Redis passwords) are also scrubbed. Build output and persisted runtime
capture mask registered values, including values split between Docker chunks;
non-sensitive output remains readable. Literal, URI-encoded and JSON-escaped
forms of registered values are covered, as are individual lines of multiline
values. Builder exec requests explicitly use TTY output, matching the builder,
so multiplex headers cannot interrupt a credential before it is scrubbed.
Potential secret prefixes may briefly delay output until the next chunk
or EOF.

Redaction is a diagnostic safeguard, not a universal secret detector. Unknown
values, arbitrary encodings, hashes, partial values, and secrets introduced by
an application or custom command cannot be reliably recognized. Application
authors must avoid deliberately printing credentials. Separate live host log
endpoints, Docker's own logs and shell history, third-party tools run directly,
existing historical records, and image filesystem contents are outside this
change. Removing a generated file also cannot remove intentionally public
values already compiled into application assets. Rotate credentials if an older
diagnostic has exposed them; this change does not rewrite history.

## Verification

Run `npm ci`, then build `@repo/database` and `@repo/redis` before the worker
workflow suite. The setup suite runs the actual CLI in a temporary fixture
directory with a deterministic operating-system process boundary:

```powershell
npm run test:setup-diagnostics
npm run build --workspace @repo/database --workspace @repo/redis
$env:TEST_DATABASE_URL = 'postgres://postgres@127.0.0.1:55436/postgres'
npm run test:diagnostics --workspace worker
```

Use a disposable local PostgreSQL server whose test role can create databases.
The worker suite creates a uniquely named database, applies the existing
migration, and removes that database afterward. It delivers through the
production BullMQ callback, checks failure text returned to the queue and
console output, then reads persisted status and logs through `getUserApp`.
Only the external queue, Docker and GitHub boundaries are deterministic; this
is real PostgreSQL persistence, not a Redis/BullMQ or real-Docker compatibility
test. Without `TEST_DATABASE_URL` the worker suite explicitly skips. The test
runner requires Node 22.15 or newer with experimental module mocking enabled by
the package script.
