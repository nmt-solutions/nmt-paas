import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { EventEmitter, once } from "node:events";
import express from "express";

let dockerServer: Server;
let apiServer: Server;
let apiUrl: string;
const dockerEvents = new EventEmitter();

async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Subscription did not close within 1s")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function frame(line: string) {
  const payload = Buffer.from(line);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

before(async () => {
  // Dockerode uses its real HTTP transport against a disposable Docker API fixture.
  dockerServer = createServer((req, res) => {
    const id = /\/containers\/deployment-(\d+)\/logs\?/.exec(
      req.url ?? "",
    )?.[1];
    assert.ok(id);
    res.once("close", () => dockerEvents.emit(`close:${id}`));
    dockerEvents.emit(`open:${id}`);
    if (id === "2") return; // Docker has not returned its response headers yet.
    res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
    if (id !== "1") {
      res.write(frame("still running\n"));
      if (id === "8") setImmediate(() => res.destroy());
      return;
    }
    res.end(frame("hello from runtime\n"));
  });
  const dockerUrl = await listen(dockerServer);
  Object.assign(process.env, {
    DOCKER_HOST: dockerUrl,
    API_APP_PORT: "0",
    API_KEY: "fixture-log-key",
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: "1",
    REDIS_PASSWORD: "fixture-unused",
  });
  const { default: logsRouter } =
    await import("../src/router/v1/logs.router.js");
  const { requireApiAuth } =
    await import("../src/controllers/v1/authentication/auth.js");
  const app = express();
  app.use("/api/v1/logs", requireApiAuth, logsRouter);
  apiServer = createServer(app);
  apiUrl = await listen(apiServer);
});

test("closing a subscription while Docker is opening cancels the upstream HTTP request", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const opened = once(dockerEvents, "open:2");
  const closed = once(dockerEvents, "close:2");
  const response = await fetch(`${apiUrl}/api/v1/logs/stream/2`, {
    headers: { Authorization: "Bearer fixture-log-key" },
    signal: AbortSignal.timeout(3000),
  });
  await within(opened);
  await response.body?.cancel();
  await within(closed);
});

after(async () => {
  for (const server of [apiServer, dockerServer]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("host returns runtime output and closes the HTTP subscription after Docker EOF", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const response = await fetch(`${apiUrl}/api/v1/logs/stream/1`, {
    headers: { Authorization: "Bearer fixture-log-key" },
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(
    await response.text(),
    ': connected\n\ndata: "hello from runtime"\n\n',
  );
});

test("active subscriptions retain output and heartbeats and repeated disconnects release Docker readers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (let id = 3; id < 8; id++) {
    const closed = once(dockerEvents, `close:${id}`);
    const response = await fetch(`${apiUrl}/api/v1/logs/stream/${id}`, {
      headers: { Authorization: "Bearer fixture-log-key" },
      signal: AbortSignal.timeout(3000),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (!output.includes('data: "still running"')) {
      const chunk = await within(reader.read());
      assert.equal(chunk.done, false);
      output += decoder.decode(chunk.value);
    }
    t.mock.timers.tick(15_000);
    const heartbeat = await within(reader.read());
    assert.match(decoder.decode(heartbeat.value), /: heartbeat\n\n/);
    await reader.cancel();
    await within(closed);
  }
});

test("an interrupted Docker connection ends its HTTP subscription", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const response = await fetch(`${apiUrl}/api/v1/logs/stream/8`, {
    headers: { Authorization: "Bearer fixture-log-key" },
    signal: AbortSignal.timeout(1000),
  });
  await response.text();
});
