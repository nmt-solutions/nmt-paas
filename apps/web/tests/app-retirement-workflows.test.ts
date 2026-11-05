import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import express from "express";
import { deploymentFixture } from "../../worker/test/fixtures/deployment";
import { after, mock, test } from "node:test";
import type { UserInfo } from "@workos-inc/authkit-nextjs";
import { Client } from "pg";
import {
  consumeRuntimeLogStream,
  encodeRuntimeLogEvent,
  type RuntimeLogEvent,
} from "@repo/api-sdk/runtime-logs";

assert.ok(process.env.AUTH_TEST_DATABASE_URL, "Run npm run test:retirement");
const hostRequests: string[] = [];
const cleanupFailures: Record<string, string> = {};
const dockerFixture = await deploymentFixture({ failRemove: cleanupFailures });

const host = createServer((request, response) => {
  assert.equal(request.headers.authorization, "Bearer fixture-host-key");
  hostRequests.push(`${request.method} ${request.url}`);
  if (request.url?.startsWith("/apps/"))
    return retirementHost(request, response);
  if (request.url?.startsWith("/logs/stream/")) {
    const deploymentId = Number(request.url.split("/").at(-1));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      [
        encodeRuntimeLogEvent({ type: "runtime", deploymentId }),
        encodeRuntimeLogEvent({ type: "log", text: "fixture runtime output" }),
        encodeRuntimeLogEvent({ type: "end", reason: "eof" }),
      ].join(""),
    );
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ status: "success", data: { complete: true } }));
});
await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
const address = host.address();
assert.ok(address && typeof address !== "string");
Object.assign(process.env, {
  DOCKER_HOST: dockerFixture.host,
  API_APP_PORT: "0",
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: "1",
  REDIS_PASSWORD: "unused-fixture",
  APP_ENV: "development",
  DB_ENV: "development",
  DOTENV_CONFIG_PATH: "__retirement_test_no_dotenv__",
  WORKOS_CLIENT_ID: "client_fixture",
  WORKOS_API_KEY: "sk_test_fixture",
  WORKOS_COOKIE_PASSWORD: "fixture-cookie-password-at-least-32-characters",
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  GITHUB_APP_ID: "123",
  GITHUB_APP_SLUG: "fixture-app",
  GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
  ENV_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  DEV_DATABASE_URL: process.env.AUTH_TEST_DATABASE_URL,
  PROD_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/unused",
  BASE_DOMAIN: "fixture.localhost",
  API_KEY: "fixture-host-key",
  API_BASE_URL: `http://127.0.0.1:${address.port}`,
});

const { default: hostRouter } =
  await import("../../api/src/router/v1/apps.router");
const { requireApiAuth } =
  await import("../../api/src/controllers/v1/authentication/auth");
const hostApp = express();
hostApp.use(express.json());
hostApp.use("/apps", requireApiAuth, hostRouter);
const retirementHost: RequestListener = hostApp;

