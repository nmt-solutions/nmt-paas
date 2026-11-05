import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { after, before, test } from "node:test";
import type { ControlPanelAPIClient } from "../src/client";

let client: ControlPanelAPIClient;
let closeHost: () => Promise<void>;
let upstreamClosed: Promise<void>;
const hostEvents = new EventEmitter();

async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Upstream reader was not released within 1s")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

before(async () => {
  let closed!: () => void;
  upstreamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const host = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-sdk-key");
    res.once("close", closed);
    res.once("close", () => hostEvents.emit(`closed:${req.url}`));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (req.url === "/logs/stream/10") {
      res.end(
        'event: runtime\ndata: {"deploymentId":10}\n\ndata: "kept"\n\ndata: "incomplete',
      );
      return;
    }
    if (req.url === "/logs/stream/11") {
      res.write(
        'event: runtime\ndata: {"deploymentId":12}\n\ndata: "wrong runtime"\n\n',
      );
      return;
    }
    if (req.url === "/logs/stream/12") {
      res.write(
        'event: runtime\ndata: {"deploymentId":12}\n\ndata: "first runtime"\n\nevent: runtime\ndata: {"deploymentId":13}\n\ndata: "replacement"\n\n',
      );
      return;
    }
    if (req.url === "/logs/stream/8" || req.url === "/logs/stream/9") {
      const bytes = Buffer.from(
        req.url.endsWith("/9")
          ? 'event: runtime\r\ndata: {"deploymentId":9}\r\n\n' +
              'data: "mixed line endings"\n\n' +
              'event: end\ndata: {"reason":"eof"}\n\n'
          : ': heartbeat\r\n\r\nevent: runtime\r\ndata: {"deploymentId":8}\r\n\r\n' +
              'data: "hello 🌍 \\"quoted\\""\r\n\r\n' +
              'event: error\r\ndata: {"message":\r\ndata: "fixture source failed"}\r\n\r\n' +
              'event: end\r\ndata: {"reason":"error"}\r\n\r\n',
      );
      void (async () => {
        for (const byte of bytes) {
          res.write(Buffer.from([byte]));
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        // Deliberately remain open: the terminal event must release the reader.
      })();
      return;
    }
    res.write('event: runtime\ndata: {"deploymentId":7}\n\ndata: "hello"\n\n');
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const address = host.address();
  assert.ok(address && typeof address !== "string");
  Object.assign(process.env, {
    API_BASE_URL: `http://127.0.0.1:${address.port}`,
    API_KEY: "fixture-sdk-key",
  });
  const { ControlPanelAPIClient } = await import("../src/client");
  client = new ControlPanelAPIClient();
  closeHost = async () => {
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
  };
});

after(async () => closeHost());

test("a log consumer failure releases the upstream HTTP reader", async () => {
  let deliveries = 0;
  await assert.rejects(
    client.streamRuntimeLogs(7, () => {
      deliveries++;
      throw new Error("consumer closed");
    }),
    /consumer closed/,
  );
  assert.equal(
    deliveries,
    1,
    "A consumer exception must not be retried as raw transport text",
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      upstreamClosed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Upstream reader was not released within 1s")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
});

test("SDK consumers receive decoded text and typed outcomes through byte-split SSE and CRLF heartbeats", async () => {
  const closed = once(hostEvents, "closed:/logs/stream/8");
  const logs: string[] = [];
  const events: unknown[] = [];
  await client.streamRuntimeLogs(
    8,
    (line) => logs.push(line),
    AbortSignal.timeout(2000),
    (event) => events.push(event),
  );
  assert.deepEqual(logs, ['hello 🌍 "quoted"']);
  assert.deepEqual(events, [
    { type: "runtime", deploymentId: 8 },
    { type: "log", text: 'hello 🌍 "quoted"' },
    { type: "error", message: "fixture source failed" },
    { type: "end", reason: "error" },
  ]);
  await within(closed);
});

test("unexpected EOF reports connection failure without displaying an incomplete SSE event", async () => {
  const logs: string[] = [];
  const events: unknown[] = [];
  await client.streamRuntimeLogs(
    10,
    (line) => logs.push(line),
    AbortSignal.timeout(2000),
    (event) => events.push(event),
  );
  assert.deepEqual(logs, ["kept"]);
  assert.deepEqual(events, [
    { type: "runtime", deploymentId: 10 },
    { type: "log", text: "kept" },
    {
      type: "error",
      message:
        "Runtime log connection ended unexpectedly. Reconnect to select the current runtime.",
    },
    { type: "end", reason: "error" },
  ]);
});

test("a mismatched or changing runtime is rejected before replacement output can reach the consumer", async () => {
  for (const id of [11, 12]) {
    const logs: string[] = [];
    const closed = once(hostEvents, `closed:/logs/stream/${id}`);
    await assert.rejects(
      client.streamRuntimeLogs(
        id,
        (line) => logs.push(line),
        AbortSignal.timeout(2000),
      ),
      /runtime identity|Runtime identity/,
    );
    assert.deepEqual(logs, id === 11 ? [] : ["first runtime"]);
    await within(closed);
  }
});

test("mixed SSE line endings split immediately after CRLF do not discard event boundaries", async () => {
  const logs: string[] = [];
  await client.streamRuntimeLogs(
    9,
    (line) => logs.push(line),
    AbortSignal.timeout(2000),
  );
  assert.deepEqual(logs, ["mixed line endings"]);
});
