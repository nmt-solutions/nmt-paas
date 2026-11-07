import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { after, mock, test } from "node:test";
import type { UserInfo } from "@workos-inc/authkit-nextjs";
import { Client } from "pg";

assert.ok(
  process.env.AUTH_TEST_DATABASE_URL,
  "Run tests through npm run test:auth",
);
const hostRequests: string[] = [];
const host = createServer((request, response) => {
  assert.equal(request.headers.authorization, "Bearer fixture-host-key");
  hostRequests.push(`${request.method} ${request.url}`);
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({ data: { health: "fixture-ok" }, success: true }),
  );
});
await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
const address = host.address();
assert.ok(address && typeof address !== "string");

// Fixture configuration only. Never load a developer's .env in this suite.
Object.assign(process.env, {
  APP_ENV: "development",
  DB_ENV: "development",
  DOTENV_CONFIG_PATH: "__auth_test_no_dotenv__",
  WORKOS_CLIENT_ID: "client_fixture",
  WORKOS_API_KEY: "sk_test_fixture",
  WORKOS_COOKIE_PASSWORD: "fixture-cookie-password-at-least-32-characters",
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  GITHUB_APP_ID: "123",
  GITHUB_APP_SLUG: "fixture-app",
  GITHUB_APP_CLIENT_ID: "Iv1.fixture",
  GITHUB_APP_CLIENT_SECRET: "fixture-oauth-secret",
  GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
  ENV_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  DEV_DATABASE_URL:
    process.env.AUTH_TEST_DATABASE_URL ??
    "postgres://fixture:fixture@127.0.0.1:1/fixture",
  PROD_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/unused",
  BASE_DOMAIN: "fixture.localhost",
  API_KEY: "fixture-host-key",
  API_BASE_URL: `http://127.0.0.1:${address.port}`,
});

const { appRouter } = await import("../src/trpc/routers/_app");

mock.method(
  globalThis,
  "fetch",
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const json = (data: unknown, init?: ResponseInit) => {
      const response = Response.json(data, init);
      Object.defineProperty(response, "url", { value: url.toString() });
      return response;
    };
    if (
      url.hostname === "github.com" &&
      url.pathname === "/login/oauth/access_token"
    ) {
      const body: { code: string } = JSON.parse(String(init?.body));
      if (body.code === "invalid-provider-code") {
        return json({
          error: "bad_verification_code",
          error_description: "fixture-oauth-secret must not escape",
        });
      }
      return json({
        access_token:
          body.code === "paginated-code" ? "ghu_paginated" : "ghu_fixture",
        token_type: "bearer",
        scope: "",
      });
    }
    assert.equal(
      url.hostname,
      "api.github.com",
      "Only fixture GitHub requests are allowed",
    );
    if (url.pathname === "/user/installations") {
      const token = new Headers(init?.headers).get("authorization");
      if (token === "token ghu_paginated" && !url.searchParams.has("page")) {
        return json(
          {
            total_count: 2,
            installations: [{ id: 111, app_id: 123, suspended_at: null }],
          },
          {
            headers: {
              link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"',
            },
          },
        );
      }
      assert.ok(
        token === "token ghu_fixture" || token === "token ghu_paginated",
      );
      return json({
        total_count: 1,
        installations: [{ id: 456, app_id: 123, suspended_at: null }],
      });
    }
    if (url.pathname === "/apps/fixture-app") {
      return json({ id: 123, name: "Fixture App", slug: "fixture-app" });
    }
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return json(
        { token: "ghs_fixture", expires_at: "2099-01-01T00:00:00Z" },
        { status: 201 },
      );
    }
    if (/^\/app\/installations\/\d+$/.test(url.pathname)) {
      return json({
        id: Number(url.pathname.split("/").at(-1)),
        app_id: 123,
        account: { id: 99, login: "fixture-owner" },
        suspended_by: null,
      });
    }
    throw new Error(
      `Unexpected GitHub fixture request: ${init?.method} ${url.pathname}`,
    );
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

function owner(userId: string, permissions: string[] = []) {
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
    permissions,
  };
  return appRouter.createCaller({ userInfo });
}

test("an AuthKit context without a user cannot enter protected workflows", async () => {
  const caller = appRouter.createCaller({ userInfo: { user: null } });
  const workflows = [
    () => caller.project.list(),
    () => caller.project.deleteProject({ projectId: 1 }),
    () => caller.app.get({ appId: 1 }),
    () => caller.app.getLatestSuccessDeployment({ appId: 1 }),
    () => caller.app.delete({ appId: 1 }),
    () => caller.app.redeploy({ appId: 1 }),
    () => caller.github.connectGithub(),
    () =>
      caller.github.verifyGithubInstall({
        installationId: "456",
        state: "a".repeat(64),
        code: "fixture",
      }),
    () =>
      caller.deployment.deploy({
        repoId: 1,
        repo: "fixture",
        owner: "fixture",
      }),
    () => caller.admin.host(),
    () =>
      caller.admin.deleteResource({ resource: "containers", id: "fixture" }),
  ];
  for (const workflow of workflows)
    await assert.rejects(workflow(), { code: "UNAUTHORIZED" });
});

