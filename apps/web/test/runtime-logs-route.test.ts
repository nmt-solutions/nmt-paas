import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { EventEmitter, once } from "node:events";
import pg from "pg";
import express from "express";
import {
  consumeRuntimeLogStream,
  type RuntimeLogEvent,
} from "@repo/api-sdk/runtime-logs";

let host: Server;
let docker: Server;
let getLogs: typeof import("../src/app/api/apps/[appId]/runtime-logs/route").GET;
const hostEvents = new EventEmitter();
let mode: "live" | "eof" | "fragmented" | "error" = "live";
let latestDeploymentId = 7;
const subscriptions = new Map<number, ServerResponse>();

function frame(text: string | Buffer, stream = 1) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error("Upstream subscription did not close within 1s")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

before(async () => {
  docker = createServer((req, res) => {
    assert.match(req.url ?? "", /^\/containers\/deployment-\d+\/logs\?/);
    const deploymentId = Number(/deployment-(\d+)/.exec(req.url ?? "")?.[1]);
    subscriptions.set(deploymentId, res);
    res.once("close", () => subscriptions.delete(deploymentId));
    res.once("close", () => hostEvents.emit("closed"));
    res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
    if (mode === "fragmented") {
      const text = Buffer.from('runtime 🌍 "quoted"\nlast line');
      const bytes = Buffer.concat([
        frame(text.subarray(0, 10)),
        frame(text.subarray(10)),
      ]);
      void (async () => {
        for (const byte of bytes) {
          res.write(Buffer.from([byte]));
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        res.end();
      })();
      return;
    }
    res.write(frame("runtime output\n"));
    if (mode === "eof") res.end();
    if (mode === "error") setImmediate(() => res.destroy());
  });
  docker.listen(0, "127.0.0.1");
  await once(docker, "listening");
  const dockerAddress = docker.address();
  assert.ok(dockerAddress && typeof dockerAddress !== "string");
  Object.assign(process.env, {
    DOCKER_HOST: `http://127.0.0.1:${dockerAddress.port}`,
    API_APP_PORT: "0",
    API_KEY: "fixture-server-key",
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: "1",
    REDIS_PASSWORD: "fixture-unused",
  });
  const { default: logsRouter } =
    await import("../../api/src/router/v1/logs.router.js");
  const { requireApiAuth } =
    await import("../../api/src/controllers/v1/authentication/auth.js");
  const app = express();
  app.use("/api/v1/logs", requireApiAuth, logsRouter);
  host = createServer(app);
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const address = host.address();
  assert.ok(address && typeof address !== "string");
  Object.assign(process.env, {
    API_KEY: "fixture-server-key",
    API_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
    DEV_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/unused",
    PROD_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/unused",
    BASE_DOMAIN: "fixture.invalid",
  });
  // Only external auth and the PostgreSQL driver are fixtures. The route, DAL,
  // SDK, both HTTP hops, Express handler and Dockerode are the production code.
  mock.module("@workos-inc/authkit-nextjs", {
    namedExports: { withAuth: async () => ({ user: { id: "fixture-owner" } }) },
  });
  class FixturePool {
    async query() {
      return {
        rows: [
          {
            id: latestDeploymentId,
            appId: 1,
            repoId: 1,
            branch: "main",
            commit: "fixture-commit",
            status: "success",
            cleanup: null,
            env: "production",
            userId: "fixture-owner",
            resourceStatus: "active",
            createdAt: null,
            createdBy: "fixture-owner",
            modifiedAt: null,
            modifiedBy: null,
          },
        ],
      };
    }
  }
  mock.module("pg", {
    defaultExport: { ...pg, Pool: FixturePool },
    namedExports: { ...pg, Pool: FixturePool },
  });
  ({ GET: getLogs } =
    await import("../src/app/api/apps/[appId]/runtime-logs/route"));
});

after(async () => {
  for (const server of [host, docker]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  mock.restoreAll();
});

test("canceling the browser-facing response closes the SDK's upstream HTTP subscription", async () => {
  const closed = once(hostEvents, "closed");
  const response = await getLogs(
    new Request("http://web.test/api/apps/1/runtime-logs"),
    {
      params: Promise.resolve({ appId: "1" }),
    },
  );
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let output = "";
  while (!output.includes("runtime output")) {
    const chunk = await within(reader.read());
    assert.equal(chunk.done, false);
    output += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel();
  await within(closed);
});

test("upstream EOF closes the browser-facing response and preserves log output", async () => {
  mode = "eof";
  try {
    const response = await getLogs(
      new Request("http://web.test/api/apps/1/runtime-logs"),
      {
        params: Promise.resolve({ appId: "1" }),
      },
    );
    assert.equal(
      await within(response.text()),
      'event: runtime\ndata: {"deploymentId":7}\n\ndata: "runtime output"\n\nevent: end\ndata: {"reason":"eof"}\n\n',
    );
    assert.equal(response.headers.get("authorization"), null);
  } finally {
    mode = "live";
  }
});

test("repeated browser request aborts terminate their upstream subscriptions", async () => {
  for (let cycle = 0; cycle < 5; cycle++) {
    const closed = once(hostEvents, "closed");
    const controller = new AbortController();
    const response = await getLogs(
      new Request("http://web.test/api/apps/1/runtime-logs", {
        signal: controller.signal,
      }),
      { params: Promise.resolve({ appId: "1" }) },
    );
    const reader = response.body!.getReader();
    assert.equal((await within(reader.read())).done, false);
    controller.abort();
    assert.equal((await within(reader.read())).done, true);
    await within(closed);
    reader.releaseLock();
  }
});

test("the browser consumer receives runtime identity, decoded fragmented text and normal termination through the forwarding route", async () => {
  mode = "fragmented";
  try {
    const response = await getLogs(
      new Request("http://web.test/api/apps/1/runtime-logs"),
      { params: Promise.resolve({ appId: "1" }) },
    );
    const events: RuntimeLogEvent[] = [];
    await within(
      consumeRuntimeLogStream(response.body!, (event) => events.push(event)),
    );
    assert.deepEqual(events, [
      { type: "runtime", deploymentId: 7 },
      { type: "log", text: 'runtime 🌍 "quoted"' },
      { type: "log", text: "last line" },
      { type: "end", reason: "eof" },
    ]);
  } finally {
    mode = "live";
  }
});

test("a Docker failure reaches the browser as an error and termination rather than a log line", async () => {
  mode = "error";
  try {
    const response = await getLogs(
      new Request("http://web.test/api/apps/1/runtime-logs"),
      { params: Promise.resolve({ appId: "1" }) },
    );
    const events: RuntimeLogEvent[] = [];
    await within(
      consumeRuntimeLogStream(response.body!, (event) => events.push(event)),
    );
    assert.deepEqual(events, [
      { type: "runtime", deploymentId: 7 },
      { type: "log", text: "runtime output" },
      { type: "error", message: "Failed to read deployment logs." },
      { type: "end", reason: "error" },
    ]);
    assert.equal(response.headers.get("authorization"), null);
  } finally {
    mode = "live";
  }
});

test("a live subscription stays on its identified runtime and explicit reconnect identifies the newer successful deployment", async () => {
  const controller = new AbortController();
  const observed = new EventEmitter();
  const events: RuntimeLogEvent[] = [];
  let reading: Promise<void> | undefined;
  try {
    const response = await getLogs(
      new Request("http://web.test/api/apps/1/runtime-logs", {
        signal: controller.signal,
      }),
      { params: Promise.resolve({ appId: "1" }) },
    );
    const firstLog = once(observed, "log");
    reading = consumeRuntimeLogStream(response.body!, (event) => {
      events.push(event);
      if (event.type === "log") observed.emit("log");
    });
    await within(firstLog);
    latestDeploymentId = 8;
    const nextLog = once(observed, "log");
    subscriptions.get(7)!.write(frame("still deployment 7\n"));
    await within(nextLog);
    assert.deepEqual(events, [
      { type: "runtime", deploymentId: 7 },
      { type: "log", text: "runtime output" },
      { type: "log", text: "still deployment 7" },
    ]);
    mode = "eof";
    const reconnected = await getLogs(
      new Request("http://web.test/api/apps/1/runtime-logs"),
      { params: Promise.resolve({ appId: "1" }) },
    );
    const newer: RuntimeLogEvent[] = [];
    await within(
      consumeRuntimeLogStream(reconnected.body!, (event) => newer.push(event)),
    );
    assert.deepEqual(newer, [
      { type: "runtime", deploymentId: 8 },
      { type: "log", text: "runtime output" },
      { type: "end", reason: "eof" },
    ]);
    assert.deepEqual(
      events.filter((event) => event.type === "runtime"),
      [{ type: "runtime", deploymentId: 7 }],
    );
  } finally {
    controller.abort();
    if (reading) await within(reading);
    latestDeploymentId = 7;
    mode = "live";
  }
});
