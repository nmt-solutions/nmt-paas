import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { createServer, type Server } from "node:http";
import { EventEmitter, once } from "node:events";
import pg from "pg";
import express from "express";

let host: Server;
let docker: Server;
let getLogs: typeof import("../src/app/api/apps/[appId]/runtime-logs/route").GET;
const hostEvents = new EventEmitter();
let mode: "live" | "eof" = "live";

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
    assert.match(req.url ?? "", /^\/containers\/deployment-7\/logs\?/);
    res.once("close", () => hostEvents.emit("closed"));
    res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
    const payload = Buffer.from("runtime output\n");
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(payload.length, 4);
    res.write(Buffer.concat([header, payload]));
    if (mode === "eof") res.end();
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
            id: 7,
            appId: 1,
            repoId: 1,
            branch: "main",
            commit: "fixture-commit",
            status: "success",
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
  const chunk = await within(reader.read());
  assert.match(new TextDecoder().decode(chunk.value), /runtime output/);
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
    assert.equal(await within(response.text()), 'data: "runtime output"\n\n');
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
