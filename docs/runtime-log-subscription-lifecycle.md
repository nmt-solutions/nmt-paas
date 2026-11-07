# Runtime log subscription lifecycle

The Go node manager and supported Express host expose
`GET /api/v1/logs/stream/:deploymentId` behind the existing bearer authentication.
Active subscriptions retain the `: connected` comment, JSON-encoded log data,
and a heartbeat comment every 15 seconds. Docker requests still follow stdout
and stderr with timestamps and `tail=100`.

Each subscription owns its Docker reader and heartbeat work. Docker EOF or a
broken upstream connection ends the HTTP response and releases both. Client
disconnect cancels a pending Docker request, including one still waiting for
response headers, and closes an acquired reader. Go explicitly signals and joins
its heartbeat goroutine: stopping a ticker alone does not close its channel.
It also closes the subscription client's idle Docker HTTP connections on exit.
Express listens to response closure, aborts the Docker request, destroys the
source and demultiplexed streams, and clears its interval. Cleanup is idempotent.

The authenticated web route resolves the owner's deployment before opening the
stream. It owns a separate upstream abort controller so either incoming request
cancellation or cancellation of the outgoing response body stops the SDK/host
subscription. Completion closes the outgoing stream once; late callbacks after
cancellation cannot write into a closed controller. The SDK always cancels and
unlocks its HTTP reader when consumption exits, including consumer exceptions.
The host bearer credential stays in the server-side SDK.

When investigating subscriptions that remain open, check whether the reverse
proxy forwards disconnects and disables response buffering. An idle subscription
with heartbeats is expected while Docker is following a running container. EOF
and disconnect cleanup do not wait for the next 15-second heartbeat. Reopening
the view creates a new subscription using the deployment lookup. The explicit
runtime identity, typed outcomes, shared text consumer, and owner reconnect
workflow are documented in
[runtime log protocol and reconnect](runtime-log-protocol-and-reconnect.md).

## Local regression checks

Install dependencies with `npm ci`. Run `npm run test:runtime-logs` from the repo
root with Node 22.15 or newer. It builds the SDK/database packages and runs the
Express HTTP, SDK HTTP, and web route suites. The web suite uses Node's
experimental module-mocking flag for external WorkOS and PostgreSQL fixtures;
the route, database lookup, SDK, Express endpoint, Dockerode HTTP transport, and both HTTP hops
execute production code. No production credentials or database are needed.

Run the native Go suite from `apps/node-manager` with the declared Go 1.27.1
toolchain on a host that permits execution of the generated test binary:

```sh
go test -count=1 -timeout=20s ./...
go vet ./...
go build ./...
```

Where the toolchain supports the race detector and its native compiler is
available, also run `go test -race -count=1 -timeout=30s ./...`.

The HTTP suites cover EOF, cancellation while Docker opens, repeated active
subscriptions, preserved log output/heartbeats, and interrupted Docker streams.
Termination and upstream-reader release are asserted within one second; Go's
test heartbeat is shortened and Express's host-only heartbeat test advances a
mock clock. The complete web-to-Express-to-Docker-fixture test uses real timers
and exits without remaining subscription intervals.

These are transport integration checks with fake Docker HTTP responses, not a
real Docker-daemon smoke test or a PostgreSQL compatibility test. Host-memory
reporting now uses platform-specific files: Linux keeps its syscall measurements
and other platforms return zero measurements. Ordinary native Windows tests no
longer require the earlier host-memory overlay. Historical run notes retain the
overlay evidence from before this portability change. Cross-compiling the Linux
target is a separate build check; it does not execute the suite. If application
control blocks a generated executable, report that check as blocked and run the
suite on an allowed host without changing or bypassing the host policy.
