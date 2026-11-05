# Bounded deployment history and live output

App detail polling returns deployment metadata without `deploymentLogs`.
Owners read persisted output separately with the authenticated
`app.deploymentLogs` query, supplying both `appId` and the selected `deploymentId`.
Every cursor request checks deployment ownership/active status and the shared
`activeAppEligibility` rule: active app, active parent project, app creator and
project owner. A foreign, retired or mismatched deployment returns `NOT_FOUND`;
anonymous requests return `UNAUTHORIZED`. No host credential reaches the browser.

## Read limits and cursors

`packages/database/src/access-layer/deployment-log-limits.ts` configures the
default/browser page size (**100 records**), maximum requested size (**200**) and
maximum message length (**4,096 PostgreSQL characters**). Invalid limits and
requests combining `before` and `after` are rejected. Message clipping happens
in the SQL projection, before loading it into the application, and sets the
record's `truncated` flag. The UI displays `[message truncated]` and a notice.
The stored message is unchanged. A clipped message cannot be reconstructed by
paging: cursors address records, not characters.

Pages contain chronological `logs`, `oldestCursor`, `newestCursor` and `hasMore`.
Without a cursor the query returns the newest window. `before` returns the
immediately older window, exclusive of that record ID. `after` returns the next
window after an exclusive ID, in ascending order. `hasMore` refers to the
requested direction; a final page can still contain records. IDs are stable
ordering keys, including when timestamps match. A cursor from another release
never changes the deployment scope. The database reads at most `limit + 1`
projected rows, using one row only to detect another page.

The panel retains one 100-record window. **Older logs** and **Newer logs** replace
that window; **Latest logs** resumes following the same selected deployment.
Following checks for new IDs every **2.5 seconds**, draining a backlog through
bounded successive requests. It never repeatedly fetches the initial window.
Older windows do not poll. App metadata polling does not reset the selected
deployment, page cursor or scroll offset. The following window discards its
oldest records when full and announces that earlier records were omitted; those
records remain available with Older logs. History is not stored in an expanding
client query cache. Changing selection aborts outstanding reads.

## Runtime output

`apps/web/src/utils/live-log-buffer.ts` configures retained runtime output:
**1,000 lines** and **131,072 UTF-16 code units**, including newline separators.
The first limit reached evicts the oldest lines. A single oversized line retains
its trailing text within the character budget without splitting a surrogate
pair. A persistent **Earlier output truncated** notice appears in the panel and
fullscreen view. Copy copies the displayed window, not discarded output.
These are retained-view limits, not limits on a transport chunk/event being
decoded or Docker's server-side storage.

Runtime identity, typed errors, clean EOF, unexpected EOF, upstream cancellation
and server-held credentials retain the [runtime protocol](runtime-log-protocol-and-reconnect.md).
An open subscription remains pinned to the runtime it identified, even when app
polling reports a new release or another persisted deployment is selected.
**Reconnect** explicitly cancels that subscription, clears its output/truncation
notice and identifies the current successful runtime. It does not change the
persisted-history selection. There is no exactly-once/resume cursor for runtime
logs; reconnect can repeat Docker's recent tail.

## Verification and operations

Run `npm run build --workspace @repo/database` and
`npm run build --workspace @repo/api-sdk`, then set `DATABASE_TEST_URL` to a
disposable loopback PostgreSQL server and run
`npm run test:deployment-history --workspace web`. The workflow creates/removes
its own database, applies all development migrations, exercises authenticated
requests and consumes the UI in JSDOM. It checks cursor volume, growing history,
polling/new releases, preserved selection/scroll, clipping, live eviction,
typed outcomes and reconnect. Auth/runtime transport are fixtures; PostgreSQL,
DAL, routers, tRPC transport, React and SSE consumption are real. JSDOM is not a
real browser and these tests do not prove real Docker daemon behavior.

No persistence migration or new environment variable is required. These limits
bound data transferred/retained, not database log retention or total deployment
metadata. Operators still manage database and Docker log retention separately.
