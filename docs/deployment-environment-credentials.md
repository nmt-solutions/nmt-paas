# Deployment configuration and image credentials

Saved project values are selected for the Deployment's environment (`production`
or `preview`) and active resource state. Redeploy after changing them. The worker
continues to read AES-256-GCM values with the existing 32-byte hex
`ENV_ENCRYPTION_KEY` and colon-separated base64 `iv:authTag:ciphertext` format. No
key rotation, database migration, or re-encryption is required. An empty plaintext
has an empty ciphertext segment and remains authenticated by its GCM tag.

The worker supplies each value directly through Docker's exec environment for
installation and build, then through the runtime container's `Env` configuration.
Values containing spaces, quotes, equals signs, shell syntax, or newlines remain
literal values. Commands read configuration from their process environment; the
worker does not generate or source an `.env` file. Update application commands
that explicitly require a platform-generated file to read environment variables.
Install, build, and startup retain the configured root, including subdirectories
such as `/app/services/api`. Runtime configuration is attached when creating the
container; it is not baked into the committed image's environment settings.

Retry reconciliation retains the same structured configuration path. A fresh
execution that adopts an identified runtime reloads and registers configured
secrets before attaching output, without cloning or rebuilding. Reusing an
identified image supplies the selected values through the new runtime's `Env`.
Neither recovery path generates an environment file or changes an adopted
runtime's existing configuration. Owner eligibility is rechecked inside the
existing per-app execution turn before artifact access.

After the recorded revision has been built, the worker removes `/app/.git`,
including the clone URL, repository config, reflogs, and nested metadata, before
committing an image. This happens at the repository root even for a subdirectory
app. Source files, dependencies, and build output remain available for startup.
Git-dependent startup commands must use version information generated during
build instead. Failure at `Remove build credentials` prevents image commit and
runtime creation, marks the attempt failed, rejects delivery for the existing
retry policy, removes the temporary builder, and leaves the previous runtime
serving. Check the builder filesystem's permissions when this stage fails.

All configured values and clone credentials participate in the existing
execution-wide diagnostic redaction, including install/build output, failures,
and background runtime logs. Operator access to the Docker API still exposes a
container's runtime environment. Use the existing host access controls.

Removing credential files cannot make an intentionally public value secret.
Frameworks can compile values such as `NEXT_PUBLIC_*` or `VITE_*` into browser
assets. Those values remain in the application artifacts by design. Application
build scripts can also write private values into files; the worker does not scan
or rewrite arbitrary application output or repository-supplied configuration.
Keep private credentials out of public variables and build-generated assets.

## Verification

From the repository root, with installed dependencies:

```sh
npm run build --workspace=@repo/database --workspace=@repo/redis
npm test --workspace=worker
TEST_DATABASE_URL=postgresql://fixture@127.0.0.1:55466/postgres npm run test:environment --workspace=worker
TEST_DATABASE_URL=postgresql://fixture@127.0.0.1:55466/postgres npm run test:diagnostics --workspace=worker
TEST_DATABASE_URL=postgresql://fixture@127.0.0.1:55466/postgres npm run test:repository --workspace=worker
npm run lint --workspace=worker
npm run check-types --workspace=worker
npm run check-types:test --workspace=worker
npx turbo run build --filter=worker
```

Use a disposable local PostgreSQL server whose fixture user can create/drop
databases. The environment workflow creates a unique database and applies every
ordered development migration. It stores fixture ciphertext in the existing web
writer's format, reads it through the production environment adapter, and calls
the shared executor. It observes literal runtime values, root and subdirectory
working directories, environment selection, empty values, diagnostics, and the
committed filesystem's retained application artifacts and removed credentials.
The public fixture value deliberately survives in a compiled asset. The default
execution suite also covers credential-removal failure before image commit.

PostgreSQL persistence is real. Docker command transport, filesystem snapshots,
build artifacts, and application responses in these workflows are deterministic
fixtures. They do not prove real Docker image/layer contents, container startup,
GitHub, registry publication, or Redis/BullMQ delivery. Without
`TEST_DATABASE_URL`, the PostgreSQL workflows explicitly skip.

The existing `npm run test:docker --workspace=worker` is an opt-in real-daemon
preparation/clone-failure smoke check; it does not cover a successful credential
removal/build/runtime workflow. On this Windows implementation host it failed at
`connect ENOENT //./pipe/docker_engine`. Real-daemon image/layer inspection and
runtime configuration verification remain checks to perform on a Docker-enabled
disposable host.
