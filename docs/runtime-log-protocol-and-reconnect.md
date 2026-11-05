# Runtime log text, outcomes, and reconnect

The Go node manager and supported Express host implement the same authenticated
`GET /api/v1/logs/stream/:deploymentId` protocol. The web route resolves the
authenticated owner's latest successful deployment once, then follows that
deployment for the entire subscription. Deploying a replacement does not retarget
an open subscription.

## Wire contract

All data is JSON inside SSE. Comments such as `: connected` and the 15-second
`: heartbeat` have no log meaning.

| SSE event           | JSON data                                       | Meaning                                                                                              |
| ------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `runtime`           | `{"deploymentId":7}`                            | Identifies the followed deployment before output or errors.                                          |
| Unnamed (`message`) | `"decoded log text"`                            | One application output line. Consumers also accept an explicit `log` event with this string payload. |
| `error`             | `{"message":"Failed to read deployment logs."}` | The subscription failed; this is not application output.                                             |
| `end`               | `{"reason":"eof"}` or `{"reason":"error"}`      | Terminal outcome; stop reading and release the subscription.                                         |

Docker stdout and stderr multiplex frames are reconstructed across HTTP chunks.
Each output stream keeps its own partial line and UTF-8 decoding state across
frames. Blank lines are preserved, and normal Docker EOF flushes the last line
even without a newline. A broken connection, incomplete frame header/payload, or
failure to open Docker produces `error` followed by `end` with reason `error`.
The runtime containers created by the executor use Docker's multiplexed,
non-TTY log transport. This protocol does not add support for arbitrary TTY
containers.

`@repo/api-sdk/runtime-logs` is a browser-safe module containing the shared SSE
consumer and encoder. It has no server client or environment import. It handles
split SSE fields, LF/CRLF/CR line endings, multiline data, comments, and streamed
UTF-8. It rejects output before identity, a mismatched requested identity, and
an identity change within one subscription. An HTTP EOF without a terminal event
is a connection failure; an unfinished SSE event is not displayed as text.
Consumer exceptions propagate once, and every exit cancels and unlocks the body
reader. The SDK retains its decoded-string callback and provides an optional
event callback for callers that handle typed outcomes.

The web route forwards those event types and the selected identity. A failure
before host metadata arrives is reported against the already selected deployment
with a generic error and error termination. The host bearer key remains in the
server-side client and is never part of the browser request, response, or shared
protocol module. Deploy the updated host together with the SDK/web protocol;
older hosts without identity/termination events do not satisfy this contract.

## Owner workflow

The application log panel displays `Live`, `Stream ended`, or `Stream failed`
alongside its deployment number. Connection errors appear separately from
application text. Routine app polling does not reconnect the log panel.

**Reconnect** explicitly starts a new subscription, clears the previous live
output, and resolves the latest successful deployment again. The newly emitted
identity labels the fresh output. There is no automatic reconnect, runtime
migration, Last-Event-ID replay, or guarantee of lossless resume. Each connection
requests Docker timestamps and `tail=100` for stdout/stderr, so reconnect may
repeat recent lines. Container start remains the deployment success criterion.

The selected persisted deployment history is independent of this live identity.
History pagination and live-buffer retention/truncation belong to ticket #24;
this change does not establish a browser retention limit.

## Verification and diagnosis

Run `npm run test:runtime-logs` and the native Go tests documented in
[subscription lifecycle](runtime-log-subscription-lifecycle.md). The suites
exercise byte-split Docker headers/payloads, partial lines and UTF-8, blank/final
lines, heartbeat comments, typed errors, EOF, truncated frames, cancellation,
consumer failures, and reconnect identity. The forwarding suite consumes its
response with the same production consumer used by the browser; it does not
claim DOM/browser automation. WorkOS and PostgreSQL are external fixtures there,
while the route, DAL, SDK, Express handler, Dockerode HTTP transport, and stream
consumer execute production code. Go tests use its real HTTP handler against a
Docker HTTP fixture. These are not real Docker-daemon or PostgreSQL integration
checks.

For an unexpected disconnect, inspect the displayed deployment identity and
whether a terminal event arrived before deciding to reconnect. Check proxy
buffering/disconnect propagation and Docker availability. Cancellation and EOF
still stop readers and heartbeat work promptly; the lifecycle cleanup contract
is unchanged. The independent real Redis/BullMQ regression command remains
`npm run test:queue`, with both default Go and Express producers enabled.
