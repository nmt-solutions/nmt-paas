import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { after, mock, test } from "node:test";
import type { UserInfo } from "@workos-inc/authkit-nextjs";
import { Client } from "pg";
import {
  consumeRuntimeLogStream,
  encodeRuntimeLogEvent,
  type RuntimeLogEvent,
} from "@repo/api-sdk/runtime-logs";

assert.ok(process.env.AUTH_TEST_DATABASE_URL, "Run npm run test:eligibility");
const hostRequests: string[] = [];
const host = createServer((request, response) => {
  assert.equal(request.headers.authorization, "Bearer fixture-host-key");
  hostRequests.push(`${request.method} ${request.url}`);
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
  response.end(JSON.stringify({ status: "success", data: true }));
});
await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
const address = host.address();
assert.ok(address && typeof address !== "string");
Object.assign(process.env, {
  APP_ENV: "development",
  DB_ENV: "development",
  DOTENV_CONFIG_PATH: "__eligibility_test_no_dotenv__",
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

let authenticatedUser: string | null = "eligibility-owner";
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
  await fixtures.end();
  await new Promise<void>((resolve, reject) =>
    host.close((error) => (error ? reject(error) : resolve())),
  );
});

function owner(userId: string) {
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
  return appRouter.createCaller({ userInfo });
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
    [app.id, `eligibility-${repoId}.invalid`, userId],
  );
  return {
    projectId: project.id,
    appId: app.id,
    repoId,
    deploymentId: deployment.id,
  };
}

test("an active child of an inactive project cannot be read or redeployed", async () => {
  const userId = "retired-project-owner";
  const caller = owner(userId);
  const resource = await resourceFixture(userId);
  assert.equal(
    (await caller.app.get({ appId: resource.appId })).appName,
    "Private app",
  );
  await fixtures.query(
    `UPDATE "Projects" SET "resourceStatus" = 'inactive' WHERE id = $1`,
    [resource.projectId],
  );
  assert.deepEqual(await caller.project.list(), []);
  await assert.rejects(caller.app.get({ appId: resource.appId }), {
    code: "NOT_FOUND",
  });
  await assert.rejects(caller.app.redeploy({ appId: resource.appId }), {
    code: "NOT_FOUND",
  });
});

test("project polling excludes a retired child while preserving its active sibling", async () => {
  const userId = "retired-app-owner";
  const caller = owner(userId);
  const resource = await resourceFixture(userId);
  const sibling = (
    await fixtures.query<{ id: number }>(
      `INSERT INTO "Apps" ("appName", "projectId", "gitProvider", "repoId", "createdBy") VALUES ('Active sibling', $1, 'github', 30000, $2) RETURNING id`,
      [resource.projectId, userId],
    )
  ).rows[0]!;
  assert.equal((await caller.project.list())[0]?.apps.length, 2);
  await fixtures.query(
    `UPDATE "Apps" SET "resourceStatus" = 'inactive' WHERE id = $1`,
    [resource.appId],
  );
  const projects = await caller.project.list();
  assert.deepEqual(
    projects.map((project) => ({
      id: project.id,
      apps: project.apps.map((app) => app.id),
    })),
    [{ id: resource.projectId, apps: [sibling.id] }],
  );
  await assert.rejects(caller.app.get({ appId: resource.appId }), {
    code: "NOT_FOUND",
  });
  assert.equal(
    (await caller.app.get({ appId: sibling.id })).appName,
    "Active sibling",
  );
});

