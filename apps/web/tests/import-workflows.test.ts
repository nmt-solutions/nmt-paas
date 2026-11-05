import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { after, mock, test } from "node:test";
import type { UserInfo } from "@workos-inc/authkit-nextjs";
import { Client } from "pg";

assert.ok(
  process.env.IMPORT_TEST_DATABASE_URL,
  "Run through npm run test:import",
);
const fixtures = new Client({
  connectionString: process.env.IMPORT_TEST_DATABASE_URL,
});
await fixtures.connect();
const queued: { deploymentId: number; userId: string }[] = [];
let hostUnavailable = false;
const networkTransactions: { boundary: string; count: number }[] = [];
async function observeTransactions(boundary: string) {
  const { rows } = await fixtures.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name = $1 AND xact_start IS NOT NULL AND pid <> pg_backend_pid()`,
    [
      new URL(process.env.IMPORT_TEST_DATABASE_URL!).searchParams.get(
        "application_name",
      ),
    ],
  );
  networkTransactions.push({ boundary, count: rows[0]!.count });
}
const host = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, "Bearer fixture-host-key");
  assert.equal(request.url, "/deployments/queue");
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  await observeTransactions("deployment host");
  if (hostUnavailable) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "error",
        statusCode: 503,
        message: "fixture-secret unavailable",
        data: null,
      }),
    );
    return;
  }
  queued.push(JSON.parse(Buffer.concat(chunks).toString()));
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({ status: "success", statusCode: 200, data: true }),
  );
});
await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
const address = host.address();
assert.ok(address && typeof address !== "string");
Object.assign(process.env, {
  APP_ENV: "development",
  DB_ENV: "development",
  DOTENV_CONFIG_PATH: "__import_test_no_dotenv__",
  WORKOS_CLIENT_ID: "client_fixture",
  WORKOS_API_KEY: "sk_test_fixture",
  WORKOS_COOKIE_PASSWORD: "fixture-cookie-password-at-least-32-characters",
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  GITHUB_APP_ID: "123",
  GITHUB_APP_SLUG: "fixture-app",
  GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
  ENV_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
  DEV_DATABASE_URL: process.env.IMPORT_TEST_DATABASE_URL,
  PROD_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/unused",
  BASE_DOMAIN: "fixture.localhost",
  API_KEY: "fixture-host-key",
  API_BASE_URL: `http://127.0.0.1:${address.port}`,
});
const { appRouter } = await import("../src/trpc/routers/_app");
let branchHead = "a".repeat(40);
let repositoryUnavailable = false;
let branchUnavailable = false;
mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  assert.equal(
    url.hostname,
    "api.github.com",
    "Only fixture GitHub requests are allowed",
  );
  const json = (data: unknown, status = 200) => {
    const response = Response.json(data, { status });
    Object.defineProperty(response, "url", { value: url.toString() });
    return response;
  };
  if (url.pathname === "/apps/fixture-app")
    return json({ id: 123, name: "Fixture App", slug: "fixture-app" });
  if (url.pathname === "/app/installations/456")
    return json({
      id: 456,
      account: { id: 99, login: "fixture-owner" },
      suspended_by: null,
    });
  if (url.pathname === "/app/installations/456/access_tokens")
    return json(
      { token: "ghs_fixture", expires_at: "2099-01-01T00:00:00Z" },
      201,
    );
  if (
    url.pathname === "/repos/fixture-owner/fixture-repo" ||
    url.pathname === "/repositories/12345"
  ) {
    await observeTransactions("GitHub repository");
    if (repositoryUnavailable)
      return json({ message: "fixture-secret access denied" }, 404);
    return json({
      id: 12345,
      name: "fixture-repo",
      owner: { login: "fixture-owner" },
      html_url: "https://github.com/fixture-owner/fixture-repo",
      default_branch: "main",
    });
  }
  if (
    decodeURIComponent(url.pathname) ===
    "/repos/fixture-owner/fixture-repo/commits/release/candidate"
  ) {
    await observeTransactions("GitHub commit");
    if (branchUnavailable)
      return json({ message: "fixture-secret missing branch" }, 404);
    return json({ sha: branchHead });
  }
  if (url.pathname === "/repos/fixture-owner/fixture-repo/commits/main")
    return json({ sha: "b".repeat(40) });
  throw new Error(`Unexpected GitHub fixture request: ${url.pathname}`);
});
after(async () => {
  mock.restoreAll();
  await fixtures.end();
  await new Promise<void>((resolve, reject) =>
    host.close((error) => (error ? reject(error) : resolve())),
  );
});