let authenticatedUser: string | null = "retirement-owner";
mock.module("@workos-inc/authkit-nextjs", {
  namedExports: {
    withAuth: async () => ({
      user: authenticatedUser ? { id: authenticatedUser } : null,
    }),
  },
});
const { appRouter } = await import("../src/trpc/routers/_app");
const githubRequests: string[] = [];
let beforeCommitResponse: (() => Promise<void>) | undefined;
const nativeFetch = globalThis.fetch;
mock.method(
  globalThis,
  "fetch",
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
    assert.equal(
      url.hostname,
      "api.github.com",
      "Only fixture GitHub requests are allowed",
    );
    githubRequests.push(url.pathname);
    const json = (data: unknown, status = 200) => {
      const response = Response.json(data, { status });
      Object.defineProperty(response, "url", { value: url.toString() });
      return response;
    };
    if (url.pathname === "/apps/fixture-app")
      return json({ id: 123, name: "Fixture", slug: "fixture-app" });
    if (url.pathname.endsWith("/access_tokens"))
      return json(
        { token: "ghs_fixture", expires_at: "2099-01-01T00:00:00Z" },
        201,
      );
    if (url.pathname === "/app/installations/456")
      return json({
        account: { id: 99, login: "fixture-owner" },
        suspended_by: null,
      });
    if (url.pathname.includes("/commits/")) {
      await beforeCommitResponse?.();
      return json({ sha: "fresh-fixture-commit" });
    }
    if (
      url.pathname.startsWith("/repos/") ||
      url.pathname.startsWith("/repositories/")
    )
      return json({
        name: "fixture",
        owner: { login: "fixture-owner" },
        html_url: "https://github.com/fixture-owner/fixture",
        default_branch: "release",
      });
    throw new Error(`Unexpected GitHub fixture request: ${url.pathname}`);
  },
);
const fixtures = new Client({
  connectionString: process.env.AUTH_TEST_DATABASE_URL,
});
await fixtures.connect();
after(async () => {
  mock.restoreAll();
  await dockerFixture.close();
  await fixtures.end();
  await new Promise<void>((resolve, reject) =>
    host.close((error) => (error ? reject(error) : resolve())),
  );
});

