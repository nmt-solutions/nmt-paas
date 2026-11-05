import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, mock, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { UserInfo } from "@workos-inc/authkit-nextjs";
import { Queue, Worker } from "bullmq";
import { Client } from "pg";

const fixtures = new Client({
  connectionString: process.env.IMPORT_TEST_DATABASE_URL,
});
await fixtures.connect();
const directory = await mkdtemp(join(tmpdir(), "nmt-dispatch-"));
const children: ChildProcess[] = [];
async function freePort() {
  const server = tcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
const redisPort = await freePort();
const apiPort = await freePort();
const connection = {
  host: "127.0.0.1",
  port: redisPort,
  password: "dispatch-redis-fixture",
  maxRetriesPerRequest: null,
};
const queue = new Queue("deployment-queue", { connection });
queue.on("error", () => {});
const received: { deploymentId: number; userId: string }[] = [];
let output = "";
function launch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = directory,
) {
  const child = spawn(command, args, {
    env,
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  child.on("error", (error) => {
    output += error.message;
  });
  child.stdout?.on("data", (chunk) => {
    output = (output + chunk).slice(-8000);
  });
  child.stderr?.on("data", (chunk) => {
    output = (output + chunk).slice(-8000);
  });
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}
async function until(
  check: () => Promise<unknown>,
  message: string,
  milliseconds = 12_000,
) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(`${message}\n${output}`);
}
const nativeFetch = globalThis.fetch;
let hostMode: "available" | "unavailable" | "lost" | "rejected" = "available";
let hostRequests = 0;
const transactions: number[] = [];
const host = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, "Bearer dispatch-host-fixture");
  const { rows } = await fixtures.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name = $1 AND xact_start IS NOT NULL AND pid <> pg_backend_pid()",
    [
      new URL(process.env.IMPORT_TEST_DATABASE_URL!).searchParams.get(
        "application_name",
      ),
    ],
  );
  transactions.push(rows[0]!.count);
  hostRequests++;
  if (hostMode === "unavailable" || hostMode === "rejected") {
    const statusCode = hostMode === "unavailable" ? 503 : 409;
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "error",
        statusCode,
        data: null,
        message: "dispatch-fixture-secret rejected",
      }),
    );
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const result = await nativeFetch(
    `http://127.0.0.1:${apiPort}/api/v1/deployments/queue`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dispatch-host-fixture",
      },
      body: Buffer.concat(chunks),
    },
  );
  const body = await result.text();
  if (hostMode === "lost" && result.ok) {
    response.destroy();
    return;
  }
  response.writeHead(result.status, { "content-type": "application/json" });
  response.end(body);
});
await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
const address = host.address();
assert.ok(address && typeof address !== "string");
Object.assign(process.env, {
  APP_ENV: "development",
  DB_ENV: "development",
  DOTENV_CONFIG_PATH: "__dispatch_no_dotenv__",
  WORKOS_CLIENT_ID: "fixture",
  WORKOS_API_KEY: "fixture-workos-key",
  WORKOS_COOKIE_PASSWORD: "fixture".repeat(8),
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: "http://localhost/callback",
  GITHUB_APP_ID: "123",
  GITHUB_APP_SLUG: "fixture-app",
  GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
  ENV_ENCRYPTION_KEY: "11".repeat(32),
  DEV_DATABASE_URL: process.env.IMPORT_TEST_DATABASE_URL,
  PROD_DATABASE_URL: "postgresql://fixture@127.0.0.1:1/unused",
  BASE_DOMAIN: "fixture.localhost",
  API_KEY: "dispatch-host-fixture",
  API_BASE_URL: `http://127.0.0.1:${address.port}`,
  API_APP_PORT: String(apiPort),
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: String(redisPort),
  REDIS_PASSWORD: connection.password,
  NEXT_RUNTIME: "nodejs",
});
const root = new URL("../../../", import.meta.url);
const redis = launch(
  process.env.REDIS_SERVER_BIN || "redis-server",
  [
    "--bind",
    "127.0.0.1",
    "--port",
    String(redisPort),
    "--requirepass",
    connection.password,
    "--save",
    "",
    "--appendonly",
    "no",
    "--dir",
    ".",
  ],
  process.env,
);
const redisProcesses = new Set([redis]);
await until(
  () => queue.client.then((client) => client.info()).catch(() => false),
  "Redis did not start",
);
launch(
  process.execPath,
  ["--import", "tsx", "apps/api/src/index.ts"],
  process.env,
  fileURLToPath(root),
);
await until(
  () =>
    nativeFetch(`http://127.0.0.1:${apiPort}/api/v1/health`)
      .then((response) => response.ok)
      .catch(() => false),
  "Express did not start",
);
mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  assert.equal(url.hostname, "api.github.com");
  let data: unknown;
  if (url.pathname === "/apps/fixture-app")
    data = { id: 123, slug: "fixture-app" };
  else if (url.pathname === "/app/installations/456")
    data = {
      id: 456,
      account: { id: 99, login: "fixture-owner" },
      suspended_by: null,
    };
  else if (url.pathname === "/app/installations/456/access_tokens")
    data = {
      token: "fixture-github-token",
      expires_at: "2099-01-01T00:00:00Z",
    };
  else if (url.pathname.endsWith("/commits/main"))
    data = { sha: "a".repeat(40) };
  else if (
    url.pathname === "/repos/fixture-owner/repo" ||
    url.pathname === "/repositories/12345"
  )
    data = {
      id: 12345,
      name: "repo",
      owner: { login: "fixture-owner" },
      default_branch: "main",
    };
  else throw new Error(`Unexpected GitHub request ${url.pathname}`);
  const response = Response.json(data);
  Object.defineProperty(response, "url", { value: url.toString() });
  return response;
});
const { appRouter } = await import("../src/trpc/routers/_app");
const userInfos = new Map<string, UserInfo>();
async function owner(id: string) {
  await fixtures.query(
    `INSERT INTO "GithubAppInstallations" ("userId", "createdBy", "installationId", state) VALUES ($1,$1,456,'completed')`,
    [id],
  );
  const userInfo: UserInfo = {
    sessionId: `session_${id}`,
    accessToken: "fixture-authkit-token",
    permissions: [],
    user: {
      object: "user",
      id,
      email: `${id}@fixture.invalid`,
      emailVerified: true,
      firstName: null,
      lastName: null,
      profilePictureUrl: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      lastSignInAt: null,
      externalId: null,
      metadata: {},
      locale: null,
    },
  };
  userInfos.set(id, userInfo);
  return appRouter.createCaller({ userInfo });
}
const input = {
  repoId: 12345,
  repo: "repo",
  owner: "fixture-owner",
  branch: "main",
  projectName: "Durable app",
  frameworkConfig: {
    framework: "node",
    rootDirectory: "./",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    startCommand: "npm start",
    outputDirectory: "dist",
    port: 3000,
  },
};
async function startRecovery() {
  const child = launch(
    process.execPath,
    [
      "--import",
      "./tests/server-only.mjs",
      "--import",
      "tsx",
      "tests/dispatch-recovery-process.ts",
    ],
    process.env,
    fileURLToPath(new URL("../", import.meta.url)),
  );
  const ready = once(child, "message");
  await Promise.race([
    ready,
    once(child, "exit").then(() =>
      assert.fail(`Recovery process exited: ${output}`),
    ),
  ]);
  return child;
}
const worker = new Worker(
  "deployment-queue",
  async (job) => {
    received.push(job.data);
  },
  { connection },
);
worker.on("error", () => {});
after(async () => {
  mock.restoreAll();
  for (const child of children.filter((child) => !redisProcesses.has(child)))
    await stop(child);
  await worker?.close(true);
  await queue.close();
  for (const child of redisProcesses) await stop(child);
  await fixtures.end();
  host.closeAllConnections();
  await new Promise<void>((resolve) => host.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

test(
  "a fresh web process automatically delivers a durable admission after the host recovers",
  { timeout: 25_000 },
  async () => {
    const caller = await owner("restart-owner");
    hostMode = "unavailable";
    const accepted = await caller.deployment.deploy({
      ...input,
      submissionId: randomUUID(),
    });
    assert.equal(accepted.outcome, "uncertain");
    hostMode = "available";
    const recoveries = await Promise.all([startRecovery(), startRecovery()]);
    try {
      await until(
        async () =>
          received.some(
            ({ deploymentId }) => deploymentId === accepted.deploymentId,
          ),
        "Saved deployment was not recovered",
      );
      assert.deepEqual(received, [
        { deploymentId: accepted.deploymentId, userId: "restart-owner" },
      ]);
      assert.ok(
        transactions.every((count) => count === 0),
        "No network request may hold a database transaction",
      );
      assert.equal(
        (await caller.app.get({ appId: accepted.appId })).deployments.length,
        1,
      );
    } finally {
      for (const recovery of recoveries) await stop(recovery);
    }
  },
);

test(
  "a lost enqueue acknowledgement and repeated submission deliver one retained job",
  { timeout: 25_000 },
  async () => {
    const caller = await owner("lost-ack-owner");
    const request = { ...input, submissionId: randomUUID() };
    hostMode = "lost";
    const accepted = await caller.deployment.deploy(request);
    assert.equal(accepted.outcome, "uncertain");
    await until(
      async () =>
        received.some(
          ({ deploymentId }) => deploymentId === accepted.deploymentId,
        ),
      "The acknowledged-lost job was not consumed",
    );
    const retries = await Promise.all(
      Array.from({ length: 3 }, () => caller.deployment.deploy(request)),
    );
    assert.ok(
      retries.every(
        ({ deploymentId }) => deploymentId === accepted.deploymentId,
      ),
    );
    hostMode = "available";
    const recovery = await startRecovery();
    try {
      await until(
        async () =>
          (
            await caller.deployment.submission({
              submissionId: request.submissionId,
            })
          )?.outcome === "accepted",
        "Lost acknowledgement was not reconciled",
      );
      assert.equal(
        received.filter(
          ({ deploymentId }) => deploymentId === accepted.deploymentId,
        ).length,
        1,
      );
      assert.equal(
        (await caller.app.get({ appId: accepted.appId })).deployments.length,
        1,
      );
    } finally {
      await stop(recovery);
    }
  },
);

test(
  "a definitive host refusal is visible separately from uncertain dispatch and is not retried automatically",
  { timeout: 15_000 },
  async () => {
    const caller = await owner("rejected-owner");
    hostMode = "rejected";
    const submissionId = randomUUID();
    const result = await caller.deployment.deploy({ ...input, submissionId });
    assert.equal(result.outcome, "rejected");
    assert.equal(result.dispatchState, "rejected");
    assert.ok(!JSON.stringify(result).includes("dispatch-fixture-secret"));
    const before = hostRequests;
    const recovery = await startRecovery();
    try {
      await delay(5_500);
      assert.equal(hostRequests, before);
      const found = await caller.deployment.submission({ submissionId });
      assert.equal(found?.outcome, "rejected");
      const statuses = await caller.deployment.dispatches({
        appId: result.appId,
      });
      assert.equal(statuses[0]?.state, "rejected");
      assert.equal(
        received.filter(
          ({ deploymentId }) => deploymentId === result.deploymentId,
        ).length,
        0,
      );
    } finally {
      hostMode = "available";
      await stop(recovery);
    }
  },
);

test(
  "a failed dispatch confirmation survives process restart and lease expiry without another job",
  { timeout: 50_000 },
  async () => {
    const caller = await owner("confirmation-owner");
    const submissionId = randomUUID();
    hostMode = "available";
    await fixtures.query(
      `CREATE FUNCTION reject_dispatch_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state = 'dispatched' THEN RAISE EXCEPTION 'dispatch-fixture-secret confirmation failure'; END IF; RETURN NEW; END $$`,
    );
    await fixtures.query(
      `CREATE TRIGGER reject_dispatch_confirmation BEFORE UPDATE ON "DeploymentDispatches" FOR EACH ROW EXECUTE FUNCTION reject_dispatch_confirmation()`,
    );
    let result;
    try {
      result = await caller.deployment.deploy({ ...input, submissionId });
      assert.equal(result.outcome, "uncertain");
      await until(
        async () =>
          received.some(
            ({ deploymentId }) => deploymentId === result!.deploymentId,
          ),
        "Job was not consumed before persistence failure",
      );
    } finally {
      await fixtures.query(
        `DROP TRIGGER reject_dispatch_confirmation ON "DeploymentDispatches"; DROP FUNCTION reject_dispatch_confirmation()`,
      );
    }
    const recovery = await startRecovery();
    await stop(recovery);
    const restarted = await startRecovery();
    try {
      await until(
        async () =>
          (await caller.deployment.submission({ submissionId }))?.outcome ===
          "accepted",
        "Expired lease did not recover after restart",
        38_000,
      );
      assert.equal(
        received.filter(
          ({ deploymentId }) => deploymentId === result!.deploymentId,
        ).length,
        1,
      );
    } finally {
      await stop(restarted);
    }
  },
);

test(
  "a real Redis outage leaves a saved intent that is delivered after Redis returns",
  { timeout: 30_000 },
  async () => {
    const caller = await owner("redis-outage-owner");
    await stop(redis);
    hostMode = "available";
    const submissionId = randomUUID();
    const result = await caller.deployment.deploy({ ...input, submissionId });
    assert.equal(result.outcome, "uncertain");
    const resumedRedis = launch(
      process.env.REDIS_SERVER_BIN || "redis-server",
      [
        "--bind",
        "127.0.0.1",
        "--port",
        String(redisPort),
        "--requirepass",
        connection.password,
        "--save",
        "",
        "--appendonly",
        "no",
        "--dir",
        ".",
      ],
      process.env,
    );
    redisProcesses.add(resumedRedis);
    await until(
      () => queue.client.then((client) => client.info()).catch(() => false),
      "Redis did not restart",
    );
    const recovery = await startRecovery();
    try {
      await until(
        async () =>
          received.some(
            ({ deploymentId }) => deploymentId === result.deploymentId,
          ),
        "Redis recovery did not deliver the intent",
      );
      assert.equal(
        (await caller.app.get({ appId: result.appId })).deployments.length,
        1,
      );
      assert.equal(
        (await caller.deployment.submission({ submissionId }))?.outcome,
        "accepted",
      );
    } finally {
      await stop(recovery);
      // Leave Redis available for the consumer/queue shutdown in the shared hook.
      assert.equal(resumedRedis.exitCode, null);
    }
  },
);

test(
  "recovery preserves the integrated eligibility rule for pending work",
  { timeout: 20_000 },
  async () => {
    const caller = await owner("retired-pending-owner");
    hostMode = "unavailable";
    const result = await caller.deployment.deploy({
      ...input,
      submissionId: randomUUID(),
    });
    await fixtures.query(
      `UPDATE "Projects" SET "resourceStatus" = 'inactive' WHERE id = $1`,
      [result.projectId],
    );
    hostMode = "available";
    const before = hostRequests;
    const recovery = await startRecovery();
    try {
      await delay(6_000);
      assert.equal(hostRequests, before);
      assert.equal(
        received.filter(
          ({ deploymentId }) => deploymentId === result.deploymentId,
        ).length,
        0,
      );
      assert.equal(
        await caller.deployment.submission({
          submissionId: result.submissionId,
        }),
        null,
      );
    } finally {
      await stop(recovery);
    }
  },
);

test(
  "the owner UI reuses the submission after a lost response and remount",
  { timeout: 25_000 },
  async () => {
    const caller = await owner("ui-owner");
    hostMode = "available";
    const first = await caller.deployment.deploy({
      ...input,
      submissionId: randomUUID(),
    });
    const { exerciseDispatchUI } = await import(
      new URL("./dispatch-ui.mjs", import.meta.url).href
    );
    await exerciseDispatchUI({
      appRouter,
      userInfo: userInfos.get("ui-owner"),
      caller,
      appId: first.appId,
      setHostMode: (mode: typeof hostMode) => {
        hostMode = mode;
      },
    });
  },
);
