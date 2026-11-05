import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

export async function exerciseDispatchUI({
  appRouter,
  userInfo,
  caller,
  appId,
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
  const { createElement: h, act } = await import("react");
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
  const { Toaster } = await import("sonner");
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false },
      mutations: { retry: false },
    },
  });
  const submissions = [];
  let loseResponse = true;
  const client = createTRPCClient({
    links: [
      httpLink({
        url: "http://localhost/api/trpc",
        transformer: superjson,
        fetch: async (url, init) => {
          const redeploy = String(url).includes("app.redeploy");
          if (redeploy) submissions.push(JSON.parse(init.body).json);
          const response = await fetchRequestHandler({
            endpoint: "/api/trpc",
            req: new Request(url, init),
            router: appRouter,
            createContext: async () => ({ userInfo }),
          });
          if (redeploy && loseResponse) {
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
            h(
              AppRouterContext.Provider,
              { value: { replace: (url) => navigation.push(url) } },
              h(
                SearchParamsContext.Provider,
                { value: new URLSearchParams() },
                h(AppDetails, { appId }),
                h(Toaster),
              ),
            ),
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
  } finally {
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
