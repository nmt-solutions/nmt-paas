import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import { mock, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { JSDOM } from "jsdom";
import pg from "pg";

test(
  "a completed execution is displayed as container start across the owner workspace",
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
      WORKOS_API_KEY: "fixture",
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
    const dockerFixture = await deploymentFixture();
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
    const { createDeploymentLogs } =
      await import("@repo/database/access-layer/deployment-logs.dal");
    const { createDeploymentExecutor } =
      await import("../../worker/src/deployment/execute-deployment.ts");
    const { createDockerCommandAdapter } =
      await import("../../worker/src/deployment/docker-command-adapter.ts");
    const persistence = {
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
    await execute({ deploymentId, userId });
    // Let the existing background work finish before closing its HTTP fixture.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (await dockerFixture.docker.listContainers({ all: true })).length === 2
      )
        break;
      await setTimeout(10);
    }

    const { appRouter } = await import("../src/trpc/routers/app.trpc.ts");
    const caller = appRouter.createCaller({
      userInfo: { user: { id: userId } },
    });
    const app = await caller.get({ appId: 7 });
    assert.equal(app.deployments[0].id, deploymentId);
    assert.equal(app.deployments[0].status, "success");
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

    await database.insert(schema.Deployments).values(
      ["failed", "success"].map((status, index) => ({
        id: 40 + index,
        appId: 7,
        repoId: 123,
        branch: "release",
        commit: snapshot.commit,
        status,
        env: "production",
        userId,
        createdBy: userId,
      })),
    );
    const { projectRouter } =
      await import("../src/trpc/routers/project.trpc.ts");
    const projects = await projectRouter
      .createCaller({ userInfo: { user: { id: userId } } })
      .list();
    queryClient.setQueryData(trpc.project.list.queryKey(), projects);
    const { default: Dashboard } =
      await import("../src/app/dashboard/page.tsx");
    await renderPage(h(Dashboard));
    const dashboard = dom.window.document.body.textContent;
    assert.match(
      dashboard,
      /Container starts2recorded across deployment history/,
    );
    assert.match(dashboard, /Container start rate67%of recorded deployments/);
    assert.match(dashboard, /Application readiness has not been checked/);
    assert.match(dashboard, /Container started/);
    assert.doesNotMatch(
      dashboard,
      /Healthy|Availability|Uptime|currently successful/,
    );
    const { default: ProjectsPage } =
      await import("../src/app/projects/page.tsx");
    await renderPage(h(ProjectsPage));
    assert.match(
      dom.window.document.body.textContent,
      /fixture-appContainer started/,
    );
  },
);
