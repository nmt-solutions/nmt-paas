import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { after, before, mock, test } from "node:test";
import pg from "pg";
import process from "node:process";
import { JSDOM } from "jsdom";
import { setTimeout as delay } from "node:timers/promises";

assert.ok(
  process.env.DATABASE_TEST_URL,
  "Use a disposable loopback PostgreSQL server",
);
let admin, fixture, database, caller, appRouter;
const ownerId = "history-owner";

before(async () => {
  const url = new URL(process.env.DATABASE_TEST_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(url.search, "");
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  const name = `deployment_history_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  fixture = new pg.Client({ connectionString: url.href });
  await fixture.connect();
  const migrations = new URL(
    "../../../packages/database/database/development/",
    import.meta.url,
  );
  for (const directory of (await readdir(migrations)).sort()) {
    await fixture.query(
      await readFile(new URL(`${directory}/migration.sql`, migrations), "utf8"),
    );
  }
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: "__history_fixture_no_env__",
    DEV_DATABASE_URL: url.href,
    PROD_DATABASE_URL: url.href,
    DB_ENV: "development",
    APP_ENV: "development",
    BASE_DOMAIN: "fixture.invalid",
    API_KEY: "history-fixture-server-key",
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
  mock.module("server-only", { namedExports: {} });
  ({ database } = await import("@repo/database"));
  ({ appRouter } = await import("../src/trpc/routers/app.trpc.ts"));
  caller = appRouter.createCaller({ userInfo: { user: { id: ownerId } } });
  await fixture.query(
    `INSERT INTO "Projects" (id, name, "userId", "createdBy") VALUES (1, 'History project', $1, $1)`,
    [ownerId],
  );
  await fixture.query(
    `INSERT INTO "Apps" (id, "appName", "projectId", "gitProvider", "repoId", "createdBy") VALUES (1, 'history-app', 1, 'github', 1, $1), (2, 'other-app', 1, 'github', 2, $1)`,
    [ownerId],
  );
  await fixture.query(
    `INSERT INTO "Deployments" (id, "appId", "repoId", branch, commit, status, env, "userId", "createdBy") VALUES (10, 1, 1, 'main', 'old-release', 'success', 'production', $1, $1), (11, 1, 1, 'main', 'new-release', 'success', 'production', $1, $1), (20, 2, 2, 'main', 'other-release', 'success', 'production', $1, $1)`,
    [ownerId],
  );
  await fixture.query(
    `INSERT INTO "DeploymentLogs" ("deploymentId", message, "createdBy") SELECT 10, 'old line ' || n, $1 FROM generate_series(1, 350) n`,
    [ownerId],
  );
  await fixture.query(
    `INSERT INTO "DeploymentLogs" ("deploymentId", message, "createdBy") SELECT 11, 'new line ' || n, $1 FROM generate_series(1, 350) n`,
    [ownerId],
  );
});

after(async () => {
  await database?.$client.end();
  if (fixture) {
    const name = fixture.database;
    await fixture.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  }
  await admin?.end();
  mock.restoreAll();
});

test("owner reads only a bounded cursor page of the selected deployment while app polling carries no log history", async () => {
  const app = await caller.get({ appId: 1 });
  assert.equal(
    JSON.stringify(app).includes("old line"),
    false,
    "routine polling must not download history",
  );
  assert.equal("deploymentLogs" in app.deployments[0], false);
  const newest = await caller.deploymentLogs({
    appId: 1,
    deploymentId: 10,
    limit: 25,
  });
  assert.equal(newest.logs.length, 25);
  assert.equal(newest.logs[0].message, "old line 326");
  assert.equal(newest.logs.at(-1).message, "old line 350");
  assert.equal(newest.hasMore, true);
  const older = await caller.deploymentLogs({
    appId: 1,
    deploymentId: 10,
    limit: 25,
    before: newest.oldestCursor,
  });
  assert.equal(older.logs.length, 25);
  assert.equal(older.logs[0].message, "old line 301");
  assert.equal(older.logs.at(-1).message, "old line 325");
  assert.ok(older.newestCursor < newest.oldestCursor);
  await fixture.query(
    `INSERT INTO "DeploymentLogs" ("deploymentId", message, "createdBy") VALUES (10, 'late persisted output', $1)`,
    [ownerId],
  );
  const appended = await caller.deploymentLogs({
    appId: 1,
    deploymentId: 10,
    limit: 25,
    after: newest.newestCursor,
  });
  assert.deepEqual(
    appended.logs.map((log) => log.message),
    ["late persisted output"],
  );
  assert.equal(appended.hasMore, false);
  assert.equal(
    JSON.stringify(await caller.get({ appId: 1 })).includes(
      "late persisted output",
    ),
    false,
  );
});

test("oversized history messages are explicitly clipped and unbounded or ambiguous reads are rejected", async () => {
  await fixture.query(
    `INSERT INTO "DeploymentLogs" ("deploymentId", message, "createdBy") VALUES (10, $1, $2)`,
    ["x".repeat(20_000), ownerId],
  );
  const page = await caller.deploymentLogs({
    appId: 1,
    deploymentId: 10,
    limit: 1,
  });
  assert.equal(page.logs[0].message.length, 4096);
  assert.equal(page.logs[0].truncated, true);
  for (const input of [
    { limit: 201 },
    { limit: 0 },
    { before: 10, after: 0 },
  ]) {
    await assert.rejects(
      caller.deploymentLogs({ appId: 1, deploymentId: 10, ...input }),
      { code: "BAD_REQUEST" },
    );
  }
});

test("history access applies owner and active app/project/deployment eligibility on every cursor request", async () => {
  const input = { appId: 1, deploymentId: 10, before: 350, limit: 10 };
  const foreign = appRouter.createCaller({
    userInfo: { user: { id: "foreign-owner" } },
  });
  const anonymous = appRouter.createCaller({ userInfo: { user: null } });
  await assert.rejects(foreign.deploymentLogs(input), { code: "NOT_FOUND" });
  await assert.rejects(anonymous.deploymentLogs(input), {
    code: "UNAUTHORIZED",
  });
  await assert.rejects(caller.deploymentLogs({ ...input, deploymentId: 20 }), {
    code: "NOT_FOUND",
  });
  for (const [table, id] of [
    ["Projects", 1],
    ["Apps", 1],
    ["Deployments", 10],
  ]) {
    await fixture.query(
      `UPDATE "${table}" SET "resourceStatus" = 'inactive' WHERE id = $1`,
      [id],
    );
    try {
      await assert.rejects(caller.deploymentLogs(input), { code: "NOT_FOUND" });
    } finally {
      await fixture.query(
        `UPDATE "${table}" SET "resourceStatus" = 'active' WHERE id = $1`,
        [id],
      );
    }
  }
  await fixture.query(
    `UPDATE "Projects" SET "userId" = 'foreign-owner' WHERE id = 1`,
  );
  try {
    await assert.rejects(caller.deploymentLogs(input), { code: "NOT_FOUND" });
  } finally {
    await fixture.query(`UPDATE "Projects" SET "userId" = $1 WHERE id = 1`, [
      ownerId,
    ]);
  }
});

test("the eligible deployment owner can read command diagnostics recorded by a builder", async () => {
  const previous = await caller.deploymentLogs({
    appId: 1,
    deploymentId: 10,
    limit: 1,
  });
  await fixture.query(
    `INSERT INTO "DeploymentLogs" ("deploymentId", message, "createdBy") VALUES (10, 'builder command diagnostic', '/builder-10')`,
  );
  const page = await caller.deploymentLogs({
    appId: 1,
    deploymentId: 10,
    limit: 1,
    after: previous.newestCursor,
  });
  assert.deepEqual(
    page.logs.map((log) => log.message),
    ["builder command diagnostic"],
  );
});

async function browser(t, search = "deployment=10") {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "http://web.test", pretendToBeVisual: true },
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
  const { fetchRequestHandler } = await import("@trpc/server/adapters/fetch");
  const { createTRPCOptionsProxy } = await import("@trpc/tanstack-react-query");
  const { createTRPCRouter } = await import("../src/trpc/init.ts");
  const { default: superjson } = await import("superjson");
  const { TRPCProvider } = await import("../src/trpc/client.tsx");
  const { AppRouterContext } =
    await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
  const { SearchParamsContext } =
    await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
  const { default: AppDetails } =
    await import("../src/components/apps/app-details.tsx");
  const router = createTRPCRouter({ app: appRouter });
  const requests = [];
  const streams = [];
  const runtime = mock.method(globalThis, "fetch", async (input, init) => {
    assert.match(String(input), /\/api\/apps\/1\/runtime-logs$/);
    let controller;
    const stream = {
      closed: false,
      send: (event) => controller.enqueue(new TextEncoder().encode(event)),
    };
    const body = new ReadableStream({
      start(value) {
        controller = value;
      },
      cancel() {
        stream.closed = true;
      },
    });
    init.signal.addEventListener(
      "abort",
      () => {
        if (!stream.closed) {
          stream.closed = true;
          controller.close();
        }
      },
      { once: true },
    );
    streams.push(stream);
    stream.send(
      `event: runtime\ndata: {"deploymentId":${streams.length === 1 ? 11 : 12}}\n\n`,
    );
    stream.send('data: "runtime start"\n\n');
    return new Response(body);
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const client = createTRPCClient({
    links: [
      httpLink({
        url: "http://web.test/api/trpc",
        transformer: superjson,
        fetch: async (input, init) => {
          const req = new Request(input, init);
          const response = await fetchRequestHandler({
            endpoint: "/api/trpc",
            req,
            router,
            createContext: async () => ({
              userInfo: { user: { id: ownerId } },
            }),
          });
          const text = await response.clone().text();
          requests.push({
            path: new URL(req.url).pathname.split("/").at(-1),
            input: superjson.parse(new URL(req.url).searchParams.get("input")),
            text,
          });
          return response;
        },
      }),
    ],
  });
  const trpc = createTRPCOptionsProxy({ client, queryClient });
  const root = createRoot(dom.window.document.getElementById("root"));
  let params = new URLSearchParams(search);
  async function render() {
    await act(() =>
      root.render(
        h(
          QueryClientProvider,
          { client: queryClient },
          h(
            TRPCProvider,
            { trpcClient: client, queryClient },
            h(
              AppRouterContext.Provider,
              {
                value: {
                  replace(value) {
                    params = new URLSearchParams(value.slice(1));
                    void render();
                  },
                },
              },
              h(
                SearchParamsContext.Provider,
                { value: params },
                h(AppDetails, { appId: 1 }),
              ),
            ),
          ),
        ),
      ),
    );
  }
  t.after(async () => {
    await act(() => root.unmount());
    queryClient.clear();
    runtime.mock.restore();
    dom.window.close();
  });
  async function until(predicate, message) {
    for (let i = 0; i < 250; i++) {
      if (predicate()) return;
      await act(() => delay(20));
    }
    assert.fail(message);
  }
  async function click(text) {
    const button = [...dom.window.document.querySelectorAll("button")].find(
      (item) => item.textContent.trim() === text,
    );
    assert.ok(button, `Missing button ${text}`);
    await act(() => button.click());
  }
  await render();
  await until(
    () => dom.window.document.body.textContent.includes("history-app"),
    "App should load",
  );
  async function tab(label) {
    const target = [...dom.window.document.querySelectorAll("[role=tab]")].find(
      (node) => node.textContent.startsWith(label),
    );
    assert.ok(target);
    await act(() =>
      target.dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
      ),
    );
  }
  return {
    dom,
    act,
    streams,
    requests,
    until,
    click,
    tab,
    queryClient,
    trpc,
    render,
  };
}

test("browser pages only selected history and keeps its release and scroll position through polling and new releases", async (t) => {
  const ui = await browser(t);
  const body = () => ui.dom.window.document.body.textContent;
  await ui.until(
    () => body().includes("old line 350"),
    "Selected history should load independently of app polling",
  );
  const historyRequests = () =>
    ui.requests.filter((req) => req.path === "app.deploymentLogs");
  assert.equal(historyRequests()[0].input.deploymentId, 10);
  assert.equal(historyRequests()[0].input.limit, 100);
  assert.equal(superjsonData(historyRequests()[0]).logs.length, 100);
  await ui.click("Older logs");
  await ui.until(
    () => body().includes("old line 200"),
    "Older page should be visible",
  );
  const pre = [...ui.dom.window.document.querySelectorAll("pre")].find((node) =>
    node.textContent.includes("old line"),
  );
  pre.scrollTop = 71;
  const before = pre.textContent;
  const requested = historyRequests().length;
  await fixture.query(
    `INSERT INTO "Deployments" (id, "appId", "repoId", branch, commit, status, env, "userId", "createdBy") VALUES (12, 1, 1, 'main', 'newest-release', 'success', 'production', $1, $1)`,
    [ownerId],
  );
  await ui.act(() =>
    ui.queryClient.refetchQueries({
      queryKey: ui.trpc.app.get.queryKey({ appId: 1 }),
    }),
  );
  await ui.until(
    () => ui.requests.filter((req) => req.path === "app.get").length >= 3,
    "Routine app polling should continue",
  );
  assert.match(body(), /deployment #10/i);
  assert.equal(pre.textContent, before);
  assert.equal(pre.scrollTop, 71);
  assert.equal(
    historyRequests().length,
    requested,
    "Browsing an older page must not redownload it during polling",
  );
  assert.equal(
    ui.streams.length,
    1,
    "App polling must not reconnect the identified runtime",
  );
  assert.ok(
    ui.requests
      .filter((req) => req.path === "app.get")
      .every(
        (req) =>
          !req.text.includes("old line") && !req.text.includes("new line"),
      ),
  );
  await ui.click("Latest logs");
  await ui.until(
    () => body().includes("old line 350"),
    "Return to selected release's newest page",
  );
  await fixture.query(
    `INSERT INTO "DeploymentLogs" ("deploymentId", message, "createdBy") SELECT 10, 'growing history ' || n, $1 FROM generate_series(1, 250) n`,
    [ownerId],
  );
  await ui.until(
    () => body().includes("growing history 250"),
    "Incremental selected history should catch up",
  );
  assert.ok(historyRequests().some((req) => req.input.after > 0));
  assert.ok(
    historyRequests().every((req) => superjsonData(req).logs.length <= 100),
  );
  assert.match(body(), /earlier records omitted/i);
  assert.ok(!body().includes("growing history 1\n"));
  const beforeLatest = historyRequests().length;
  await ui.click("Latest logs");
  await ui.until(
    () => historyRequests().length > beforeLatest,
    "Latest page should finish before more logs arrive",
  );
  await fixture.query(
    `INSERT INTO "DeploymentLogs" ("deploymentId", message, "createdBy") VALUES (10, 'latest stays following', $1)`,
    [ownerId],
  );
  await ui.until(
    () => body().includes("latest stays following"),
    "Latest logs should keep following even when already on the newest page",
  );
});

function superjsonData(request) {
  const response = JSON.parse(request.text);
  return response.result.data.json;
}

test("live output keeps bounded recent lines and characters with visible truncation, typed outcomes and explicit runtime reconnect", async (t) => {
  const ui = await browser(t);
  const body = () => ui.dom.window.document.body.textContent;
  await ui.until(
    () => body().includes("runtime start"),
    "Runtime should identify itself before output",
  );
  const runtimePanel = [
    ...ui.dom.window.document.querySelectorAll("section"),
  ].find(
    (node) => node.querySelector("h2")?.textContent === "Application logs",
  );
  const output = () => runtimePanel.querySelector("pre").textContent;
  const historyPre = [...ui.dom.window.document.querySelectorAll("pre")].find(
    (node) => !runtimePanel.contains(node),
  );
  historyPre.scrollTop = 32;
  await ui.act(async () => {
    ui.streams[0].send(
      Array.from(
        { length: 1005 },
        (_, i) => `data: ${JSON.stringify(`entry ${i}`)}\n\n`,
      ).join(""),
    );
  });
  await ui.until(
    () => output().includes("entry 1004"),
    "Growing runtime output should render",
  );
  assert.equal(output().split("\n").length, 1000);
  assert.equal(output().split("\n")[0], "entry 5");
  assert.match(runtimePanel.textContent, /earlier output truncated/i);
  assert.match(runtimePanel.textContent, /deployment #11/);
  const giant = "x".repeat(200_000) + " retained end";
  await ui.act(async () =>
    ui.streams[0].send(`data: ${JSON.stringify(giant)}\n\n`),
  );
  await ui.until(
    () => output().endsWith(" retained end"),
    "Latest part of oversized output should remain visible",
  );
  assert.equal(output().length, 131072);
  assert.equal(historyPre.scrollTop, 32);
  assert.match(body(), /deployment #10/i);
  await ui.act(async () =>
    ui.streams[0].send(
      'event: error\ndata: {"message":"fixture runtime failed"}\n\nevent: end\ndata: {"reason":"error"}\n\n',
    ),
  );
  await ui.until(
    () => runtimePanel.textContent.includes("Stream failed"),
    "Typed stream failure should remain distinct from text",
  );
  assert.match(
    runtimePanel.querySelector("[role=alert]").textContent,
    /fixture runtime failed/,
  );
  assert.ok(!output().includes("fixture runtime failed"));
  await ui.click("Reconnect");
  await ui.until(
    () => runtimePanel.textContent.includes("deployment #12"),
    "Explicit reconnect should identify the new runtime",
  );
  assert.equal(ui.streams.length, 2);
  assert.equal(ui.streams[0].closed, true);
  assert.equal(output(), "runtime start");
  assert.ok(!runtimePanel.textContent.includes("Earlier output truncated"));
  assert.equal(runtimePanel.querySelector("[role=alert]"), null);
  assert.match(body(), /deployment #10/i);
  await ui.act(async () =>
    ui.streams[1].send('event: end\ndata: {"reason":"eof"}\n\n'),
  );
  await ui.until(
    () => runtimePanel.textContent.includes("Stream ended"),
    "Clean EOF should preserve its separate outcome",
  );
  assert.equal(output(), "runtime start");
});

test("browsing release history and selecting another persisted deployment keeps the identified runtime subscription", async (t) => {
  const ui = await browser(t);
  const body = () => ui.dom.window.document.body.textContent;
  await ui.until(() => body().includes("runtime start"), "Runtime should load");
  const historyPre = ui.dom.window.document.querySelector("pre");
  historyPre.scrollTop = 57;
  await ui.tab("Deployments");
  assert.equal(
    ui.streams[0].closed,
    false,
    "History navigation must not cancel a runtime subscription",
  );
  await ui.tab("Overview");
  assert.equal(ui.dom.window.document.querySelector("pre"), historyPre);
  assert.equal(historyPre.scrollTop, 57);
  await ui.tab("Deployments");
  const release = [...ui.dom.window.document.querySelectorAll("button")].find(
    (node) => node.textContent.includes("Deployment #11"),
  );
  assert.ok(release);
  await ui.act(() => release.click());
  await ui.until(
    () => body().includes("new line 350"),
    "Selecting release 11 should read only its persisted output",
  );
  assert.equal(ui.streams.length, 1);
  assert.equal(ui.streams[0].closed, false);
  await ui.act(async () =>
    ui.streams[0].send('data: "same runtime after history selection"\n\n'),
  );
  await ui.until(
    () => body().includes("same runtime after history selection"),
    "Existing runtime should continue delivering",
  );
  assert.match(body(), /Following · deployment #11/);
  assert.match(body(), /Live.*deployment #11/);
});

test("an initially selected latest deployment becomes historical without losing selection when a release arrives", async (t) => {
  const latestId = Math.max(
    ...(await caller.get({ appId: 1 })).deployments.map((item) => item.id),
  );
  await fixture.query(
    `INSERT INTO "DeploymentLogs" ("deploymentId", message, "createdBy") VALUES ($1, 'initial selected output', $2)`,
    [latestId, ownerId],
  );
  const ui = await browser(t, "");
  const body = () => ui.dom.window.document.body.textContent;
  await ui.until(
    () => body().includes("initial selected output"),
    "Default selection should load",
  );
  const historyPre = ui.dom.window.document.querySelector("pre");
  historyPre.scrollTop = 44;
  await fixture.query(
    `INSERT INTO "Deployments" (id, "appId", "repoId", branch, commit, status, env, "userId", "createdBy") VALUES (13, 1, 1, 'main', 'next-release', 'success', 'production', $1, $1)`,
    [ownerId],
  );
  await ui.act(() =>
    ui.queryClient.refetchQueries({
      queryKey: ui.trpc.app.get.queryKey({ appId: 1 }),
    }),
  );
  await ui.until(
    () => body().includes("Commit next-rel"),
    "New release metadata should become visible",
  );
  assert.ok(body().includes(`Following · deployment #${latestId}`));
  assert.equal(ui.dom.window.document.querySelector("pre"), historyPre);
  assert.equal(historyPre.scrollTop, 44);
  assert.match(historyPre.textContent, /initial selected output/);
  assert.equal(ui.streams.length, 1);
});
