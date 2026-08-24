import "server-only";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { getAppLatestDeployment } from "@repo/database/access-layer/apps.dal";
import cpApiClient from "@/services/cp-api-client";

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

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void cpApiClient
        .streamRuntimeLogs(
          deployment.id,
          (log) =>
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(log)}\n\n`),
            ),
          request.signal,
        )
        .catch((error: unknown) => {
          if (request.signal.aborted) return;
          console.error("Failed to proxy runtime logs", error);
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ message: "Failed to read runtime logs." })}\n\n`,
            ),
          );
        })
        .finally(() => controller.close());
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