function ownerInfo(userId: string) {
  const userInfo: UserInfo = {
    user: {
      object: "user",
      id: userId,
      email: `${userId}@fixture.invalid`,
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
    sessionId: `session_${userId}`,
    accessToken: "fixture-authkit-token",
  };
  return userInfo;
}

function owner(userId: string) {
  return appRouter.createCaller({ userInfo: ownerInfo(userId) });
}

let nextRepoId = 20000;
async function resourceFixture(userId: string) {
  const project = (
    await fixtures.query<{ id: number }>(
      `INSERT INTO "Projects" (name, "userId", "createdBy") VALUES ('Private project', $1, $1) RETURNING id`,
      [userId],
    )
  ).rows[0]!;
  const repoId = nextRepoId++;
  const app = (
    await fixtures.query<{ id: number }>(
      `INSERT INTO "Apps" ("appName", "projectId", "gitProvider", "repoId", "createdBy") VALUES ('Private app', $1, 'github', $2, $3) RETURNING id`,
      [project.id, repoId, userId],
    )
  ).rows[0]!;
  const deployment = (
    await fixtures.query<{ id: number }>(
      `INSERT INTO "Deployments" ("appId", "repoId", branch, commit, status, env, "userId", "createdBy") VALUES ($1, $2, 'release', 'fixture-commit', 'success', 'production', $3, $3) RETURNING id`,
      [app.id, repoId, userId],
    )
  ).rows[0]!;
  await fixtures.query(
    `INSERT INTO "DeploymentLogs" ("deploymentId", message, "createdBy") VALUES ($1, 'private persisted log', $2)`,
    [deployment.id, userId],
  );
  await fixtures.query(
    `INSERT INTO "FrameworkConfig" ("appId", framework, "rootDirectory", "installCommand", "buildCommand", "startCommand", "outputDirectory", port, "createdBy") VALUES ($1, 'node', './', 'npm ci', 'npm run build', 'node dist/server.js', 'dist', 3000, $2)`,
    [app.id, userId],
  );
  await fixtures.query(
    `INSERT INTO "AppDomains" ("appId", domain, env, "userId", "createdBy") VALUES ($1, $2, 'production', $3, $3)`,
    [app.id, `retirement-${repoId}.invalid`, userId],
  );
  return {
    projectId: project.id,
    appId: app.id,
    repoId,
    deploymentId: deployment.id,
  };
}

test("retiring one app preserves its active project and deployable sibling", async () => {
  const userId = "two-app-owner";
  const caller = owner(userId);
  const retired = await resourceFixture(userId);
  const sibling = await resourceFixture(userId);
  await fixtures.query(`UPDATE "Apps" SET "projectId" = $1 WHERE id = $2`, [
    retired.projectId,
    sibling.appId,
  ]);
  await seedRuntime(retired.appId, retired.deploymentId);
  await seedRuntime(sibling.appId, sibling.deploymentId);
  await caller.app.delete({ appId: retired.appId });
  assert.deepEqual(
    (await caller.project.list())
      .find((project) => project.id === retired.projectId)
      ?.apps.map((app) => app.id),
    [sibling.appId],
  );
  assert.equal(
    (await caller.app.get({ appId: sibling.appId })).appName,
    "Private app",
  );
  await assert.rejects(caller.app.get({ appId: retired.appId }), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    caller.app.deploymentLogs({
      appId: retired.appId,
      deploymentId: retired.deploymentId,
    }),
    {
      code: "NOT_FOUND",
    },
  );
  const siblingHistory = await caller.app.deploymentLogs({
    appId: sibling.appId,
    deploymentId: sibling.deploymentId,
  });
  assert.equal(siblingHistory.hasMore, false);
  assert.deepEqual(
    siblingHistory.logs.map((log) => log.message),
    ["private persisted log"],
  );
  assert.equal(
    await caller.app.getLatestSuccessDeployment({ appId: retired.appId }),
    undefined,
  );
  await assert.rejects(caller.app.redeploy({ appId: retired.appId }), {
    code: "NOT_FOUND",
  });
  assert.ok(hostRequests.includes(`POST /apps/${retired.appId}/retire`));
  assert.ok(!hostRequests.some((path) => path.includes("/admin/")));
  const { GET } =
    await import("../src/app/api/apps/[appId]/runtime-logs/route");
  authenticatedUser = userId;
  const logs = (appId: number) =>
    GET(new Request(`http://web.test/api/apps/${appId}/runtime-logs`), {
      params: Promise.resolve({ appId: String(appId) }),
    });
  const beforeDeniedLogs = hostRequests.length;
  assert.equal((await logs(retired.appId)).status, 404);
  assert.equal(hostRequests.length, beforeDeniedLogs);
  const siblingLogs = await logs(sibling.appId);
  assert.equal(siblingLogs.status, 200);
  const events: RuntimeLogEvent[] = [];
  await consumeRuntimeLogStream(siblingLogs.body!, (event) => {
    events.push(event);
  });
  assert.deepEqual(events, [
    { type: "runtime", deploymentId: sibling.deploymentId },
    { type: "log", text: "fixture runtime output" },
    { type: "end", reason: "eof" },
  ]);
  await assert.rejects(
    dockerFixture.docker
      .getContainer(`deployment-${retired.deploymentId}`)
      .inspect(),
    { statusCode: 404 },
  );
  assert.equal(
    (
      await dockerFixture.docker
        .getContainer(`deployment-${sibling.deploymentId}`)
        .inspect()
    ).State.Running,
    true,
  );
  await fixtures.query(
    `INSERT INTO "GithubAppInstallations" ("installationId", "userId", "createdBy", state) VALUES (456, $1, $1, 'completed')`,
    [userId],
  );
  const redeployed = await caller.app.redeploy({ appId: sibling.appId });
  assert.equal(redeployed.branch, "release");
  assert.ok(
    (await caller.app.get({ appId: sibling.appId })).deployments.some(
      (deployment) =>
        deployment.id === redeployed.deploymentId &&
        deployment.commit === "fresh-fixture-commit",
    ),
  );
  await assert.rejects(
    caller.deployment.deploy({
      repoId: retired.repoId,
      repo: "fixture",
      owner: "fixture-owner",
      branch: "release",
      frameworkConfig: {
        framework: "node",
        rootDirectory: "./",
        installCommand: "npm ci",
        buildCommand: "npm run build",
        startCommand: "node dist/server.js",
        outputDirectory: "dist",
        port: 3000,
      },
    }),
    { code: "NOT_FOUND" },
  );
});

async function seedRuntime(appId: number, deploymentId: number) {
  const container = await dockerFixture.docker.createContainer({
    name: `deployment-${deploymentId}`,
    Image: "fixture-image",
    Labels: {
      "nmt.app-id": String(appId),
      "nmt.deployment-id": String(deploymentId),
      "nmt.artifact": "runtime",
    },
  });
  await container.start();
  return container;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test(
  "retirement waits for an in-flight execution and queued retries cannot restore it",
  { timeout: 30000 },
  async () => {
    const userId = "in-flight-retirement-owner";
    const caller = owner(userId);
    const resource = await resourceFixture(userId);
    const { createDeploymentExecutor } =
      await import("../../worker/src/deployment/execute-deployment");
    const { createDockerCommandAdapter } =
      await import("../../worker/src/deployment/docker-command-adapter");
    const { getDeployment, updateDeployment, saveDeploymentCleanup } =
      await import("@repo/database/access-layer/deployment.dal");
    const { createDeploymentLogs } =
      await import("@repo/database/access-layer/deployment-logs.dal");
    const publicationPersistence =
      await import("@repo/database/access-layer/deployment-publication.dal");
    const { withAppLifecycleLock } =
      await import("@repo/database/access-layer/app-retirement.dal");
    const entered = gate();
    const release = gate();
    const persistence = {
      getDeployment,
      updateDeployment,
      saveDeploymentCleanup,
      createDeploymentLogs,
      ...publicationPersistence,
    };
    const execute = createDeploymentExecutor({
      ...dockerFixture.dependencies,
      ...persistence,
      ...createDockerCommandAdapter({
        ...persistence,
        getDocker: dockerFixture.dependencies.getDocker,
      }),
      withAppLifecycleLock,
      // GitHub credential acquisition is an external boundary. Hold the actual
      // execution there while retirement arrives from another request process.
      getCloneUrl: async () => {
        entered.resolve();
        await release.promise;
        return "https://fixture.invalid/repo.git";
      },
    });
    const running = execute({ userId, deploymentId: resource.deploymentId });
    await entered.promise;
    const retiring = caller.app.delete({ appId: resource.appId });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        (await caller.app.get({ appId: resource.appId })).appName,
        "Private app",
        "retirement must wait for execution to relinquish the app",
      );
    } finally {
      release.resolve();
      await Promise.allSettled([running, retiring]);
    }
    assert.equal((await retiring).retirement?.status, "complete");
    await assert.rejects(
      execute({ userId, deploymentId: resource.deploymentId }),
      /Deployment not found/,
    );
    const freshExecutor = createDeploymentExecutor({
      ...dockerFixture.dependencies,
      ...persistence,
      withAppLifecycleLock,
    });
    await assert.rejects(
      freshExecutor({ userId, deploymentId: resource.deploymentId }),
      /Deployment not found/,
    );
    assert.ok(
      !(await dockerFixture.docker.listContainers({ all: true })).some(
        (item) => item.Labels["nmt.app-id"] === String(resource.appId),
      ),
    );

    // Both operation-only paths use the shared production adapter. Retirement
    // queues first at a real database lock; recovery must recheck after it wins.
    const { executeDeployment } =
      await import("../../worker/src/deployment/production-executor");
    for (const request of [
      { action: "cleanup" },
      { operation: "publish" },
    ] as const) {
      const pending = await resourceFixture(userId);
      const cleanup = { status: "complete" as const, artifacts: [] };
      await saveDeploymentCleanup(pending.deploymentId, cleanup, userId);
      await publicationPersistence.recordPublication(
        {
          deploymentId: pending.deploymentId,
          imageId: "saved-image",
          imageName: "ghcr.io/fixture/saved:1",
        },
        userId,
      );
      const before = await fixtures.query(
        `SELECT d.*, row_to_json(p) AS publication FROM "Deployments" d JOIN "DeploymentPublications" p ON p."deploymentId" = d.id WHERE d.id = $1`,
        [pending.deploymentId],
      );
      const holder = new Client({
        connectionString: process.env.AUTH_TEST_DATABASE_URL,
      });
      await holder.connect();
      const waiting = async (count: number) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const result = await fixtures.query<{ count: number }>(
            "SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND classid = 2121 AND objid = $1 AND NOT granted",
            [pending.appId],
          );
          if (result.rows[0]!.count >= count) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail(
          `Expected ${count} lifecycle waiters for ${JSON.stringify(request)}`,
        );
      };
      let retiringOperation: ReturnType<typeof caller.app.delete> | undefined;
      let recovery: Promise<unknown> | undefined;
      try {
        await holder.query("SELECT pg_advisory_lock(2121, $1)", [
          pending.appId,
        ]);
        retiringOperation = caller.app.delete({ appId: pending.appId });
        await waiting(1);
        recovery = executeDeployment({
          ...request,
          userId,
          deploymentId: pending.deploymentId,
        });
        void recovery.catch(() => {});
        await waiting(2);
      } finally {
        await holder.end();
        await Promise.allSettled([retiringOperation, recovery]);
      }
      assert.equal((await retiringOperation!).retirement?.status, "complete");
      await assert.rejects(recovery!, /(?:Deployment|Publication) not found/);
      const after = await fixtures.query(
        `SELECT d.*, row_to_json(p) AS publication FROM "Deployments" d JOIN "DeploymentPublications" p ON p."deploymentId" = d.id WHERE d.id = $1`,
        [pending.deploymentId],
      );
      assert.ok(after.rows[0].modifiedAt >= before.rows[0].modifiedAt);
      assert.deepEqual(after.rows[0], {
        ...before.rows[0],
        resourceStatus: "inactive",
        modifiedBy: userId,
        modifiedAt: after.rows[0].modifiedAt,
      });
      await assert.rejects(
        caller.deployment.publication({ deploymentId: pending.deploymentId }),
        { code: "NOT_FOUND" },
      );
      await assert.rejects(caller.app.get({ appId: pending.appId }), {
        code: "NOT_FOUND",
      });
      assert.equal(
        (await caller.app.retirementStatus({ appId: pending.appId }))
          .resourceStatus,
        "inactive",
      );
    }
  },
);

