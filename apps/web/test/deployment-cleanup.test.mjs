import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import pg from "pg";

test(
  "incomplete cleanup survives PostgreSQL reload, recovery restart, and owner page refresh",
  { skip: !process.env.DATABASE_TEST_URL, timeout: 60_000 },
  async (t) => {
    const url = new URL(process.env.DATABASE_TEST_URL);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    assert.equal(url.search, "", "Use a disposable loopback PostgreSQL server");
    const admin = new pg.Client({ connectionString: url.href });
    await admin.connect();
    const name = `deployment_result_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    const connection = new pg.Client({ connectionString: url.href });
    await connection.connect();
    let database;
    t.after(async () => {
      await database?.$client.end();
      await connection.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    });
    const migrations = new URL(
      "../../../packages/database/database/development/",
      import.meta.url,
    );
    for (const directory of (await readdir(migrations)).sort()) {
      await connection.query(
        await readFile(
          new URL(`${directory}/migration.sql`, migrations),
          "utf8",
        ),
      );
    }
    Object.assign(process.env, {
      DOTENV_CONFIG_PATH: new URL("absent.env", import.meta.url).pathname,
      DEV_DATABASE_URL: url.href,
      PROD_DATABASE_URL: url.href,
      DB_ENV: "development",
      APP_ENV: "development",
      BASE_DOMAIN: "fixture.invalid",
      API_KEY: "fixture-api-key",
      API_BASE_URL: "http://127.0.0.1:1",
      WORKOS_CLIENT_ID: "fixture",
      WORKOS_API_KEY: "cleanup-workos-api-key",
      WORKOS_COOKIE_PASSWORD: "fixture".repeat(8),
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: "http://localhost/callback",
      GITHUB_APP_ID: "1",
      GITHUB_APP_SLUG: "fixture",
      GITHUB_APP_PRIVATE_KEY: "fixture-private-key",
      ENV_ENCRYPTION_KEY: "11".repeat(32),
    });
    // Next's build-only import guard is unnecessary in this combined Node workflow.
    // Database, routers, query hooks, UI and executor all remain real.
    mock.module("server-only", { namedExports: {} });
    ({ database } = await import("@repo/database"));
    const schema = await import("@repo/database/schema");
    const { deploymentFixture, deploymentId, userId } =
      await import("../../worker/test/fixtures/deployment.ts");
    const failRemove = {
      previous: "removal denied fixture-pat",
      "builder-42": "builder busy",
    };
    const dockerFixture = await deploymentFixture({ failRemove });
    t.after(dockerFixture.close);
    const snapshot = await dockerFixture.dependencies.getDeployment(
      deploymentId,
      userId,
    );
    await database
      .insert(schema.Projects)
      .values({ id: 3, name: "Fixture project", userId, createdBy: userId });
    await database.insert(schema.Apps).values({
      id: 7,
      projectId: 3,
      appName: "fixture-app",
      repoId: 123,
      gitProvider: "github",
      createdBy: userId,
    });
    await database.insert(schema.AppDomains).values({
      appId: 7,
      domain: "fixture.invalid",
      env: "production",
      userId,
      createdBy: userId,
    });
    await database.insert(schema.FrameworkConfig).values({
      appId: 7,
      ...snapshot.app.frameworkConfig,
      framework: "fixture",
      outputDirectory: "dist",
      createdBy: userId,
    });
    await database.insert(schema.Deployments).values({
      id: deploymentId,
      appId: 7,
      repoId: 123,
      branch: "release",
      commit: snapshot.commit,
      env: "production",
      userId,
      createdBy: userId,
    });
    const { getDeployment, updateDeployment, saveDeploymentCleanup } =
      await import("@repo/database/access-layer/deployment.dal");
    const publicationPersistence =
      await import("@repo/database/access-layer/deployment-publication.dal");
    const { createDeploymentLogs } =
      await import("@repo/database/access-layer/deployment-logs.dal");
    const { createDeploymentExecutor } =
      await import("../../worker/src/deployment/execute-deployment.ts");
    const { createDockerCommandAdapter } =
      await import("../../worker/src/deployment/docker-command-adapter.ts");
    const persistence = {
      ...publicationPersistence,
      getDeployment,
      updateDeployment,
      saveDeploymentCleanup,
      createDeploymentLogs,
    };
    const execute = createDeploymentExecutor({
      ...dockerFixture.dependencies,
      ...persistence,
      ...createDockerCommandAdapter({
        ...persistence,
        getDocker: dockerFixture.dependencies.getDocker,
      }),
    });
    await assert.rejects(
      execute({ deploymentId, userId }),
      /cleanup incomplete/,
    );

    const { appRouter } = await import("../src/trpc/routers/app.trpc.ts");
    const caller = appRouter.createCaller({
      userInfo: { user: { id: userId } },
    });
    const { deploymentRouter } =
      await import("../src/trpc/routers/deployment.trpcs.ts");
    const publicationCaller = deploymentRouter.createCaller({
      userInfo: { user: { id: userId } },
    });
    const publicationBefore = await publicationCaller.publication({
      deploymentId,
    });
    assert.equal(publicationBefore.publication.status, "pending");
    const app = await caller.get({ appId: 7 });
    assert.equal(app.deployments[0].id, deploymentId);
    assert.equal(app.deployments[0].status, "success");
    assert.equal(app.deployments[0].cleanup.status, "pending");
    assert.doesNotMatch(JSON.stringify(app), /fixture-pat/);
    await assert.rejects(
      appRouter.createCaller({ userInfo: null }).get({ appId: 7 }),
      { code: "UNAUTHORIZED" },
    );
    await assert.rejects(
      appRouter
        .createCaller({ userInfo: { user: { id: "foreign" } } })
        .get({ appId: 7 }),
      { code: "NOT_FOUND" },
    );
    assert.equal(
      (await caller.getLatestSuccessDeployment({ appId: 7 })).id,
      deploymentId,
    );
    assert.ok(
      app.deployments[0].deploymentLogs.some(
        (log) =>
          log.message ===
          "Container started for fixture-app at fixture.invalid. Application readiness has not been checked.",
      ),
    );

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
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const { createElement: h, act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } =
      await import("@tanstack/react-query");
    const { createTRPCClient, httpLink } = await import("@trpc/client");
    const { createTRPCOptionsProxy } =
      await import("@trpc/tanstack-react-query");
    const { default: superjson } = await import("superjson");
    const { TRPCProvider } = await import("../src/trpc/client.tsx");
    const { AppRouterContext } =
      await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
    const { SearchParamsContext } =
      await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
    const { default: AppDetails } =
      await import("../src/components/apps/app-details.tsx");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    const client = createTRPCClient({
      links: [
        httpLink({
          url: "http://127.0.0.1:1/api/trpc",
          transformer: superjson,
        }),
      ],
    });
    const trpc = createTRPCOptionsProxy({ client, queryClient });
    queryClient.setQueryData(
      trpc.deployment.publication.queryKey({ deploymentId }),
      publicationBefore,
    );
    queryClient.setQueryData(trpc.app.get.queryKey({ appId: 7 }), app);
    queryClient.setQueryData(
      trpc.app.getLatestSuccessDeployment.queryKey({ appId: 7 }),
      null,
    );
    const root = createRoot(dom.window.document.getElementById("root"));
    t.after(async () => {
      await act(() => root.unmount());
      queryClient.clear();
      dom.window.close();
    });
    const renderPage = (page) =>
      act(() =>
        root.render(
          h(
            QueryClientProvider,
            { client: queryClient },
            h(
              TRPCProvider,
              { trpcClient: client, queryClient },
              h(
                AppRouterContext.Provider,
                { value: { replace() {} } },
                h(
                  SearchParamsContext.Provider,
                  { value: new URLSearchParams() },
                  page,
                ),
              ),
            ),
          ),
        ),
      );
    await renderPage(h(AppDetails, { appId: 7 }));
    const overview = dom.window.document.body.textContent;
    assert.match(overview, /Cleanup incomplete/);
    assert.match(overview, /Image publication/);
    assert.match(
      overview,
      /Latest deployment statusContainer startedDocker accepted the container start\. Application readiness has not been checked\./,
    );
    assert.doesNotMatch(
      overview,
      /Healthy|serving traffic|Availability|Uptime/,
    );
    const historyTab = [
      ...dom.window.document.querySelectorAll("[role=tab]"),
    ].find((tab) => tab.textContent.startsWith("Deployments"));
    await act(() =>
      historyTab.dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
      ),
    );
    const history = dom.window.document.querySelector(
      "[role=tabpanel][data-state=active]",
    ).textContent;
    assert.match(history, /Deployment #42Container started/);
    assert.match(history, /Application readiness has not been checked/);
    assert.doesNotMatch(history, /Healthy|serving traffic|Availability|Uptime/);
    const dependencies = {
      ...dockerFixture.dependencies,
      ...persistence,
      getCloneUrl: async () => {
        throw new Error("Cleanup must not clone");
      },
      fetchEnvVars: async () => {
        throw new Error("Cleanup must not load build configuration");
      },
    };
    // Real PostgreSQL rejects the outcome after Docker actually removes the
    // builder. The durable failed/pending item must survive that lost write.
    await connection.query(`
      CREATE FUNCTION reject_cleanup_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.cleanup @> '{"artifacts":[{"kind":"builder","status":"complete"}]}'::jsonb THEN
          RAISE EXCEPTION 'fixture cleanup acknowledgement unavailable fixture-pat';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER cleanup_acknowledgement BEFORE UPDATE OF cleanup ON "Deployments"
        FOR EACH ROW EXECUTE FUNCTION reject_cleanup_completion();
    `);
    Reflect.deleteProperty(failRemove, "builder-42");
    const partial = await createDeploymentExecutor(dependencies)({
      userId,
      deploymentId,
      action: "cleanup",
    });
    assert.equal(partial.status, "pending");
    await assert.rejects(
      dockerFixture.docker.getContainer("builder-42").inspect(),
      { statusCode: 404 },
    );
    const reloaded = await caller.get({ appId: 7 });
    assert.equal(reloaded.deployments[0].status, "success");
    assert.equal(reloaded.deployments[0].cleanup.status, "pending");
    assert.match(
      reloaded.deployments[0].cleanup.artifacts.find(
        (a) => a.kind === "builder",
      ).error,
      /Cleanup outcome could not be saved/,
    );
    assert.doesNotMatch(JSON.stringify(reloaded), /Failed query:|params:/);
    assert.doesNotMatch(JSON.stringify(reloaded), /fixture-pat/);
    await connection.query(
      'DROP TRIGGER cleanup_acknowledgement ON "Deployments"; DROP FUNCTION reject_cleanup_completion()',
    );
    // A fresh executor reads the persisted ledger. The already-absent builder
    // becomes complete, while the independently failed old runtime stays visible.
    const restarted = createDeploymentExecutor(dependencies);
    const stillPending = await restarted({
      userId,
      deploymentId,
      action: "cleanup",
    });
    assert.equal(stillPending.status, "pending");
    assert.equal(
      stillPending.artifacts.find((a) => a.kind === "builder").status,
      "complete",
    );
    Reflect.deleteProperty(failRemove, "previous");
    const child = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--experimental-test-module-mocks",
        "test/fixtures/cleanup-process.mjs",
        String(deploymentId),
        userId,
      ],
      {
        cwd: new URL("../../worker/", import.meta.url),
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: fileURLToPath(
            new URL("../../worker/tsconfig.json", import.meta.url),
          ),
          CLEANUP_TEST_DOCKER_PORT: String(dockerFixture.docker.modem.port),
        },
        timeout: 15_000,
        windowsHide: true,
      },
    );
    assert.match(child.stdout, /cleanup complete/);
    assert.doesNotMatch(child.stdout + child.stderr, /fixture-pat/);
    assert.deepEqual(
      await publicationCaller.publication({ deploymentId }),
      publicationBefore,
      "The separate-process cleanup operator must leave publication untouched",
    );
    const complete = (await caller.get({ appId: 7 })).deployments[0].cleanup;
    assert.equal(complete.status, "complete");
    assert.deepEqual(
      await restarted({ userId, deploymentId, action: "cleanup" }),
      complete,
    );
    assert.deepEqual(
      (await dockerFixture.docker.listContainers({ all: true }))
        .map((c) => c.Id)
        .sort(),
      ["deployment-42", "unrelated"],
    );
    assert.equal(
      (await dockerFixture.docker.getContainer("deployment-42").inspect()).State
        .Running,
      true,
    );
    assert.equal(
      (await dockerFixture.docker.getImage("ghcr.io/fixture/42:42").inspect())
        .Id,
      "fixture-image",
    );
    const refreshed = await caller.get({ appId: 7 });
    assert.equal(refreshed.deployments[0].status, "success");
    assert.equal(refreshed.deployments[0].cleanup.status, "complete");
    await act(() =>
      queryClient.setQueryData(trpc.app.get.queryKey({ appId: 7 }), refreshed),
    );
    await renderPage(h(AppDetails, { appId: 7, key: "page-refresh" }));
    const cleanupDisplay = dom.window.document.querySelector(
      '[aria-label="Deployment cleanup"]',
    ).textContent;
    assert.match(cleanupDisplay, /Cleanup complete/);
    assert.doesNotMatch(
      cleanupDisplay,
      /Cleanup incomplete|acknowledgement unavailable|removal denied/,
    );
  },
);