test("latest-success and runtime logs enforce active ancestry and keep the host credential server-side", async () => {
  const { GET } =
    await import("../src/app/api/apps/[appId]/runtime-logs/route");
  const userId = "runtime-owner";
  const caller = owner(userId);
  const resource = await resourceFixture(userId);
  const logs = () =>
    GET(
      new Request(`http://web.test/api/apps/${resource.appId}/runtime-logs`),
      {
        params: Promise.resolve({ appId: String(resource.appId) }),
      },
    );
  authenticatedUser = userId;
  assert.equal(
    (await caller.app.getLatestSuccessDeployment({ appId: resource.appId }))
      ?.id,
    resource.deploymentId,
  );
  const response = await logs();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("authorization"), null);
  const events: RuntimeLogEvent[] = [];
  await consumeRuntimeLogStream(response.body!, (event) => events.push(event));
  assert.deepEqual(events, [
    { type: "runtime", deploymentId: resource.deploymentId },
    { type: "log", text: "fixture runtime output" },
    { type: "end", reason: "eof" },
  ]);
  const requestsBeforeDenial = hostRequests.length;
  for (const state of [
    "inactive-project",
    "inactive-app",
    "foreign-project",
    "foreign-app",
    "foreign-owner",
    "anonymous",
  ]) {
    await fixtures.query(
      `UPDATE "Projects" SET "resourceStatus" = $1 WHERE id = $2`,
      [
        state === "inactive-project" ? "inactive" : "active",
        resource.projectId,
      ],
    );
    await fixtures.query(
      `UPDATE "Apps" SET "resourceStatus" = $1 WHERE id = $2`,
      [state === "inactive-app" ? "inactive" : "active", resource.appId],
    );
    await fixtures.query(`UPDATE "Projects" SET "userId" = $1 WHERE id = $2`, [
      state === "foreign-project" ? "runtime-foreign" : userId,
      resource.projectId,
    ]);
    await fixtures.query(`UPDATE "Apps" SET "createdBy" = $1 WHERE id = $2`, [
      state === "foreign-app" ? "runtime-foreign" : userId,
      resource.appId,
    ]);
    authenticatedUser =
      state === "anonymous"
        ? null
        : state === "foreign-owner"
          ? "runtime-foreign"
          : userId;
    const requestCaller = authenticatedUser
      ? owner(authenticatedUser)
      : appRouter.createCaller({ userInfo: { user: null } });
    if (authenticatedUser) {
      assert.equal(
        await requestCaller.app.getLatestSuccessDeployment({
          appId: resource.appId,
        }),
        undefined,
        state,
      );
    } else {
      await assert.rejects(
        requestCaller.app.getLatestSuccessDeployment({ appId: resource.appId }),
        { code: "UNAUTHORIZED" },
      );
    }
    const denied = await logs();
    assert.equal(denied.status, state === "anonymous" ? 401 : 404, state);
    assert.doesNotMatch(
      await denied.text(),
      /fixture-host-key|fixture runtime output|private persisted log/,
    );
  }
  assert.equal(hostRequests.length, requestsBeforeDenial);
});

const frameworkConfig = {
  framework: "node",
  rootDirectory: "./",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  startCommand: "node dist/server.js",
  outputDirectory: "dist",
  port: 3000,
};

test("repository-based admission cannot recreate a retired app or bypass an inactive project", async () => {
  for (const state of ["inactive-project", "inactive-app"]) {
    const userId = `admission-${state}`;
    const caller = owner(userId);
    const resource = await resourceFixture(userId);
    await fixtures.query(
      `INSERT INTO "GithubAppInstallations" ("installationId", "userId", "createdBy", state) VALUES (456, $1, $1, 'completed')`,
      [userId],
    );
    const input = {
      repoId: resource.repoId,
      repo: "fixture",
      owner: "fixture-owner",
      branch: "release",
      frameworkConfig,
    };
    const accepted = await caller.deployment.deploy(input);
    assert.equal(accepted.appId, resource.appId);
    assert.equal(
      (await caller.app.get({ appId: resource.appId })).deployments.some(
        (deployment) =>
          deployment.id === accepted.deploymentId &&
          deployment.commit === "fresh-fixture-commit",
      ),
      true,
    );
    if (state === "inactive-project") {
      await fixtures.query(
        `UPDATE "Projects" SET "resourceStatus" = 'inactive' WHERE id = $1`,
        [resource.projectId],
      );
    } else {
      await fixtures.query(
        `UPDATE "Apps" SET "resourceStatus" = 'inactive' WHERE id = $1`,
        [resource.appId],
      );
    }
    const requestsBefore = [hostRequests.length, githubRequests.length];
    await assert.rejects(
      caller.deployment.deploy(input),
      { code: "NOT_FOUND" },
      state,
    );
    assert.deepEqual(
      [hostRequests.length, githubRequests.length],
      requestsBefore,
    );
    const visibleApps = (await caller.project.list()).flatMap(
      (project) => project.apps,
    );
    assert.deepEqual(visibleApps, []);
  }
});