async function restartRequest(appId: number, userId: string, retry = false) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./tests/server-only.mjs",
      "--import",
      "tsx",
      "tests/fixtures/retirement-request.mjs",
      String(appId),
      userId,
      ...(retry ? ["retry"] : []),
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      timeout: 20000,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(
          new URL("../tsconfig.json", import.meta.url),
        ),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    errors += data;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, `${errors}\n${output}`);
  return JSON.parse(output.trim().split("\n").at(-1)!);
}

test(
  "failed cleanup remains owner-visible after process restart and retry converges",
  { timeout: 60000 },
  async () => {
    const userId = "cleanup-recovery-owner";
    const caller = owner(userId);
    const resource = await resourceFixture(userId);
    const runtime = await seedRuntime(resource.appId, resource.deploymentId);
    cleanupFailures[runtime.id] = "fixture-host-secret must stay private";
    const retired = await caller.app.delete({ appId: resource.appId });
    assert.equal(retired.resourceStatus, "inactive");
    assert.equal(retired.retirement?.status, "pending");
    assert.ok(!JSON.stringify(retired).includes("fixture-host-secret"));
    assert.equal(
      (await dockerFixture.docker.getContainer(runtime.id).inspect()).State
        .Running,
      true,
    );
    const refreshed = await restartRequest(resource.appId, userId);
    assert.deepEqual(refreshed.retirement, retired.retirement);
    await assert.rejects(caller.app.get({ appId: resource.appId }), {
      code: "NOT_FOUND",
    });
    delete cleanupFailures[runtime.id];
    const recovered = await restartRequest(resource.appId, userId, true);
    assert.equal(recovered.retirement.status, "complete");
    await assert.rejects(
      dockerFixture.docker.getContainer(runtime.id).inspect(),
      { statusCode: 404 },
    );
    assert.deepEqual(
      (await caller.app.delete({ appId: resource.appId })).retirement,
      recovered.retirement,
    );
  },
);