test("foreign callback state cannot modify another owner's connection", async () => {
  const alice = owner("state-owner");
  const bob = owner("state-foreign");
  const state = new URL(
    (await alice.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(state);
  await assert.rejects(
    bob.github.verifyGithubInstall({
      installationId: "456",
      state,
      code: "valid-code",
    }),
    { code: "BAD_REQUEST" },
  );
  assert.deepEqual(await alice.github.getGithubConnected(), {
    connected: false,
  });
  assert.deepEqual(await bob.github.getGithubConnected(), { connected: false });
  await alice.github.verifyGithubInstall({
    installationId: "456",
    state,
    code: "valid-code",
  });
  assert.deepEqual(await alice.github.getGithubConnected(), {
    connected: true,
  });
});

test("malformed callback input cannot consume a valid connection attempt", async () => {
  const caller = owner("malformed-state");
  const state = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(state);
  await assert.rejects(
    // @ts-expect-error Exercise a callback whose wire input omits state.
    caller.github.verifyGithubInstall({
      installationId: "456",
      code: "valid-code",
    }),
    { code: "BAD_REQUEST" },
  );
  for (const invalid of ["", "1", "a".repeat(63), "a".repeat(64) + "junk"]) {
    await assert.rejects(
      caller.github.verifyGithubInstall({
        installationId: "456",
        state: invalid,
        code: "valid-code",
      }),
      { code: "BAD_REQUEST" },
    );
  }
  for (const installationId of [
    "",
    "456junk",
    "1.5",
    "-1",
    "0",
    "9007199254740992",
  ]) {
    await assert.rejects(
      caller.github.verifyGithubInstall({
        installationId,
        state,
        code: "valid-code",
      }),
      { code: "BAD_REQUEST" },
    );
  }
  await assert.rejects(
    caller.github.verifyGithubInstall({
      installationId: "456",
      state,
      code: "",
    }),
    { code: "BAD_REQUEST" },
  );
  await caller.github.verifyGithubInstall({
    installationId: "456",
    state,
    code: "valid-code",
  });
  assert.deepEqual(await caller.github.getGithubConnected(), {
    connected: true,
  });
});

test("an inactive connection attempt cannot be completed", async () => {
  const caller = owner("inactive-attempt");
  const state = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(state);
  await fixtures.query(
    `UPDATE "GithubAppInstallations" SET "resourceStatus" = 'inactive' WHERE "userId" = 'inactive-attempt'`,
  );
  await assert.rejects(
    caller.github.verifyGithubInstall({
      installationId: "456",
      state,
      code: "valid-code",
    }),
    { code: "BAD_REQUEST" },
  );
  assert.deepEqual(await caller.github.getGithubConnected(), {
    connected: false,
  });
});

test("GitHub access verification follows installation pagination", async () => {
  const caller = owner("paginated-access");
  const state = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(state);
  await caller.github.verifyGithubInstall({
    installationId: "456",
    state,
    code: "paginated-code",
  });
  assert.deepEqual(await caller.github.getGithubConnected(), {
    connected: true,
  });
});

test("a provider authorization failure cannot expose credentials or replace an existing connection", async () => {
  const caller = owner("provider-failure");
  const originalState = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(originalState);
  await caller.github.verifyGithubInstall({
    installationId: "456",
    state: originalState,
    code: "valid-code",
  });
  const state = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(state);
  await assert.rejects(
    caller.github.verifyGithubInstall({
      installationId: "456",
      state,
      code: "invalid-provider-code",
    }),
    {
      code: "BAD_GATEWAY",
      message:
        "Unable to verify GitHub authorization. Start Connect Github again.",
    },
  );
  assert.deepEqual(await caller.github.getGithubConnected(), {
    connected: true,
  });
});

test("an expired callback cannot connect the owner", async (t) => {
  const caller = owner("expired-state");
  const state = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(state);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 16 * 60 * 1000 });
  await assert.rejects(
    caller.github.verifyGithubInstall({
      installationId: "456",
      state,
      code: "valid-code",
    }),
    { code: "BAD_REQUEST" },
  );
  assert.deepEqual(await caller.github.getGithubConnected(), {
    connected: false,
  });
});

