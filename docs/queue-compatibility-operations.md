# Deployment queue compatibility

The deployed Go node manager remains authoritative. The Express development
server supports the same `POST /api/v1/deployments/queue` contract. Both publish
`deployment-queue` jobs to the `deployment-queue` BullMQ queue, using the default
`bull` prefix. Go's Redis representation remains private to `addBullMQJob`; no
additional queue service is required.

## Request and queue policy

Send the server-held API key as `Authorization: Bearer <API_KEY>` and a JSON body:

```json
{ "userId": "owner-id", "deploymentId": 42 }
```

The existing payload schema is preserved: a nonempty string `userId` and a finite,
nonnegative numeric `deploymentId`. Extra properties are stripped. This ticket
does not tighten the numeric schema to positive integers or add deduplication.
Authentication precedes payload parsing. Malformed JSON, trailing JSON, and
schema errors return a JSON validation envelope with HTTP 400; missing or wrong
bearer credentials return the matching HTTP 401 envelope.

HTTP 201 (`data: true`, message `Deployment Queued`) acknowledges insertion, not
deployment completion. The installed BullMQ worker applies this policy to jobs
from either producer:

| Behavior            | Policy                                                |
| ------------------- | ----------------------------------------------------- |
| Queue paused        | New jobs remain paused until BullMQ resumes the queue |
| Attempts            | Three total attempts                                  |
| Retry backoff       | Exponential, starting at 2 seconds (then 4 seconds)   |
| Completed retention | Latest 100 completed jobs                             |
| Failed retention    | Latest 1,000 terminally failed jobs                   |

Retention is applied when another job reaches that terminal state, rather than
by a timer. It is queue-wide, shared by both producers. Removing retained job
records does not remove application runtimes or PostgreSQL deployment records.

## Redis failure and recovery

Both producers return HTTP 503 with message `Deployment queue is unavailable.`
and null `data`/`errors` when they cannot acknowledge enqueue. Responses omit
Redis addresses, credentials, and raw adapter errors. Go bounds the complete
Redis interaction to two seconds and closes the connection on request
cancellation. Express uses a separate producer connection: a one-second connect
timeout, 1.5-second command timeout, one retry per command, and no offline command
buffer. A connection that is not ready fails the HTTP operation immediately.
The worker's existing indefinite reconnect policy remains unchanged.

Express reconnects in the background; Go opens a new connection for each request.
Both can accept subsequent work after Redis recovers without restarting the HTTP
producer. Health endpoints remain process health checks, not queue readiness
checks.

A failed/timed-out acknowledgement can be uncertain: Redis may have accepted a
write before the reply was lost or delayed. HTTP 503 does **not** prove that no
job exists. This compatibility increment does not add enqueue idempotency or
durable dispatch recovery. Inspect the deployment and queue before manually
resubmitting uncertain work; those recovery guarantees belong to the subsequent
enqueue/admission tickets. Do not clear the queue to recover an outage.

## Running the contract suite

Install dependencies with `npm ci`. Put the repository's declared Go toolchain
(currently Go 1.27.1) and a real Redis server (7+ recommended for this suite) on
PATH, then run:

```sh
npm run test:queue
```

`GO_BIN` and `REDIS_SERVER_BIN` can specify absolute executable paths. The suite
builds the actual node manager, starts both HTTP producers, and uses the
repository's installed BullMQ `Worker` with the production queue identity and
concurrency. Its fixture processor records payloads or fails deliberately; it
does not run Docker deployments. Queue compatibility is verified against the
installed consumer, rather than against a Redis-command mock or a copy of
BullMQ's Lua scripts.

Each run owns a new Redis process, loopback port, fixture password, and temporary
data directory, with persistence disabled. It does not connect to configured
production services, flush an existing Redis database, or require PostgreSQL,
GitHub credentials, or Docker. The API key and Redis password are test fixtures.
Go's Linux memory reporting is unchanged; non-Linux hosts report zero memory
measurements while allowing the same HTTP/queue executable to be exercised.

Coverage includes payload delivery, validation, bearer authentication, pause and
resume, actual 2/4-second retries, 101 completions and 1,001 failures **per
producer**, eviction through BullMQ's job lookup, unavailable Redis, an accepted
TCP connection that never replies, and recovery after a real Redis `CLIENT PAUSE`.
Retention fixtures use BullMQ's `UnrecoverableError` to reach terminal failure
quickly; a separate ordinary-error test exercises all three delayed attempts.

`QUEUE_TEST_PRODUCERS=Express` (or `Go`) selects a partial diagnostic run, clearly
labelled in the suite output. A partial run is not evidence that both producers
passed. Failure to build/start a requested producer fails setup; infrastructure
requirements are not silently skipped. The default run requires both producers.
Run `go test ./...` and `go vet ./...` in `apps/node-manager`, and run the affected
API/queue TypeScript lint, type, and build checks alongside this suite.
