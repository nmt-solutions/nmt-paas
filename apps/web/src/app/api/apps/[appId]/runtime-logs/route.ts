import "server-only";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { getAppLatestDeployment } from "@repo/database/access-layer/apps.dal";
import cpApiClient from "@/services/cp-api-client";
import {
  encodeRuntimeLogEvent,
  type RuntimeLogEvent,
} from "@repo/api-sdk/runtime-logs";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function GET(
  request: Request,
  { params }: RouteContext<"/api/apps/[appId]/runtime-logs">,
) {
  const { user } = await withAuth();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { appId: appIdParam } = await params;
  const appId = Number(appIdParam);
  if (!Number.isSafeInteger(appId) || appId < 1) {
    return new Response("Invalid application ID", { status: 400 });
  }

  // This query scopes the deployment to the authenticated app owner.
  const deployment = await getAppLatestDeployment(appId, user.id);
  if (!deployment) return new Response("Deployment not found", { status: 404 });

  const upstream = new AbortController();
  let finished = false;
  const abort = () => upstream.abort(request.signal.reason);
  if (request.signal.aborted) abort();
  else request.signal.addEventListener("abort", abort, { once: true });
  const detach = () => request.signal.removeEventListener("abort", abort);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let identified = false;
      const forward = (event: RuntimeLogEvent) => {
        if (finished || upstream.signal.aborted) return;
        if (event.type === "runtime") identified = true;
        controller.enqueue(encoder.encode(encodeRuntimeLogEvent(event)));
      };
      void cpApiClient
        .streamRuntimeLogs(deployment.id, () => {}, upstream.signal, forward)
        .catch((error: unknown) => {
          if (finished || upstream.signal.aborted) return;
          console.error("Failed to proxy runtime logs", error);
          if (!identified)
            forward({ type: "runtime", deploymentId: deployment.id });
          forward({ type: "error", message: "Failed to read runtime logs." });
          forward({ type: "end", reason: "error" });
        })
        .finally(() => {
          detach();
          if (finished) return;
          finished = true;
          controller.close();
        });
    },
    cancel() {
      finished = true;
      detach();
      upstream.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}