async function owner(userId: string) {
  await fixtures.query(
    `INSERT INTO "GithubAppInstallations" ("userId", "createdBy", "installationId", state) VALUES ($1, $1, 456, 'completed')`,
    [userId],
  );
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
    permissions: [],
  };
  return appRouter.createCaller({ userInfo });
}
const importInput = {
  repoId: 12345,
  repo: "fixture-repo",
  owner: "fixture-owner",
  projectName: "Customer Portal",
  branch: "release/candidate",
  frameworkConfig: {
    framework: "nextjs",
    rootDirectory: "./apps/site",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    startCommand: "npm start",
    outputDirectory: ".next",
    port: 3000,
  },
  envVars: [{ key: "PRIVATE_TOKEN", value: "fixture-secret" }],
};

test("first import preserves the submitted name, nondefault branch, and complete app configuration", async () => {
  const caller = await owner("selected-configuration");
  const result = await caller.deployment.deploy(importInput);
  const projects = await caller.project.list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.name, "Customer Portal");
  assert.equal(projects[0]?.id, result.projectId);
  const app = await caller.app.get({ appId: result.appId });
  assert.equal(app.projectId, result.projectId);
  assert.equal(app.repoId, 12345);
  assert.deepEqual(
    app.deployments.map(({ id, branch, commit, status }) => ({
      id,
      branch,
      commit,
      status,
    })),
    [
      {
        id: result.deploymentId,
        branch: "release/candidate",
        commit: "a".repeat(40),
        status: "queued",
      },
    ],
  );
  for (const [key, value] of Object.entries(importInput.frameworkConfig))
    assert.equal(
      app.frameworkConfig?.[key as keyof typeof importInput.frameworkConfig],
      value,
    );
  assert.deepEqual(
    app.appDomains
      .map(({ domain, env }) => ({ domain, env }))
      .sort((a, b) => a.env.localeCompare(b.env)),
    [
      { domain: "fixture-repo-preview.fixture.localhost", env: "preview" },
      { domain: "fixture-repo.fixture.localhost", env: "production" },
    ],
  );
  assert.deepEqual(
    app.envVars.map(({ key, env }) => ({ key, env })),
    [{ key: "PRIVATE_TOKEN", env: "production" }],
  );
  assert.ok(!JSON.stringify(app).includes("fixture-secret"));
  assert.deepEqual(queued, [
    { deploymentId: result.deploymentId, userId: "selected-configuration" },
  ]);
  assert.deepEqual(networkTransactions, [
    { boundary: "GitHub repository", count: 0 },
    { boundary: "GitHub commit", count: 0 },
    { boundary: "deployment host", count: 0 },
  ]);
});

test("a host outage returns a durable deployment and the same submission recovers that identity", async () => {
  const caller = await owner("durable-outage");
  const input = {
    ...importInput,
    submissionId: "731de7e8-c319-435d-83c4-e679df9c7d3e",
  };
  hostUnavailable = true;
  try {
    const result = await caller.deployment.deploy(input);
    assert.equal(result.outcome, "uncertain");
    assert.equal(result.dispatchState, "pending");
    const app = await caller.app.get({ appId: result.appId });
    assert.deepEqual(
      app.deployments.map(({ id }) => id),
      [result.deploymentId],
    );
    hostUnavailable = false;
    const retried = await caller.deployment.deploy(input);
    assert.equal(retried.deploymentId, result.deploymentId);
    assert.equal(retried.appId, result.appId);
    assert.equal(retried.projectId, result.projectId);
    assert.equal((await caller.project.list()).length, 1);
    assert.equal(
      (await caller.app.get({ appId: result.appId })).deployments.length,
      1,
    );
    assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  } finally {
    hostUnavailable = false;
  }
});

