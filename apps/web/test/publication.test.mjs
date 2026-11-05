import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHTTPServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import test, { mock } from "node:test";
import { Queue, QueueEvents } from "bullmq";
import pg from "pg";
import {
  deploymentFixture,
  deploymentId,
  userId,
} from "../../worker/test/fixtures/deployment.ts";

test(
  "owners and administrators recover persisted image publication after a production worker restart",
  {
    timeout: 60_000,
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Set TEST_DATABASE_URL to a disposable local PostgreSQL server",
  },
  async (t) => {
    // A private Redis process, never an existing queue or the production host.
    const directory = await mkdtemp(
      join(tmpdir(), "nmt-deployment-publication-"),
    );
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const password = "deployment-publication-fixture";
    // Tool selection for this uncached local integration harness only.
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    const redisExecutable = process.env.REDIS_SERVER_BIN || "redis-server";
    const server = spawn(
      redisExecutable,
      [
        "--bind",
        "127.0.0.1",
        "--port",
        String(port),
        "--requirepass",
        password,
        "--save",
        "",
        "--appendonly",
        "no",
        "--dir",
        ".",
      ],
      { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let launchError;
    let worker;
    let redis;
    let queue;
    let events;
    let output = "";
    server.on("error", (error) => {
      launchError = error;
    });
    for (const stream of [server.stdout, server.stderr])
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-4000);
      });
    t.after(async () => {
      await worker?.close(true);
      redis?.disconnect();
      await events?.close();
      await queue?.close();
      if (server.exitCode === null && !launchError) {
        const exited = once(server, "exit");
        server.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    });
    const connection = {
      host: "127.0.0.1",
      port,
      password,
      maxRetriesPerRequest: null,
    };
    queue = new Queue("deployment-queue", { connection });
    events = new QueueEvents("deployment-queue", { connection });
    queue.on("error", () => {});
    events.on("error", () => {});
    for (let count = 0; count < 100; count++) {
      assert.ifError(launchError);
      assert.equal(server.exitCode, null, output);
      if (await queue.client.then((client) => client.ping()).catch(() => false))
        break;
      await delay(25);
    }
    await events.waitUntilReady();

    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const name = `deployment_publication_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const fixtureDb = new pg.Pool({ connectionString: url.href });
    let database;
    t.after(async () => {
      await database?.$client.end();
      await fixtureDb.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    });
    const migrations = new URL(
      "../../../packages/database/database/development/",
      import.meta.url,
    );
    for (const entry of (await readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      await fixtureDb.query(
        await readFile(
          new URL(`${entry.name}/migration.sql`, migrations),
          "utf8",
        ),
      );
    }
    Object.assign(process.env, {
      DB_ENV: "development",
      DEV_DATABASE_URL: url.href,
      PROD_DATABASE_URL: url.href,
      BASE_DOMAIN: "example.test",
      GITHUB_APP_ID: "1",
      GITHUB_APP_SLUG: "fixture",
      GITHUB_APP_PRIVATE_KEY: "fixture-private-key",
      GITHUB_PAT: "fixture-registry-token",
      GITHUB_USER_NAME: "fixture",
      ENV_ENCRYPTION_KEY: "11".repeat(32),
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: String(port),
      REDIS_PASSWORD: password,
    });
    ({ database } = await import("@repo/database"));
    const schema = await import("@repo/database/schema");
    const { createDeployment } =
      await import("@repo/database/access-layer/deployment.dal");
    const [project] = await database
      .insert(schema.Projects)
      .values({ name: "recovery-fixture", userId, createdBy: userId })
      .returning();
    await database.insert(schema.Apps).values({
      id: 7,
      appName: "fixture-app",
      projectId: project.id,
      gitProvider: "github",
      repoId: 123,
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
      framework: "node",
      rootDirectory: "./",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      startCommand: "node dist/server.js",
      outputDirectory: "dist",
      port: 3000,
      createdBy: userId,
    });
    await database
      .insert(schema.GithubAppInstallations)
      .values({ installationId: 1, userId, createdBy: userId });

    const iv = Buffer.alloc(12, 3);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from("11".repeat(32), "hex"),
      iv,
    );
    const encrypted = Buffer.concat([
      cipher.update("fixture-runtime-secret"),
      cipher.final(),
    ]);
    await database.insert(schema.EnvVars).values({
      projectId: project.id,
      env: "production",
      key: "APP_PASSWORD",
      encryptedValue: [iv, cipher.getAuthTag(), encrypted]
        .map((part) => part.toString("base64"))
        .join(":"),
      createdBy: userId,
    });

    let docker;
    mock.module("dockerode", {
      defaultExport: class {
        constructor() {
          return docker;
        }
      },
    });
    const actualOctokit = await import("octokit");
    mock.module("octokit", {
      namedExports: {
        ...actualOctokit,
        App: class {
          async getInstallationOctokit() {
            return {
              request: async (route) => ({
                data:
                  route === "GET /repositories/{repository_id}"
                    ? { clone_url: "https://github.com/fixture/repo.git" }
                    : { account: { login: "fixture" } },
              }),
              auth: async () => ({ token: "fixture-clone-token" }),
            };
          }
        },
      },
    });
    let denyPublication = true;
    const fixture = await deploymentFixture({
      pushOutput: () =>
        denyPublication
          ? ['{"error":"registry denied fixture-registry-token"}\n']
          : ['{"status":"42: digest: sha256:1234 size: 123"}\n'],
    });
    t.after(fixture.close);
    docker = fixture.docker;
    // This is the production registration and processor, with actual BullMQ/Redis.
    // Only Docker and GitHub are deterministic service boundaries.
    ({ worker } =
      await import("../../worker/src/workers/deployment.worker.ts"));
    ({ redis } = await import("@repo/redis"));
    const workerErrors = [];
    worker.on("error", (error) => workerErrors.push(error));
    await worker.waitUntilReady();

    let recoveryJob;
    const host = createHTTPServer(async (request, response) => {
      assert.equal(
        request.headers.authorization,
        "Bearer publication-host-key",
      );
      assert.equal(request.url, "/deployments/publication");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString());
      recoveryJob = await queue.add(
        "deployment-queue",
        { ...data, operation: "publish" },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 1000,
        },
      );
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ status: "success", statusCode: 201, data: true }),
      );
    });
    host.listen(0, "127.0.0.1");
    await once(host, "listening");
    t.after(() => new Promise((resolve) => host.close(resolve)));
    process.env.API_BASE_URL = `http://127.0.0.1:${host.address().port}`;
    process.env.API_KEY = "publication-host-key";
    mock.module("server-only", { namedExports: {} });
    const { deploymentRouter } =
      await import("../src/trpc/routers/deployment.trpcs.ts");
    const caller = (id, permissions = []) =>
      deploymentRouter.createCaller({
        userInfo: { user: id ? { id } : null, permissions },
      });
    const owner = caller(userId);
    await createDeployment({
      id: deploymentId,
      appId: 7,
      repoId: 123,
      branch: "release",
      commit: "1234567890abcdef1234567890abcdef12345678",
      env: "production",
      userId,
      createdBy: userId,
    });
    const job = await queue.add("deployment-queue", { deploymentId, userId });
    await job.waitUntilFinished(events, 15_000);
    let view;
    for (let count = 0; count < 100; count++) {
      view = await owner.publication({ deploymentId });
      if (view.publication?.status === "failed") break;
      await delay(20);
    }
    assert.equal(view.status, "success");
    assert.equal(view.publication.status, "failed");
    assert.equal(view.publication.imageId, "fixture-image");
    assert.match(view.publication.lastError, /registry denied \[REDACTED\]/);
    assert.doesNotMatch(
      JSON.stringify(view),
      /fixture-registry-token|fixture-clone-token/,
    );
    const { appRouter } = await import("../src/trpc/routers/app.trpc.ts");
    const appOwner = appRouter.createCaller({
      userInfo: { user: { id: userId } },
    });
    const history = await appOwner.deploymentLogs({ appId: 7, deploymentId });
    assert.equal(history.hasMore, false);
    assert.ok(history.logs.every((log) => !log.truncated));
    assert.doesNotMatch(
      JSON.stringify(history),
      /fixture-registry-token|fixture-clone-token/,
    );
    assert.ok(
      history.logs.some((log) => log.message.includes("Container started")),
    );
    for (const action of ["publication", "retryPublication"]) {
      await assert.rejects(caller(null)[action]({ deploymentId }), {
        code: "UNAUTHORIZED",
      });
      await assert.rejects(caller("foreign")[action]({ deploymentId }), {
        code: "NOT_FOUND",
      });
      await assert.rejects(caller(userId)[action]({ deploymentId: 999999 }), {
        code: "NOT_FOUND",
      });
    }
    await worker.close();
    // Import a fresh registration/executor with the same persisted database and image.
    ({ worker } =
      await import("../../worker/src/workers/deployment.worker.ts?publication-restart"));
    await worker.waitUntilReady();
    denyPublication = false;
    const administrator = caller("administrator", ["admin"]);
    assert.equal(
      (await administrator.publication({ deploymentId })).publication.status,
      "failed",
    );
    // Real PostgreSQL rejects the publication acknowledgement after the
    // registry confirms its manifest. BullMQ must retry publication only.
    await fixtureDb.query(
      `CREATE FUNCTION reject_publication_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'published' THEN RAISE EXCEPTION 'publication persistence rejected fixture-registry-token'; END IF; RETURN NEW; END $$`,
    );
    await fixtureDb.query(
      `CREATE TRIGGER publication_fault BEFORE UPDATE ON "DeploymentPublications" FOR EACH ROW EXECUTE FUNCTION reject_publication_confirmation()`,
    );
    const failedRecovery = once(worker, "failed");
    assert.deepEqual(await administrator.retryPublication({ deploymentId }), {
      deploymentId,
      queued: true,
    });
    const [failedJob, failure] = await failedRecovery;
    assert.equal(failedJob.id, recoveryJob.id);
    assert.equal(
      failure.message,
      "Registry publication outcome could not be saved. Retry publication to confirm the recorded image.",
    );
    assert.doesNotMatch(failure.message, /fixture-registry-token/);
    assert.equal((await owner.publication({ deploymentId })).status, "success");
    assert.equal(
      (await owner.publication({ deploymentId })).publication.status,
      "failed",
    );
    assert.equal(
      (await owner.publication({ deploymentId })).publication.lastError,
      "Registry publication outcome could not be saved. Retry publication to confirm the recorded image.",
    );
    const failedAt = Date.now();
    await fixtureDb.query(
      'DROP TRIGGER publication_fault ON "DeploymentPublications"',
    );
    await recoveryJob.waitUntilFinished(events, 12_000);
    assert.equal((await queue.getJob(recoveryJob.id)).attemptsMade, 2);
    assert.ok(Date.now() - failedAt >= 1800);

    for (let count = 0; count < 150; count++) {
      view = await owner.publication({ deploymentId });
      if (view.publication.status === "published") break;
      await delay(20);
    }
    assert.equal(view.publication.status, "published");
    assert.equal(view.publication.lastError, null);
    assert.equal(view.status, "success");
    assert.deepEqual(
      (await docker.listContainers({ all: true })).map((c) => c.Id).sort(),
      ["deployment-42", "unrelated"],
    );
    assert.equal(fixture.images.size, 1);
    assert.deepEqual(await owner.retryPublication({ deploymentId }), {
      deploymentId,
      queued: false,
    });
    assert.deepEqual(workerErrors, []);
    assert.deepEqual(
      await appOwner.deploymentLogs({ appId: 7, deploymentId }),
      history,
      "Publication-only recovery must not alter persisted deployment history",
    );
  },
);