test("foreign and anonymous identities cannot retire, inspect recovery, or use host administration", async () => {
  const resource = await resourceFixture("denied-retirement-owner");
  const before = hostRequests.length;
  const anonymous = appRouter.createCaller({ userInfo: { user: null } });
  const foreign = owner("denied-foreign-owner");
  for (const [caller, code] of [
    [foreign, "NOT_FOUND"],
    [anonymous, "UNAUTHORIZED"],
  ] as const) {
    await assert.rejects(caller.app.delete({ appId: resource.appId }), {
      code,
    });
    await assert.rejects(
      caller.app.retirementStatus({ appId: resource.appId }),
      { code },
    );
  }
  await assert.rejects(
    owner("denied-retirement-owner").admin.deleteResource({
      resource: "containers",
      id: `deployment-${resource.deploymentId}`,
    }),
    { code: "FORBIDDEN" },
  );
  assert.equal(hostRequests.length, before);
  assert.equal(
    (await owner("denied-retirement-owner").app.get({ appId: resource.appId }))
      .resourceStatus,
    "active",
  );
  await owner("denied-retirement-owner").app.delete({ appId: resource.appId });
  await assert.rejects(
    foreign.app.retirementStatus({ appId: resource.appId }),
    { code: "NOT_FOUND" },
  );
});

