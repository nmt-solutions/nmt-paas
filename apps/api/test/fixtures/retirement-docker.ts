import assert from "node:assert/strict";
import { createServer } from "node:http";
import Docker from "dockerode";

// External Docker HTTP fixture. No real-daemon compatibility is claimed.
export async function retirementDockerFixture() {
  type Container = {
    Id: string;
    Names: string[];
    State: string;
    Labels: Record<string, string>;
  };
  const containers = new Map<string, Container>();
  const failures = new Set<string>();
  const changedOwnership = new Set<string>();
  const disappear = new Set<string>();
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://docker");
    const send = (code: number, body?: unknown) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (request.method === "GET" && url.pathname === "/containers/json")
      return send(200, [...containers.values()]);
    const match = /^\/containers\/([^/]+)(\/json)?$/.exec(url.pathname);
    if (!match) return send(500, { message: "Unexpected Docker operation" });
    const id = match[1]!;
    const container = containers.get(id);
    if (!container) return send(404, { message: "No such container" });
    if (request.method === "GET" && match[2])
      return send(200, {
        Id: id,
        Name: container.Names[0],
        State: { Running: true },
        Config: {
          Labels: changedOwnership.has(id)
            ? { ...container.Labels, "nmt.app-id": "99999" }
            : container.Labels,
        },
      });
    if (request.method === "DELETE") {
      assert.equal(url.searchParams.get("force"), "true");
      assert.ok(
        !["true", "1"].includes(url.searchParams.get("v") ?? ""),
        "Retirement never removes volumes",
      );
      if (failures.has(id))
        return send(500, {
          message: "fixture-host-secret must never reach owner",
        });
      containers.delete(id);
      return send(disappear.has(id) ? 404 : 204);
    }
    return send(500, { message: "Unexpected Docker operation" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const host = `http://127.0.0.1:${address.port}`;
  const docker = new Docker({
    host: "127.0.0.1",
    port: address.port,
    protocol: "http",
  });
  return {
    docker,
    host,
    failures,
    changedOwnership,
    disappear,
    seed(appId: number, deploymentId: number, id = `runtime-${deploymentId}`) {
      containers.set(id, {
        Id: id,
        Names: [`/deployment-${deploymentId}`],
        State: "running",
        Labels: {
          "nmt.app-id": String(appId),
          "nmt.deployment-id": String(deploymentId),
          "nmt.artifact": "runtime",
        },
      });
      return id;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