test("queued delivery after retirement cannot start a runtime or alter deployment history", async (t) => {
  const { createDeploymentExecutor } =
    await import("../../worker/src/deployment/execute-deployment");
  const { deploymentFixture } =
    await import("../../worker/test/fixtures/deployment");
  const { createDockerCommandAdapter } =
    await import("../../worker/src/deployment/docker-command-adapter");
  const { getDeployment, updateDeployment } =
    await import("@repo/database/access-layer/deployment.dal");
  const { createDeploymentLogs } =
    await import("@repo/database/access-layer/deployment-logs.dal");
  const docker = await deploymentFixture();
  t.after(docker.close);
  const publicationPersistence =
    await import("@repo/database/access-layer/deployment-publication.dal");
  const persistence = {
    ...publicationPersistence,
    getDeployment,
    updateDeployment,
    createDeploymentLogs,
  };
  const publicationPersistence =
    await import("@repo/database/access-layer/deployment-publication.dal");
  const execute = createDeploymentExecutor({
    ...docker.dependencies,
    ...publicationPersistence,
    ...persistence,
    ...createDockerCommandAdapter({
      ...persistence,
      getDocker: docker.dependencies.getDocker,
    }),
  });
  for (const state of [
    "inactive-project",
    "inactive-app",
    "foreign-delivery",
    "foreign-project",
    "foreign-app",
    "foreign-deployment",
    "inactive-deployment",
  ]) {
    const userId = `queued-owner-${state}`;
    const caller = owner(userId);
    const resource = await resourceFixture(userId);
    const queued = (
      await fixtures.query<{ id: number }>(
        `INSERT INTO "Deployments" ("appId", "repoId", branch, commit, env, "userId", "createdBy") VALUES ($1, $2, 'release', 'recorded-commit', 'production', $3, $3) RETURNING id`,
        [resource.appId, resource.repoId, userId],
      )
    ).rows[0]!;
    if (state === "inactive-project")
      await fixtures.query(
        `UPDATE "Projects" SET "resourceStatus" = 'inactive' WHERE id = $1`,
        [resource.projectId],
      );
    if (state === "inactive-app")
      await fixtures.query(
        `UPDATE "Apps" SET "resourceStatus" = 'inactive' WHERE id = $1`,
        [resource.appId],
      );
    if (state === "foreign-project")
      await fixtures.query(
        `UPDATE "Projects" SET "userId" = 'another-owner' WHERE id = $1`,
        [resource.projectId],
      );
    if (state === "foreign-app")
      await fixtures.query(
        `UPDATE "Apps" SET "createdBy" = 'another-owner' WHERE id = $1`,
        [resource.appId],
      );
    if (state === "foreign-deployment")
      await fixtures.query(
        `UPDATE "Deployments" SET "userId" = 'another-owner' WHERE id = $1`,
        [queued.id],
      );
    if (state === "inactive-deployment")
      await fixtures.query(
        `UPDATE "Deployments" SET "resourceStatus" = 'inactive' WHERE id = $1`,
        [queued.id],
      );
    await assert.rejects(
      execute({
        userId: state === "foreign-delivery" ? "another-owner" : userId,
        deploymentId: queued.id,
      }),
      /Deployment not found/,
      state,
    );
    assert.deepEqual(
      (await docker.docker.listContainers({ all: true }))
        .map((container) => container.Id)
        .sort(),
      ["previous", "unrelated"],
      state,
    );
    assert.equal(docker.images.size, 0, state);
    await fixtures.query(
      `UPDATE "Projects" SET "resourceStatus" = 'active', "userId" = $1 WHERE id = $2`,
      [userId, resource.projectId],
    );
    await fixtures.query(
      `UPDATE "Apps" SET "resourceStatus" = 'active', "createdBy" = $1 WHERE id = $2`,
      [userId, resource.appId],
    );
    await fixtures.query(
      `UPDATE "Deployments" SET "resourceStatus" = 'active', "userId" = $1 WHERE id = $2`,
      [userId, queued.id],
    );
    const unchanged = (
      await caller.app.get({ appId: resource.appId })
    ).deployments.find((deployment) => deployment.id === queued.id);
    assert.equal(unchanged?.status, "queued", state);
    assert.deepEqual(unchanged?.deploymentLogs, [], state);
  }
});