test("a visibility write failure rolls retirement back before host cleanup", async () => {
  const userId = "rollback-retirement-owner";
  const caller = owner(userId);
  const resource = await resourceFixture(userId);
  await fixtures.query(
    `CREATE FUNCTION reject_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."appId" = ${resource.appId} AND NEW."resourceStatus" = 'inactive' THEN RAISE EXCEPTION 'fixture retirement write rejected'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_retirement BEFORE UPDATE ON "AppDomains" FOR EACH ROW EXECUTE FUNCTION reject_retirement()`,
  );
  const before = hostRequests.length;
  try {
    await assert.rejects(
      caller.app.delete({ appId: resource.appId }),
      /Failed query/,
    );
  } finally {
    await fixtures.query(
      `DROP TRIGGER reject_retirement ON "AppDomains"; DROP FUNCTION reject_retirement()`,
    );
  }
  assert.equal(hostRequests.length, before);
  const app = await caller.app.get({ appId: resource.appId });
  assert.equal(app.resourceStatus, "active");
  assert.equal(app.retirement, null);
  assert.equal(app.appDomains[0]?.resourceStatus, "active");
  assert.equal(app.deployments[0]?.resourceStatus, "active");
  const history = await caller.app.deploymentLogs({
    appId: resource.appId,
    deploymentId: resource.deploymentId,
  });
  assert.equal(history.hasMore, false);
  assert.deepEqual(
    history.logs.map((log) => log.message),
    ["private persisted log"],
  );
});

