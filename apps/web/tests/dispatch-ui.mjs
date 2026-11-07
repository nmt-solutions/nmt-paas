import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { mock } from "node:test";

export async function exerciseDispatchUI({
  appRouter,
  userInfo,
  caller,
  appId,
  importInput,
  setHostMode,
}) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "http://localhost", pretendToBeVisual: true },
  );
  const globals = new Map();
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
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createElement: h, act, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } =
    await import("@tanstack/react-query");
  const { createTRPCClient, httpLink } = await import("@trpc/client");
  const { createTRPCOptionsProxy } = await import("@trpc/tanstack-react-query");
  const { default: superjson } = await import("superjson");
  const { TRPCProvider } = await import("../src/trpc/client.tsx");
  const { AppRouterContext } =
    await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
  const { SearchParamsContext } =
    await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
  const { default: AppDetails } =
    await import("../src/components/apps/app-details.tsx");
  // Next's bundler supplies image interop in production. JSDOM only needs the
  // external framework's image element; admission/query/mutation code stays real.
  const imageModule = mock.module("next/image", {
    defaultExport: (props) => h("img", props),
  });
  const { default: ImportRepository } =
    await import("../src/components/repositories/import-repository.tsx");
  const { Toaster } = await import("sonner");
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false },
      mutations: { retry: false },
    },
  });
  const submissions = [];
  const importSubmissions = [];
  let loseResponse = true;
  const client = createTRPCClient({
    links: [
      httpLink({
        url: "http://localhost/api/trpc",
        transformer: superjson,
        fetch: async (url, init) => {
          const redeploy = String(url).includes("app.redeploy");
          const importing = String(url).includes("deployment.deploy");
          if (redeploy) submissions.push(JSON.parse(init.body).json);
          if (importing) importSubmissions.push(JSON.parse(init.body).json);
          const response = await fetchRequestHandler({
            endpoint: "/api/trpc",
            req: new Request(url, init),
            router: appRouter,
            createContext: async () => ({ userInfo }),
          });
          if ((redeploy || importing) && loseResponse) {
            loseResponse = false;
            throw new Error("fixture response timeout");
          }
          return response;
        },
      }),
    ],
  });
  const trpc = createTRPCOptionsProxy({ client, queryClient });
  queryClient.setQueryData(
    trpc.app.get.queryKey({ appId }),
    await caller.app.get({ appId }),
  );
  queryClient.setQueryData(
    trpc.app.getLatestSuccessDeployment.queryKey({ appId }),
    null,
  );
  const navigation = [];
  let selectDeployment;
  let showImport = false;
  const importProps = {
    gitProvider: "github",
    repoId: String(importInput.repoId),
    repo: importInput.repo,
    branch: importInput.branch,
  };
  function NavigationFixture() {
    const [search, setSearch] = useState(new URLSearchParams());
    selectDeployment = (deploymentId) =>
      setSearch(new URLSearchParams(`deployment=${deploymentId}`));
    return h(
      AppRouterContext.Provider,
      {
        value: {
          replace: (url) => {
            navigation.push(url);
            setSearch(new URLSearchParams(url));
          },
          push: (url) => {
            navigation.push(url);
          },
        },
      },
      h(
        SearchParamsContext.Provider,
        { value: search },
        showImport
          ? h(ImportRepository, importProps)
          : h(AppDetails, { appId }),
        h(Toaster),
      ),
    );
  }
  let root = createRoot(dom.window.document.getElementById("root"));
  const mount = () =>
    act(() =>
      root.render(
        h(
          QueryClientProvider,
          { client: queryClient },
          h(
            TRPCProvider,
            { trpcClient: client, queryClient },
            h(NavigationFixture),
          ),
        ),
      ),
    );
  async function clickRedeploy() {
    const button = [...dom.window.document.querySelectorAll("button")].find(
      (element) => element.textContent === "Redeploy",
    );
    assert.ok(button && !button.disabled);
    await act(() => button.click());
  }
  async function until(check) {
    for (let count = 0; count < 150; count++) {
      if (check()) return;
      await act(() => delay(20));
    }
    assert.fail(`UI did not settle: ${dom.window.document.body.textContent}`);
  }
  try {
    await mount();
    await clickRedeploy();
    await until(
      () =>
        !loseResponse &&
        !dom.window.document.querySelector("button[disabled] svg.animate-spin"),
    );
    await act(() => root.unmount());
    root = createRoot(dom.window.document.getElementById("root"));
    await mount();
    await clickRedeploy();
    await until(() => navigation.length > 0);
    assert.match(submissions[0]?.submissionId ?? "", /^[0-9a-f-]{36}$/i);
    assert.ok(
      submissions.every(
        (submission) => submission.submissionId === submissions[0].submissionId,
      ),
    );
    const deployments = (await caller.app.get({ appId })).deployments;
    assert.equal(
      deployments.length,
      2,
      "One initial deployment and one retried redeployment",
    );
    assert.equal(
      navigation.at(-1),
      `?deployment=${Math.max(...deployments.map(({ id }) => id))}`,
    );
    for (const [mode, expected] of [
      ["unavailable", /Queue confirmation pending/],
      ["rejected", /Dispatch rejected by the host/],
    ]) {
      setHostMode(mode);
      await act(async () => {
        const result = await caller.app.redeploy({
          appId,
          submissionId: crypto.randomUUID(),
        });
        queryClient.setQueryData(
          trpc.app.get.queryKey({ appId }),
          await caller.app.get({ appId }),
        );
        queryClient.setQueryData(
          trpc.deployment.dispatches.queryKey({ appId }),
          await caller.deployment.dispatches({ appId }),
        );
        selectDeployment(result.deploymentId);
      });
      await until(() =>
        expected.test(
          dom.window.document.querySelector("[role=status]")?.textContent ?? "",
        ),
      );
      assert.match(
        dom.window.document.querySelector("[role=status]")?.textContent ?? "",
        expected,
      );
    }
    setHostMode("unavailable");
    queryClient.setQueryData(trpc.git.getRepository.queryKey(importProps), {
      repository: {
        id: importInput.repoId,
        name: importInput.repo,
        owner: { id: 99, name: importInput.owner },
        url: "https://github.com/fixture-owner/repo",
        slug: importInput.repo,
        private: true,
        defaultBranch: importInput.branch,
        updatedAt: 0,
      },
      frameworkPreset: importInput.frameworkConfig,
    });
    queryClient.setQueryData(
      trpc.framework.getFrameworks.queryKey(),
      await caller.framework.getFrameworks(),
    );
    const beforeImport = (await caller.app.get({ appId })).deployments.length;
    const beforeNavigation = navigation.length;
    showImport = true;
    loseResponse = true;
    await act(() => root.unmount());
    root = createRoot(dom.window.document.getElementById("root"));
    const clickDeploy = async () => {
      await until(() =>
        [...dom.window.document.querySelectorAll("button")].some(
          (button) => button.textContent === "Deploy" && !button.disabled,
        ),
      );
      await act(() =>
        [...dom.window.document.querySelectorAll("button")]
          .find((button) => button.textContent === "Deploy")
          .click(),
      );
    };
    await mount();
    await clickDeploy();
    await until(() => !loseResponse);
    const retained = dom.window.sessionStorage.getItem(
      `deployment-submission:import:${importProps.repoId}:${importProps.branch}`,
    );
    assert.match(retained, /^[0-9a-f-]{36}$/i);
    assert.equal(retained, importSubmissions[0].submissionId);
    await act(() => root.unmount());
    root = createRoot(dom.window.document.getElementById("root"));
    await mount();
    await clickDeploy();
    await until(() => navigation.length > beforeNavigation);
    assert.equal(
      dom.window.sessionStorage.getItem(
        `deployment-submission:import:${importProps.repoId}:${importProps.branch}`,
      ),
      retained,
      "An explicitly uncertain outcome retains the same UUID after remount",
    );
    assert.equal(
      (await caller.deployment.submission({ submissionId: retained })).outcome,
      "uncertain",
    );
    setHostMode("available");
    await delay(5100);
    assert.equal(
      (await caller.deployment.deploy(importSubmissions[0])).outcome,
      "accepted",
    );
    const beforeConfirmation = navigation.length;
    await clickDeploy();
    await until(() => navigation.length > beforeConfirmation);
    assert.equal(
      importSubmissions.length,
      1,
      "Remounted import resolves its saved submission without repeating the mutation",
    );
    const imported = (await caller.app.get({ appId })).deployments;
    assert.equal(imported.length, beforeImport + 1);
    assert.match(
      navigation.at(-1),
      new RegExp(
        `/apps/${appId}\\?deployment=${Math.max(...imported.map((d) => d.id))}$`,
      ),
    );
    assert.equal(
      dom.window.sessionStorage.getItem(
        `deployment-submission:import:${importProps.repoId}:${importProps.branch}`,
      ),
      null,
    );
    for (let i = 0; i < dom.window.sessionStorage.length; i++) {
      const key = dom.window.sessionStorage.key(i);
      assert.match(
        dom.window.sessionStorage.getItem(key),
        /^[0-9a-f-]{36}$/i,
        "Browser retention contains UUIDs only",
      );
    }
  } finally {
    imageModule.restore();
    setHostMode("available");
    await act(() => root.unmount());
    queryClient.clear();
    dom.window.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
}