for (const failure of [
  { name: "project", table: "Projects" },
  { name: "app", table: "Apps" },
  {
    name: "production domain",
    table: "AppDomains",
    condition: `WHEN (NEW.env = 'production')`,
  },
  {
    name: "preview domain",
    table: "AppDomains",
    condition: `WHEN (NEW.env = 'preview')`,
  },
  { name: "framework", table: "FrameworkConfig" },
  {
    name: "environment",
    table: "EnvVars",
    condition: `WHEN (NEW.key = 'SECOND_TOKEN')`,
  },
  { name: "deployment", table: "Deployments" },
  { name: "dispatch intent", table: "DeploymentDispatches" },
  { name: "commit", table: "Deployments", deferred: true },
]) {
  test(`a failed ${failure.name} write leaves no partial import and a retry can create a complete setup`, async () => {
    const caller = await owner(`${failure.name}-failure`);
    const queuedBefore = queued.length;
    const input = {
      ...importInput,
      envVars: [
        ...importInput.envVars,
        { key: "SECOND_TOKEN", value: "second-fixture-secret" },
      ],
    };
    await fixtures.query(
      `CREATE FUNCTION reject_import_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-secret setup failure'; END $$`,
    );
    await fixtures.query(
      failure.deferred
        ? `CREATE CONSTRAINT TRIGGER reject_import_write AFTER INSERT ON "${failure.table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_import_write()`
        : `CREATE TRIGGER reject_import_write BEFORE INSERT ON "${failure.table}" FOR EACH ROW ${failure.condition ?? ""} EXECUTE FUNCTION reject_import_write()`,
    );
    try {
      await assert.rejects(caller.deployment.deploy(input), {
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Unable to initialize project. Check your projects before retrying.",
      });
      assert.deepEqual(await caller.project.list(), []);
      assert.equal(queued.length, queuedBefore);
    } finally {
      await fixtures.query(
        `DROP TRIGGER reject_import_write ON "${failure.table}"; DROP FUNCTION reject_import_write()`,
      );
    }
    const result = await caller.deployment.deploy(input);
    const projects = await caller.project.list();
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.apps.length, 1);
    const app = await caller.app.get({ appId: result.appId });
    assert.ok(app.frameworkConfig);
    assert.equal(app.appDomains.length, 2);
    assert.equal(app.envVars.length, 2);
    assert.equal(app.deployments.length, 1);
    assert.equal(queued.length, queuedBefore + 1);
  });
}

test("a blank selected branch is rejected before creating import setup", async () => {
  const caller = await owner("invalid-branch");
  const queuedBefore = queued.length;
  await assert.rejects(
    caller.deployment.deploy({ ...importInput, branch: "  " }),
    { code: "BAD_REQUEST" },
  );
  assert.deepEqual(await caller.project.list(), []);
  assert.equal(queued.length, queuedBefore);
});

test("a reused submission rejects changed content without changing its accepted deployment", async () => {
  const caller = await owner("submission-conflict");
  const input = {
    ...importInput,
    submissionId: "6ac48e36-97aa-4b57-ae71-2f017de3a048",
  };
  const accepted = await caller.deployment.deploy(input);
  await assert.rejects(caller.deployment.deploy({ ...input, branch: "main" }), {
    code: "CONFLICT",
  });
  assert.deepEqual(
    (await caller.app.get({ appId: accepted.appId })).deployments.map(
      ({ id }) => id,
    ),
    [accepted.deploymentId],
  );
});

test("owners can find accepted work by submission identity without exposing its internal fingerprint", async () => {
  const caller = await owner("submission-owner");
  const foreign = await owner("submission-foreign");
  const submissionId = "dd206db2-c408-43ec-8cf1-317a1c0aa2ce";
  const accepted = await caller.deployment.deploy({
    ...importInput,
    submissionId,
  });
  const found = await caller.deployment.submission({ submissionId });
  assert.equal(found?.deploymentId, accepted.deploymentId);
  assert.equal(found?.outcome, "accepted");
  assert.ok(!JSON.stringify(found).includes("requestHash"));
  assert.equal(await foreign.deployment.submission({ submissionId }), null);
  await assert.rejects(
    appRouter
      .createCaller({ userInfo: { user: null } })
      .deployment.submission({ submissionId }),
    { code: "UNAUTHORIZED" },
  );
});

test("simultaneous duplicate imports share one complete admission", async () => {
  const caller = await owner("concurrent-submission");
  const input = {
    ...importInput,
    submissionId: "79fd06d1-3cf6-4293-ad90-f5fde58c2012",
  };
  const results = await Promise.all(
    Array.from({ length: 6 }, () => caller.deployment.deploy(input)),
  );
  assert.equal(
    new Set(results.map(({ deploymentId }) => deploymentId)).size,
    1,
  );
  const projects = await caller.project.list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.apps.length, 1);
  const app = await caller.app.get({ appId: results[0]!.appId });
  assert.equal(app.deployments.length, 1);
  assert.equal(app.appDomains.length, 2);
  assert.ok(app.frameworkConfig);
});

