import { createServer } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import Docker from "dockerode";
import { createDockerCommandAdapter } from "../../src/deployment/docker-command-adapter.js";
import type { DeploymentExecutionDependencies } from "../../src/deployment/execute-deployment.js";
import type { DeploymentCleanup } from "@repo/database/schema";

export const deploymentId = 42;
export const userId = "fixture-owner";

// A disposable Docker HTTP fixture, not evidence of daemon compatibility.
export async function deploymentFixture({
  failCommand,
  source,
  failStart,
  failCreate,
  failPull = false,
  failCommit = false,
  failRemove = {},
  disappearOnRemove = [],
  beforeRemove,
  failInspect = {},
  pushOutput = () => ['{"status":"42: digest: sha256:1234 size: 123"}\n'],
}: {
  failCommand?: string;
  source?: {
    rootDirectory: string;
    head: string;
    commits: Record<string, string>;
    cloneUrl?: string;
    environmentKeys?: { install: string; build: string; runtime: string };
    files?: Record<string, string>;
  };
  failStart?: string;
  failCreate?: string;
  failPull?: boolean;
  failCommit?: boolean;
  failRemove?: Record<string, string>;
  disappearOnRemove?: string[];
  beforeRemove?: (id: string) => Promise<void>;
  failInspect?: Record<string, string>;
  pushOutput?: (authorization: string) => string[];
} = {}) {
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
  const images = new Map<
    string,
    {
      id: string;
      changes: string[];
      artifact?: string;
      labels?: Record<string, string>;
      publicAsset?: string;
      files: Record<string, string>;
      environment: string[];
    }
  >();
  const execs = new Map<
    string,
    { command: string[]; exitCode: number; output?: string }
  >();
  let revision: string | undefined;
  let installed = false;
  let artifact: string | undefined;
  let publicAsset: string | undefined;
  const files: Record<string, string> = {};
  const environment = (entries: string[] = []) =>
    Object.fromEntries(
      entries.map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
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

    if (url.pathname === "/auth")
      return send(200, { Status: "Login Succeeded" });

    if (url.pathname === "/containers/create") {
      const name = url.searchParams.get("name")!;
      const image = images.get(body.Image);
      if (image) {
        body.WorkingDir ??= image.changes
          .find((change) => change.startsWith("WORKDIR "))
          ?.slice(8);
      }
      if (containers.has(name))
        return send(409, { message: "Container name already in use" });
      if (name === failCreate)
        return send(500, { message: "fixture create rejected" });
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
      if (failPull) return send(500, { message: "fixture pull rejected" });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"Download complete"}\n');
      return;
    }
    const execMatch = url.pathname.match(/^\/containers\/([^/]+)\/exec$/);
    if (execMatch) {
      const id = `exec-${execs.size}`;
      const command = body.Cmd[0] === "sh" ? body.Cmd[2] : body.Cmd.join(" ");
      let exitCode = command === failCommand ? 1 : 0;
      let output: string | undefined;
      const workDir =
        body.WorkingDir || configurations.get(execMatch[1]!)?.WorkingDir;
      if (command.startsWith("git clone ")) {
        const cloneUrl = command.slice("git clone ".length).split(" ")[0];
        files["/app/.git/config"] = `[remote "origin"]\nurl = ${cloneUrl}`;
        files["/app/.git/logs/HEAD"] = `clone: from ${cloneUrl}`;
        Object.assign(files, source?.files);
      } else if (command.startsWith("cat > .env")) {
        files[`${workDir}/.env`] = command.split("\n").slice(1, -1).join("\n");
      } else if (body.Cmd[0] === "rm") {
        const targets: string[] = body.Cmd.slice(1).filter(
          (arg: string) => !arg.startsWith("-"),
        );
        if (exitCode === 0) {
          for (const path of Object.keys(files)) {
            if (
              targets.some(
                (target) => path === target || path.startsWith(`${target}/`),
              )
            )
              delete files[path];
          }
        }
      }
      if (source) {
        if (command.startsWith("git clone ")) {
          const cloneUrl = new URL(
            command.slice("git clone ".length).split(" ")[0],
          );
          cloneUrl.username = "";
          cloneUrl.password = "";
          if (!source.cloneUrl || cloneUrl.href === source.cloneUrl)
            revision = source.head;
          else {
            exitCode = 128;
            output = "fatal: repository not found";
          }
        } else if (command.startsWith("git checkout --detach ")) {
          const target = command.slice("git checkout --detach ".length);
          if (source.commits[target]) revision = target;
          else {
            exitCode = 128;
            output = "fatal: recorded commit is not available";
          }
        } else if (command === "npm ci") {
          if (workDir === source.rootDirectory && revision) installed = true;
          else {
            exitCode = 1;
            output = "package.json not found in working directory";
          }
          if (source.environmentKeys) {
            const value = environment(body.Env)[source.environmentKeys.install];
            if (value === undefined) {
              exitCode = 1;
              output = "Install configuration missing";
            } else output = `Install configuration: ${value}`;
          }
          if (exitCode === 0)
            files[`${workDir}/node_modules/fixture-dependency/index.js`] =
              "module.exports = 'fixture dependency';";
        } else if (command === "npm run build") {
          if (workDir === source.rootDirectory && installed && revision)
            artifact = source.commits[revision];
          else {
            exitCode = 1;
            output = "build dependencies not found in working directory";
          }
          if (source.environmentKeys) {
            publicAsset = environment(body.Env)[source.environmentKeys.build];
            if (publicAsset === undefined) {
              exitCode = 1;
              output = "Build configuration missing";
            } else output = `Build configuration: ${publicAsset}`;
          }
          if (exitCode === 0) {
            files[`${workDir}/dist/server.js`] = `// release: ${artifact}`;
            if (publicAsset !== undefined)
              files[`${workDir}/dist/public.txt`] = publicAsset;
          }
        }
      }
      execs.set(id, {
        command: body.Cmd,
        exitCode,
        output,
      });
      return send(201, { Id: id });
    }
    const inspectExec = url.pathname.match(/^\/exec\/([^/]+)\/json$/);
    if (inspectExec)
      return send(200, { ExitCode: execs.get(inspectExec[1]!)?.exitCode });
    if (url.pathname === "/commit") {
      if (failCommit) return send(500, { message: "fixture commit rejected" });
      const name = `${url.searchParams.get("repo")}:${url.searchParams.get("tag")}`;
      images.set(name, {
        id: "fixture-image",
        changes: url.searchParams.getAll("changes"),
        artifact,
        labels: {
          ...configurations.get(url.searchParams.get("container")!)?.Labels,
          ...Object.fromEntries(
            url.searchParams
              .getAll("changes")
              .filter((change) => change.startsWith("LABEL "))
              .map((change) => change.slice(6).split("=")),
          ),
        },
        publicAsset,
        files: { ...files },
        environment:
          configurations.get(url.searchParams.get("container")!)?.Env ?? [],
      });
      return send(201, { Id: "fixture-image" });
    }
    if (url.pathname.startsWith("/images/") && url.pathname.endsWith("/json")) {
      const id = decodeURIComponent(
        url.pathname.slice("/images/".length, -"/json".length),
      );
      const image =
        images.get(id) ??
        [...images.values()].find((image) => image.id === id && image.labels) ??
        [...images.values()].find((image) => image.id === id);
      return image
        ? send(200, { Id: image.id, Config: { Labels: image.labels ?? {} } })
        : send(404, { message: "No such image" });
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/images/")) {
      const id = decodeURIComponent(url.pathname.slice("/images/".length));
      if (failRemove[id]) return send(500, { message: failRemove[id] });
      const matches = [...images.entries()].filter(
        ([name, image]) => name === id || image.id === id,
      );
      if (matches.length > 1 && url.searchParams.get("force") !== "true")
        return send(409, {
          message: "Image referenced by multiple repositories",
        });
      const image = matches[0];
      if (!image) return send(404, { message: "No such image" });
      for (const [name] of matches) images.delete(name);
      if (disappearOnRemove.includes(id))
        return send(404, { message: "No such image" });
      return send(200, [{ Deleted: image[1].id }]);
    }
    if (url.pathname.startsWith("/images/") && url.pathname.endsWith("/push")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      for (const chunk of pushOutput(
        String(request.headers["x-registry-auth"]),
      )) {
        response.write(chunk);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      response.end();
      return;
    }
    const match = url.pathname.match(
      /^\/containers\/([^/]+)(?:\/(start|stop|json|logs))?$/,
    );
    if (match) {
      const id = match[1]!;
      const container = containers.get(id);
      if (!container) return send(404, { message: "No such container" });
      if (request.method === "DELETE") {
        await beforeRemove?.(id);
        if (failRemove[id]) return send(500, { message: failRemove[id] });
        containers.delete(id);
        if (disappearOnRemove.includes(id))
          return send(404, { message: "No such container" });
        return send(204);
      }
      if (match[2] === "stop") {
        container.State = "exited";
        return send(204);
      }
      if (match[2] === "start") {
        if (id === failStart)
          return send(500, { message: "fixture start rejected" });
        const config = configurations.get(id);
        if (source && !id.startsWith("builder-")) {
          if (
            config?.WorkingDir !== source.rootDirectory ||
            !images.get(config.Image!)?.files[
              `${config.WorkingDir}/dist/server.js`
            ]
          ) {
            return send(400, {
              message: `Application artifact not found in ${config?.WorkingDir}`,
            });
          }
        }
        container.State = "running";
        return send(204);
      }
      if (match[2] === "json") {
        if (failInspect[id]) return send(500, { message: failInspect[id] });
        return send(200, {
          Name: container.Names[0],
          Image:
            images.get(configurations.get(id)?.Image ?? "")?.id ??
            "fixture-image",
          State: { Running: container.State === "running" },
          Config: configurations.get(id) ?? { Labels: container.Labels },
        });
      }
      if (match[2] === "logs") {
        response.writeHead(200, {
          "Content-Type": "application/vnd.docker.raw-stream",
        });
        const config = configurations.get(id);
        const image = config ? images.get(config.Image!) : undefined;
        const output = source?.environmentKeys
          ? JSON.stringify({
              release: image?.artifact,
              publicAsset: image?.publicAsset,
              runtimeValue: environment(config?.Env)[
                source.environmentKeys.runtime
              ],
            })
          : image?.artifact;
        if (output) {
          const payload = Buffer.from(`${output}\n`);
          const header = Buffer.alloc(8);
          header[0] = 1;
          header.writeUInt32BE(payload.length, 4);
          response.end(Buffer.concat([header, payload]));
        } else response.end();
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
    socket.end(`${exec.output ?? `fixture output: ${exec.command[2]}`}\n`);
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
    userId,
    cleanup: null as DeploymentCleanup | null,
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
  const deployments = new Map([[deploymentId, deployment]]);
  const publications = new Map<
    number,
    {
      deploymentId: number;
      imageId: string;
      imageName: string;
      status: "pending" | "publishing" | "published" | "failed";
      lastError: string | null;
    }
  >();
  const database = {
    saveDeploymentCleanup: async (id: number, cleanup: DeploymentCleanup) => {
      const record = deployments.get(id);
      if (record) record.cleanup = structuredClone(cleanup);
    },
    getDeployment: async (id: number) => deployments.get(id),
    createDeployment: async (id: number, appId = 7) => {
      const next = structuredClone(deployment);
      next.id = id;
      next.appId = appId;
      next.cleanup = null;
      if (appId !== 7) next.app.appDomains[0]!.domain = `app-${appId}.invalid`;
      deployments.set(id, next);
      return next;
    },
    updateDeployment: async (params: { id: number; status: string }) => {
      const record = deployments.get(params.id);
      if (record) record.status = params.status;
    },
    createDeploymentLogs: async (log: (typeof logs)[number]) => {
      logs.push(log);
    },
    getLogs: async (id: number) =>
      logs.filter((log) => log.deploymentId === id),
    getPublication: async (id: number, owner: string) =>
      owner === userId ? publications.get(id) : undefined,
    recordPublication: async (record: {
      deploymentId: number;
      imageId: string;
      imageName: string;
    }) => {
      const existing = publications.get(record.deploymentId);
      if (
        existing &&
        (existing.imageId !== record.imageId ||
          existing.imageName !== record.imageName)
      )
        throw new Error("Publication image identity changed");
      if (!existing)
        publications.set(record.deploymentId, {
          ...record,
          status: "pending",
          lastError: null,
        });
    },
    updatePublication: async (
      id: number,
      state: {
        status: "pending" | "publishing" | "published" | "failed";
        lastError: string | null;
      },
    ) => {
      Object.assign(publications.get(id)!, state);
    },
  };
  const dependencies: DeploymentExecutionDependencies = {
    ...database,
    getDocker: async () => docker,
    ...createDockerCommandAdapter({
      ...database,
      getDocker: async () => docker,
    }),
    getCloneUrl: async () => "https://fixture.invalid/repo.git",
    fetchEnvVars: async () => [{ key: "FIXTURE_VALUE", value: "local-only" }],
    registry: { username: "Fixture", password: "fixture-pat" },
  };

  return {
    restoreStart: () => {
      failStart = undefined;
    },
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
