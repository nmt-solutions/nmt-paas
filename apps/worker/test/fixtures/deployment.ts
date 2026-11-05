import { createServer } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import Docker from "dockerode";
import { createDockerCommandAdapter } from "../../src/deployment/docker-command-adapter.js";
import type { DeploymentExecutionDependencies } from "../../src/deployment/execute-deployment.js";

export const deploymentId = 42;
export const userId = "fixture-owner";

// A disposable Docker HTTP fixture, not evidence of daemon compatibility.
export async function deploymentFixture({
  failCommand,
}: { failCommand?: string } = {}) {
  const containers = new Map([
    [
      "previous",
      {
        Id: "previous",
        Names: ["/deployment-41"],
        State: "running",
        Labels: { "nmt.app-id": "7" },
      },
    ],
    [
      "unrelated",
      {
        Id: "unrelated",
        Names: ["/another-app"],
        State: "running",
        Labels: { "nmt.app-id": "8" },
      },
    ],
  ]);
  const configurations = new Map<string, Docker.ContainerCreateOptions>();
  const images = new Map<string, { changes: string[] }>();
  const execs = new Map<string, { command: string[]; exitCode: number }>();
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const send = (status: number, value?: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };

    if (url.pathname === "/containers/create") {
      const name = url.searchParams.get("name")!;
      containers.set(name, {
        Id: name,
        Names: [`/${name}`],
        State: "created",
        Labels: body.Labels ?? {},
      });
      configurations.set(name, body);
      return send(201, { Id: name, Warnings: [] });
    }
    if (url.pathname === "/containers/json")
      return send(200, [...containers.values()]);
    if (url.pathname === "/images/create") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"Download complete"}\n');
      return;
    }
    const execMatch = url.pathname.match(/^\/containers\/([^/]+)\/exec$/);
    if (execMatch) {
      const id = `exec-${execs.size}`;
      execs.set(id, {
        command: body.Cmd,
        exitCode: body.Cmd[2] === failCommand ? 1 : 0,
      });
      return send(201, { Id: id });
    }
    const inspectExec = url.pathname.match(/^\/exec\/([^/]+)\/json$/);
    if (inspectExec)
      return send(200, { ExitCode: execs.get(inspectExec[1]!)?.exitCode });
    if (url.pathname === "/commit") {
      const name = `${url.searchParams.get("repo")}:${url.searchParams.get("tag")}`;
      images.set(name, { changes: url.searchParams.getAll("changes") });
      return send(201, { Id: "fixture-image" });
    }
    if (url.pathname.startsWith("/images/") && url.pathname.endsWith("/push")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"Pushed"}\n');
      return;
    }
    const match = url.pathname.match(
      /^\/containers\/([^/]+)(?:\/(start|json|logs))?$/,
    );
    if (match) {
      const id = match[1]!;
      const container = containers.get(id);
      if (!container) return send(404, { message: "No such container" });
      if (request.method === "DELETE") {
        containers.delete(id);
        return send(204);
      }
      if (match[2] === "start") {
        container.State = "running";
        return send(204);
      }
      if (match[2] === "json")
        return send(200, {
          Name: container.Names[0],
          State: { Running: container.State === "running" },
          Config: configurations.get(id),
        });
      if (match[2] === "logs") {
        response.writeHead(200, {
          "Content-Type": "application/vnd.docker.raw-stream",
        });
        response.end();
        return;
      }
    }
    return send(500, {
      message: `Unexpected fixture request: ${request.method} ${url.pathname}`,
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    const id = request.url?.match(/^\/exec\/([^/]+)\/start$/)?.[1];
    const exec = id ? execs.get(id) : undefined;
    if (!exec) {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
    socket.end(`fixture output: ${exec.command[2]}\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a TCP fixture address");
  const docker = new Docker({
    host: "127.0.0.1",
    port: address.port,
  });

  const deployment = {
    id: deploymentId,
    appId: 7,
    repoId: 123,
    env: "production" as const,
    status: "queued",
    branch: "release",
    commit: "1234567890abcdef1234567890abcdef12345678",
    app: {
      appName: "fixture-app",
      projectId: 3,
      appDomains: [{ domain: "fixture.invalid", env: "production" as const }],
      frameworkConfig: {
        port: 3000,
        rootDirectory: "./",
        installCommand: "npm ci",
        buildCommand: "npm run build",
        startCommand: "node dist/server.js",
      },
    },
  };
  const logs: { deploymentId: number; message: string; createdBy: string }[] =
    [];
  const database = {
    getDeployment: async (id: number) =>
      id === deploymentId ? deployment : undefined,
    updateDeployment: async (params: { id: number; status: string }) => {
      deployment.status = params.status;
    },
    createDeploymentLogs: async (log: (typeof logs)[number]) => {
      logs.push(log);
    },
    getLogs: async (id: number) =>
      logs.filter((log) => log.deploymentId === id),
  };
  const dependencies: DeploymentExecutionDependencies = {
    ...database,
    getDocker: async () => docker,
    ...createDockerCommandAdapter({
      ...database,
      getDocker: async () => docker,
    }),
    getCloneUrl: async () => "https://fixture.invalid/repo.git",
    fetchEnvVars: async () => "FIXTURE_VALUE=local-only",
    registry: { username: "Fixture", password: "fixture-pat" },
  };

  return {
    dependencies,
    database,
    docker,
    images,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
