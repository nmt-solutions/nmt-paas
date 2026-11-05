import { Router } from "express";
import z from "zod";
import { docker } from "../../docker/docker.js";

const appsRouter = Router();
const retirementInput = z.object({
  deploymentIds: z.array(
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ),
});
const missing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "statusCode" in error &&
  error.statusCode === 404;

// Owner authorization and durable retirement happen in the web application.
// This bearer-authenticated host action accepts app/deployment identities only.
appsRouter.post("/:appId/retire", async (req, res) => {
  const appId = z.coerce
    .number()
    .int()
    .positive()
    .max(2147483647)
    .safeParse(req.params.appId);
  const input = retirementInput.safeParse(req.body);
  if (!appId.success || !input.success) {
    res
      .status(400)
      .json({ status: "error", message: "Invalid app retirement", data: null });
    return;
  }
  const allowed = new Set(input.data.deploymentIds.map(String));
  const owns = (labels: Record<string, string> = {}) =>
    labels["nmt.app-id"] === String(appId.data) &&
    labels["nmt.artifact"] === "runtime" &&
    allowed.has(labels["nmt.deployment-id"] ?? "");
  try {
    let complete = true;
    for (const item of await docker.listContainers({ all: true })) {
      const candidate =
        (item.Labels?.["nmt.app-id"] === String(appId.data) &&
          item.Labels?.["nmt.artifact"] === "runtime") ||
        item.Names.some(
          (name) =>
            name.startsWith("/deployment-") &&
            allowed.has(name.slice("/deployment-".length)),
        );
      if (!candidate) continue;
      if (!item.Id || !owns(item.Labels)) {
        complete = false;
        continue;
      }
      try {
        const container = docker.getContainer(item.Id);
        const current = await container.inspect();
        if (
          current.Id !== item.Id ||
          !owns(current.Config.Labels) ||
          current.Config.Labels["nmt.deployment-id"] !==
            item.Labels["nmt.deployment-id"]
        ) {
          complete = false;
          continue;
        }
        await container.remove({ force: true, v: false });
      } catch (error) {
        if (!missing(error)) complete = false;
      }
    }
    res.json({
      status: "success",
      statusCode: 200,
      message: "App retired; runtime cleanup outcome",
      data: { complete },
      errors: null,
    });
  } catch {
    res.status(503).json({
      status: "error",
      statusCode: 503,
      message: "Runtime cleanup unavailable",
      data: null,
      errors: null,
    });
  }
});

export default appsRouter;