test("retirement during repository resolution rejects admission before creating or dispatching a deployment", async () => {
  const userId = "retirement-during-admission";
  const caller = owner(userId);
  const resource = await resourceFixture(userId);
  await fixtures.query(
    `INSERT INTO "GithubAppInstallations" ("installationId", "userId", "createdBy", state) VALUES (456, $1, $1, 'completed')`,
    [userId],
  );
  const requestsBefore = hostRequests.length;
  beforeCommitResponse = async () => {
    await fixtures.query(
      `UPDATE "Projects" SET "resourceStatus" = 'inactive' WHERE id = $1`,
      [resource.projectId],
    );
  };
  try {
    await assert.rejects(caller.app.redeploy({ appId: resource.appId }), {
      code: "NOT_FOUND",
    });
  } finally {
    beforeCommitResponse = undefined;
    await fixtures.query(
      `UPDATE "Projects" SET "resourceStatus" = 'active' WHERE id = $1`,
      [resource.projectId],
    );
  }
  assert.equal(hostRequests.length, requestsBefore);
  assert.deepEqual(
    (await caller.app.get({ appId: resource.appId })).deployments.map(
      (deployment) => deployment.id,
    ),
    [resource.deploymentId],
  );
});

test("execution discards an eligible snapshot retired before it acquires the app turn", async (t) => {
  const { createDeploymentExecutor } =
    await import("../../worker/src/deployment/execute-deployment");
  const { deploymentFixture } =
    await import("../../worker/test/fixtures/deployment");
  const { getDeployment, updateDeployment } =
    await import("@repo/database/access-layer/deployment.dal");
  const { createDeploymentLogs } =
    await import("@repo/database/access-layer/deployment-logs.dal");
  const docker = await deploymentFixture();
  t.after(docker.close);
  const userId = "retired-snapshot-owner";
  const resource = await resourceFixture(userId);
  let retireSnapshot = true;
  const execute = createDeploymentExecutor({
    ...docker.dependencies,
    updateDeployment,
    createDeploymentLogs,
    getDeployment: async (id, ownerId) => {
      const snapshot = await getDeployment(id, ownerId);
      // Retire at the persistence boundary after the read took its snapshot.
      if (retireSnapshot) {
        retireSnapshot = false;
        await fixtures.query(
          `UPDATE "Projects" SET "resourceStatus" = 'inactive' WHERE id = $1`,
          [resource.projectId],
        );
      }
      return snapshot;
    },
  });
  await assert.rejects(
    execute({ userId, deploymentId: resource.deploymentId }),
    /Deployment not found/,
  );
  assert.deepEqual(
    (await docker.docker.listContainers({ all: true }))
      .map((container) => container.Id)
      .sort(),
    ["previous", "unrelated"],
  );
  await fixtures.query(
    `UPDATE "Projects" SET "resourceStatus" = 'active' WHERE id = $1`,
    [resource.projectId],
  );
  const deployment = (await owner(userId).app.get({ appId: resource.appId }))
    .deployments[0];
  assert.equal(deployment?.status, "success");
  assert.deepEqual(
    deployment?.deploymentLogs.map((log) => log.message),
    ["private persisted log"],
  );
});