test("redeploy retries preserve the recorded fresh head even when GitHub becomes unavailable", async () => {
  const caller = await owner("retry-redeploy");
  const first = await caller.deployment.deploy(importInput);
  const input = {
    appId: first.appId,
    submissionId: "4f09d714-f43b-4790-8df8-bc73cdd169a4",
  };
  branchHead = "d".repeat(40);
  const accepted = await caller.app.redeploy(input);
  repositoryUnavailable = true;
  try {
    const retried = await caller.app.redeploy(input);
    assert.equal(retried.deploymentId, accepted.deploymentId);
    const app = await caller.app.get({ appId: first.appId });
    assert.equal(app.deployments.length, 2);
    assert.equal(
      app.deployments.find(({ id }) => id === accepted.deploymentId)?.commit,
      "d".repeat(40),
    );
  } finally {
    repositoryUnavailable = false;
    branchHead = "a".repeat(40);
  }
});

for (const failure of ["repository", "branch"]) {
  test(`an inaccessible ${failure} creates no setup and exposes no provider diagnostics`, async () => {
    const caller = await owner(`inaccessible-${failure}`);
    const queuedBefore = queued.length;
    repositoryUnavailable = failure === "repository";
    branchUnavailable = failure === "branch";
    try {
      await assert.rejects(caller.deployment.deploy(importInput), {
        code: failure === "repository" ? "BAD_REQUEST" : "BAD_GATEWAY",
        message:
          failure === "repository"
            ? "Repository not found"
            : "Unable to get repository commit",
      });
      assert.deepEqual(await caller.project.list(), []);
      assert.equal(queued.length, queuedBefore);
    } finally {
      repositoryUnavailable = false;
      branchUnavailable = false;
    }
  });
}

test("redeploy resolves the current head of the previous nondefault branch", async () => {
  const caller = await owner("fresh-redeploy");
  const first = await caller.deployment.deploy(importInput);
  branchHead = "c".repeat(40);
  try {
    const redeployed = await caller.app.redeploy({ appId: first.appId });
    assert.notEqual(redeployed.deploymentId, first.deploymentId);
    const app = await caller.app.get({ appId: first.appId });
    const latest = app.deployments.find(
      ({ id }) => id === redeployed.deploymentId,
    );
    assert.equal(latest?.branch, "release/candidate");
    assert.equal(latest?.commit, "c".repeat(40));
    assert.equal(
      app.deployments.find(({ id }) => id === first.deploymentId)?.commit,
      "a".repeat(40),
    );
    assert.equal((await caller.project.list()).length, 1);
    assert.deepEqual(queued.slice(-2), [
      { deploymentId: first.deploymentId, userId: "fresh-redeploy" },
      { deploymentId: redeployed.deploymentId, userId: "fresh-redeploy" },
    ]);
  } finally {
    branchHead = "a".repeat(40);
  }
});

test("omitted import configuration retains the legacy repository defaults", async () => {
  const caller = await owner("legacy-defaults");
  const result = await caller.deployment.deploy({
    ...importInput,
    projectName: undefined,
    branch: undefined,
    envVars: undefined,
  });
  assert.equal((await caller.project.list())[0]?.name, "fixture-repo-project");
  const app = await caller.app.get({ appId: result.appId });
  assert.equal(app.deployments[0]?.branch, "main");
  assert.equal(app.deployments[0]?.commit, "b".repeat(40));
  assert.deepEqual(app.envVars, []);
});

test("unauthenticated imports and blank project names create no setup", async () => {
  const anonymous = appRouter.createCaller({ userInfo: { user: null } });
  const caller = await owner("invalid-import");
  const queuedBefore = queued.length;
  await assert.rejects(anonymous.deployment.deploy(importInput), {
    code: "UNAUTHORIZED",
  });
  await assert.rejects(
    caller.deployment.deploy({ ...importInput, projectName: "  " }),
    { code: "BAD_REQUEST" },
  );
  assert.deepEqual(await caller.project.list(), []);
  assert.equal(queued.length, queuedBefore);
});
