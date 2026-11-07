# Deployment enqueue acknowledgements

Go and Express use the same deployment-derived BullMQ job ID for
`POST /api/v1/deployments/queue`. The existing bearer authentication and payload
remain unchanged:

```json
{ "userId": "owner-id", "deploymentId": 42 }
```

The identity depends only on the numeric deployment ID. A different owner cannot
create a second job by reusing that deployment ID. Both producers preserve the
first stored payload; extra request properties are still stripped.

| HTTP result                                                   | Meaning                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 201, `Deployment Queued`, `data: true`                        | This payload has a tracked job, either newly inserted or already retained.                 |
| 409, `Deployment is already queued with a different payload.` | This deployment's retained job has a conflicting payload. Nothing is replaced or requeued. |
| 503, `Deployment queue is unavailable.`                       | The producer could not acknowledge the operation. Acceptance can be uncertain.             |

Error envelopes retain null `data` and `errors`. Acknowledging a duplicate does
not restart, reset attempts, update options, or change the payload of the tracked
job. This applies while it is waiting, paused, active, delayed for retry,
completed, or terminally failed. A 201 therefore establishes queue tracking,
not deployment success or a new execution attempt. In particular, resubmitting
a retained failed job does not reset its exhausted retry budget.

## Retry and inspect

After a response timeout, lost connection, or uncertain 503, retry the **same**
`userId` and `deploymentId`. Concurrent requests and requests to either supported
producer converge through Redis's atomic job insertion. Producer restarts do
not lose this identity. A 409 requires resolving the conflicting submission;
changing the owner or deleting the existing job is not a recovery procedure.

Operators can inspect the job through BullMQ's `Queue.getJob(jobId)`, using the
existing `deployment-queue` queue and `bull` prefix. The private identity format
is `deployment-` followed by the 16 lowercase hexadecimal digits of the numeric
ID's big-endian IEEE-754 binary64 representation. Zero and negative zero use the
same identity. For example, deployment 42 currently maps to
`deployment-4045000000000000`. Decimal/exponent spellings of the same number also
map to one job. This encoding preserves the existing finite, nonnegative numeric
request schema, including fractional values; it does not add an integer-only
validation rule or a new request field. Application code should continue using
the HTTP contract rather than reconstructing Redis keys.

Express uses BullMQ's custom-job-ID insertion and then reads the actual retained
payload before acknowledging it; BullMQ's insertion result alone echoes the
submitted payload even for an existing job. If the record disappears before
that verification, the result is an uncertain 503. Go compares a retained
payload or inserts the new job in one Redis script. Its BullMQ representation
stays inside the existing private adapter.

## Retention boundary

Deduplication lasts **only while Redis retains the job record**. There is no
separate permanent deduplication ledger. The existing queue-wide policy remains
three attempts, exponential backoff of 2 then 4 seconds, the latest 100 completed
jobs, and the latest 1,000 terminally failed jobs. BullMQ applies count-based
eviction when another job finishes in that state, not after a fixed duration.
Waiting, paused, active, and delayed jobs remain tracked normally.

After eviction, manual job removal, or Redis data loss, enqueueing the same
deployment can create a job again with the same identity. Execution
reconciliation must protect the deployment and its artifacts against those
redeliveries. Producer deduplication does not supply exactly-once execution,
durable admission, or recovery of the database-to-queue handoff. Existing jobs
created before this change with auto-incremented IDs are not migrated or
retroactively deduplicated. Roll out both supported producers together and
account for those older jobs when investigating uncertain pre-upgrade requests.

## Verification

Run the default real Go + Express suite with the declared Go toolchain and a
disposable local Redis server:

```sh
npm run test:queue
```

See [queue compatibility operations](queue-compatibility-operations.md) for
tool paths, isolation, partial-run diagnostics, and the existing timeout policy.
The suite observes the real BullMQ worker through HTTP submissions. It covers
concurrent identical requests, conflicting reuse, response loss followed by
producer restart, numeric/Unicode encoding, active and paused duplicates,
unchanged retry/backoff, retained terminal jobs, and redelivery after actual
completion/failure eviction. Its processor is a deployment fixture; it does not
establish Docker or deployment-execution reconciliation guarantees.