test("concurrent callbacks consume a connection attempt only once", async () => {
  const caller = owner("concurrent-callback");
  const state = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(state);
  const results = await Promise.allSettled([
    caller.github.verifyGithubInstall({
      installationId: "456",
      state,
      code: "code-one",
    }),
    caller.github.verifyGithubInstall({
      installationId: "456",
      state,
      code: "code-two",
    }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.deepEqual(await caller.github.getGithubConnected(), {
    connected: true,
  });
});

test("app and project requests preserve a foreign owner's resources", async () => {
  const alice = owner("resource-owner");
  const bob = owner("resource-foreign");
  const project = (
    await fixtures.query<{ id: number }>(
      `INSERT INTO "Projects" (name, "userId", "createdBy") VALUES ('Private project', 'resource-owner', 'resource-owner') RETURNING id`,
    )
  ).rows[0];
  assert.ok(project);
  const app = (
    await fixtures.query<{ id: number }>(
      `INSERT INTO "Apps" ("appName", "projectId", "gitProvider", "repoId", "createdBy") VALUES ('Private app', $1, 'github', 12345, 'resource-owner') RETURNING id`,
      [project.id],
    )
  ).rows[0];
  assert.ok(app);
  assert.deepEqual(await bob.project.list(), []);
  await assert.rejects(bob.app.get({ appId: app.id }), { code: "NOT_FOUND" });
  await assert.rejects(bob.app.delete({ appId: app.id }), {
    code: "NOT_FOUND",
  });
  await assert.rejects(bob.app.redeploy({ appId: app.id }), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    bob.app.addEnvVar({ appId: app.id, key: "PRIVATE", value: "fixture" }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(bob.project.deleteProject({ projectId: project.id }), {
    code: "NOT_FOUND",
  });
  assert.equal((await alice.app.get({ appId: app.id })).appName, "Private app");
  assert.equal((await alice.project.list())[0]?.name, "Private project");
});

test("host administration requires the separate admin permission", async () => {
  const ordinary = owner("ordinary-owner");
  const requestsBefore = hostRequests.length;
  await assert.rejects(ordinary.admin.host(), { code: "FORBIDDEN" });
  await assert.rejects(ordinary.admin.resources({ resource: "images" }), {
    code: "FORBIDDEN",
  });
  await assert.rejects(
    ordinary.admin.deleteResource({
      resource: "containers",
      id: "fixture-container",
    }),
    { code: "FORBIDDEN" },
  );
  assert.equal(hostRequests.length, requestsBefore);
  const admin = owner("administrator", ["admin"]);
  assert.equal((await admin.admin.host()).data.health, "fixture-ok");
  await admin.admin.resources({ resource: "volumes" });
  await admin.admin.deleteResource({
    resource: "containers",
    id: "fixture-container",
  });
  assert.deepEqual(hostRequests.slice(requestsBefore), [
    "GET /admin/host",
    "GET /admin/docker/volumes",
    "DELETE /admin/docker/containers/fixture-container",
  ]);
});

test("a completed callback cannot be reused to replace the connected installation", async () => {
  const caller = owner("single-use");
  const state = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(state);
  assert.equal(
    (
      await caller.github.verifyGithubInstall({
        installationId: "456",
        state,
        code: "valid-code",
      })
    ).app,
    "Fixture App",
  );
  await assert.rejects(
    caller.github.verifyGithubInstall({
      installationId: "789",
      state,
      code: "reused-code",
    }),
    { code: "BAD_REQUEST" },
  );
  assert.deepEqual(await caller.github.getGithubConnected(), {
    connected: true,
  });
});

test("a callback cannot connect an installation the returning GitHub user cannot access", async () => {
  const caller = owner("installation-access");
  const state = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(state);
  await assert.rejects(
    caller.github.verifyGithubInstall({
      installationId: "789",
      state,
      code: "valid-code",
    }),
    { code: "FORBIDDEN" },
  );
  assert.deepEqual(await caller.github.getGithubConnected(), {
    connected: false,
  });
});

test("starting another GitHub connection invalidates the previous callback state", async () => {
  const caller = owner("rotate-state");
  const first = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  const second = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first, second);
  await assert.rejects(
    caller.github.verifyGithubInstall({
      installationId: "456",
      state: first,
      code: "stale-code",
    }),
    { code: "BAD_REQUEST" },
  );
});

test("a new connection remains usable when legacy duplicate installation rows exist", async () => {
  await fixtures.query(
    `INSERT INTO "GithubAppInstallations" ("userId", "createdBy") VALUES ('legacy-duplicate', 'legacy-duplicate'), ('legacy-duplicate', 'legacy-duplicate')`,
  );
  const caller = owner("legacy-duplicate");
  const state = new URL(
    (await caller.github.connectGithub()).url,
  ).searchParams.get("state");
  assert.ok(state);
  await caller.github.verifyGithubInstall({
    installationId: "456",
    state,
    code: "valid-code",
  });
  assert.deepEqual(await caller.github.getGithubConnected(), {
    connected: true,
  });
});