test(
  "a refreshed retired app page shows persisted pending cleanup and an owner retry action",
  { timeout: 30000 },
  async (t) => {
    const userId = "retirement-view-owner";
    const resource = await resourceFixture(userId);
    const runtime = await seedRuntime(resource.appId, resource.deploymentId);
    cleanupFailures[runtime.id] = "fixture-host-secret";
    await owner(userId).app.delete({ appId: resource.appId });
    const { createExpressMiddleware } =
      await import("@trpc/server/adapters/express");
    const application = express();
    application.use(
      "/trpc",
      createExpressMiddleware({
        router: appRouter,
        createContext: () => ({ userInfo: ownerInfo(userId) }),
      }),
    );
    const server = createServer(application);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const { JSDOM } = createRequire(import.meta.url)("jsdom");
    const dom = new JSDOM(
      "<!doctype html><html><body><div id='root'></div></body></html>",
      { url: "http://localhost", pretendToBeVisual: true },
    );
    for (const key of [
      "window",
      "self",
      "document",
      "navigator",
      "HTMLElement",
      "Element",
      "Node",
      "DocumentFragment",
      "MutationObserver",
      "Event",
      "MouseEvent",
      "CustomEvent",
      "getComputedStyle",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ]) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value: key === "window" ? dom.window : dom.window[key],
      });
    }
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const { createElement: h, act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } =
      await import("@tanstack/react-query");
    const { createTRPCClient, httpLink } = await import("@trpc/client");
    const { default: superjson } = await import("superjson");
    const { TRPCProvider } = await import("../src/trpc/client");
    const { AppRouterContext } =
      await import("next/dist/shared/lib/app-router-context.shared-runtime");
    const { SearchParamsContext } =
      await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
    const { default: AppDetails } =
      await import("../src/components/apps/app-details");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const client = createTRPCClient<typeof appRouter>({
      links: [
        httpLink({
          url: `http://127.0.0.1:${address.port}/trpc`,
          transformer: superjson,
        }),
      ],
    });
    const root = createRoot(dom.window.document.getElementById("root")!);
    t.after(async () => {
      await act(() => root.unmount());
      queryClient.clear();
      dom.window.close();
    });
    await act(() =>
      root.render(
        h(
          QueryClientProvider,
          { client: queryClient },
          h(
            TRPCProvider,
            { trpcClient: client, queryClient, children: null },
            h(
              AppRouterContext.Provider,
              {
                value: {
                  back() {},
                  forward() {},
                  push() {},
                  replace() {},
                  refresh() {},
                  prefetch() {},
                },
              },
              h(
                SearchParamsContext.Provider,
                { value: new URLSearchParams() },
                h(AppDetails, { appId: resource.appId }),
              ),
            ),
          ),
        ),
      ),
    );
    async function waitFor(text: RegExp) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (text.test(dom.window.document.body.textContent ?? "")) return;
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      }
      assert.match(dom.window.document.body.textContent ?? "", text);
    }
    await waitFor(/Runtime cleanup incomplete/);
    const retry = [...dom.window.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry cleanup",
    );
    assert.ok(retry, "retired app must expose owner cleanup recovery");
    delete cleanupFailures[runtime.id];
    await act(() =>
      retry.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      ),
    );
    await waitFor(/Owned runtime cleanup complete/);
    assert.ok(
      !dom.window.document.body.textContent.includes("fixture-host-secret"),
    );
    await assert.rejects(
      dockerFixture.docker.getContainer(runtime.id).inspect(),
      { statusCode: 404 },
    );
  },
);

test(
  "concurrent retirement requests converge without exhausting the application pool",
  { timeout: 5000 },
  async () => {
    const userId = "concurrent-retirement-owner";
    const resource = await resourceFixture(userId);
    await seedRuntime(resource.appId, resource.deploymentId);
    // An external database lock holds incoming sessions while the burst arrives.
    // After release every request must finish, even beyond the default pool size.
    await fixtures.query("SELECT pg_advisory_lock(2121, $1)", [resource.appId]);
    const requests = Array.from({ length: 12 }, () =>
      owner(userId).app.delete({ appId: resource.appId }),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await fixtures.query("SELECT pg_advisory_unlock(2121, $1)", [
        resource.appId,
      ]);
    }
    const results = await Promise.all(requests);
    assert.ok(
      results.every(
        (result) =>
          result.resourceStatus === "inactive" &&
          result.retirement?.status === "complete",
      ),
    );
    await assert.rejects(
      dockerFixture.docker
        .getContainer(`deployment-${resource.deploymentId}`)
        .inspect(),
      { statusCode: 404 },
    );
  },
);