test("foreign and unauthenticated callers receive no private app data or host access", async () => {
  const resource = await resourceFixture("private-resource-owner");
  const requestsBefore = [hostRequests.length, githubRequests.length];
  const foreign = owner("private-resource-foreign");
  const anonymous = appRouter.createCaller({ userInfo: { user: null } });
  for (const [caller, code] of [
    [foreign, "NOT_FOUND"],
    [anonymous, "UNAUTHORIZED"],
  ] as const) {
    const workflows = [
      () => caller.app.get({ appId: resource.appId }),
      () => caller.app.redeploy({ appId: resource.appId }),
      () =>
        caller.app.updateConfig({
          appId: resource.appId,
          appName: "Changed",
          ...frameworkConfig,
        }),
      () =>
        caller.app.addEnvVar({
          appId: resource.appId,
          key: "PRIVATE",
          value: "fixture",
        }),
      () => caller.app.deleteEnvVar({ appId: resource.appId, envVarId: 1 }),
      () => caller.app.delete({ appId: resource.appId }),
    ];
    for (const workflow of workflows)
      await assert.rejects(workflow(), { code });
  }
  assert.deepEqual(await foreign.project.list(), []);
  await assert.rejects(anonymous.project.list(), { code: "UNAUTHORIZED" });
  const input = {
    repoId: resource.repoId,
    repo: "fixture",
    owner: "fixture-owner",
    branch: "release",
  };
  await assert.rejects(anonymous.deployment.deploy(input), {
    code: "UNAUTHORIZED",
  });
  await assert.rejects(foreign.deployment.deploy(input), {
    code: "BAD_REQUEST",
    message: "Framework configuration is required for first time deployment",
  });
  assert.deepEqual(
    [hostRequests.length, githubRequests.length],
    requestsBefore,
  );
  assert.equal(
    (await owner("private-resource-owner").app.get({ appId: resource.appId }))
      .appName,
    "Private app",
  );
});

test("app ownership cannot bypass a foreign parent project and project ownership cannot expose a foreign app", async () => {
  const userId = "mismatched-app-owner";
  const resource = await resourceFixture(userId);
  await fixtures.query(
    `UPDATE "Projects" SET "userId" = 'mismatched-project-owner' WHERE id = $1`,
    [resource.projectId],
  );
  const appOwner = owner(userId);
  const projectOwner = owner("mismatched-project-owner");
  await assert.rejects(appOwner.app.get({ appId: resource.appId }), {
    code: "NOT_FOUND",
  });
  await assert.rejects(projectOwner.app.get({ appId: resource.appId }), {
    code: "NOT_FOUND",
  });
  assert.equal(
    await appOwner.app.getLatestSuccessDeployment({ appId: resource.appId }),
    undefined,
  );
  assert.equal(
    await projectOwner.app.getLatestSuccessDeployment({
      appId: resource.appId,
    }),
    undefined,
  );
  assert.deepEqual(await appOwner.project.list(), []);
  assert.deepEqual(
    (await projectOwner.project.list()).map((project) => ({
      id: project.id,
      apps: project.apps,
    })),
    [{ id: resource.projectId, apps: [] }],
  );
  await assert.rejects(
    appOwner.deployment.deploy({
      repoId: resource.repoId,
      repo: "fixture",
      owner: "fixture-owner",
      branch: "release",
      frameworkConfig,
    }),
    { code: "NOT_FOUND" },
  );
});
