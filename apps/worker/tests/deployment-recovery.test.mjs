import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
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
} from "../test/fixtures/deployment.ts";

test(
  "production BullMQ retries reconcile started runtimes after real PostgreSQL status and log failures",
  {
    timeout: 45_000,
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Set TEST_DATABASE_URL to a disposable local PostgreSQL server",
  },
  async (t) => {
    // A private Redis process, never an existing queue or the production host.
    const directory = await mkdtemp(join(tmpdir(), "nmt-deployment-recovery-"));
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const password = "deployment-recovery-fixture";
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
    const name = `deployment_recovery_${randomBytes(6).toString("hex")}`;
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
    const { getUserApp } = await import("@repo/database/access-layer/apps.dal");
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
    mock.module("octokit", {
      namedExports: {
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
    // This is the production registration and processor, with actual BullMQ/Redis.
    // Only Docker and GitHub are deterministic service boundaries.
    ({ worker } = await import("../src/workers/deployment.worker.ts"));
    ({ redis } = await import("@repo/redis"));
    const workerErrors = [];
    worker.on("error", (error) => workerErrors.push(error));
    await worker.waitUntilReady();

    for (const kind of ["status", "log"]) {
      await t.test(
        `post-start ${kind} failure`,
        { timeout: 20_000 },
        async (t) => {
          await database.delete(schema.DeploymentLogs);
          await database.delete(schema.Deployments);
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
          const fixture = await deploymentFixture({
            source: {
              rootDirectory: "/app",
              head: "1234567890abcdef1234567890abcdef12345678",
              cloneUrl: "https://github.com/fixture/repo.git",
              commits: {
                "1234567890abcdef1234567890abcdef12345678":
                  "runtime boot fixture-runtime-secret",
              },
            },
          });
          t.after(fixture.close);
          docker = fixture.docker;
          // Real PostgreSQL rejects the selected write until the test restores it.
          const table =
            kind === "status" ? '"Deployments"' : '"DeploymentLogs"';
          const condition =
            kind === "status"
              ? "NEW.status = 'success'"
              : "NEW.message LIKE 'Container started for fixture-app at %'";
          await fixtureDb.query(
            `CREATE OR REPLACE FUNCTION reject_recovery_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'fixture post-start write rejected fixture-registry-token'; END IF; RETURN NEW; END $$`,
          );
          await fixtureDb.query(
            `CREATE TRIGGER recovery_fault BEFORE ${kind === "status" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_recovery_write()`,
          );
          t.after(() =>
            fixtureDb.query(
              `DROP TRIGGER IF EXISTS recovery_fault ON ${table}`,
            ),
          );
          const failures = [];
          const firstFailed = once(worker, "failed");
          const job = await queue.add(
            "deployment-queue",
            { userId, deploymentId },
            {
              attempts: 3,
              backoff: { type: "exponential", delay: 2000 },
              removeOnComplete: 100,
              removeOnFail: 1000,
            },
          );
          const completed = job.waitUntilFinished(events, 18_000);
          t.after(async () => {
            await (await queue.getJob(job.id))?.remove();
          });
          // Always observe this promise even if a history assertion fails below.
          completed.catch(() => {});
          for (let attempt = 1; attempt <= 2; attempt++) {
            const [failedJob, error] = await (attempt === 1
              ? firstFailed
              : once(worker, "failed"));
            failures.push(Date.now());
            assert.equal(failedJob.id, job.id);
            assert.equal(failedJob.attemptsMade, attempt);
            assert.equal(await failedJob.getState(), "delayed");
            assert.match(error.message, /Runtime started; recovery pending/);
            assert.doesNotMatch(
              error.message,
              /fixture-registry-token|fixture-clone-token/,
            );
            assert.equal(
              (await docker.getContainer("deployment-42").inspect()).State
                .Running,
              true,
            );
            assert.equal(
              (await docker.getContainer("previous").inspect()).State.Running,
              true,
            );
            const history = await getUserApp(7, userId);
            assert.equal(
              history.deployments[0].status,
              kind === "status" ? "starting" : "success",
            );
            const logs = history.deployments[0].deploymentLogs
              .map((log) => log.message)
              .join("\n");
            assert.match(logs, /Runtime started; recovery pending/);
            assert.doesNotMatch(
              logs,
              /fixture-registry-token|fixture-clone-token/,
            );
          }
          await fixtureDb.query(`DROP TRIGGER recovery_fault ON ${table}`);
          await completed;
          const finished = await queue.getJob(job.id);
          assert.equal(finished.attemptsMade, 3);
          assert.equal(await finished.getState(), "completed");
          assert.ok(
            failures[1] - failures[0] >= 1800,
            "actual first retry respects the two-second backoff",
          );
          assert.ok(
            Date.now() - failures[1] >= 3800,
            "actual second retry respects the four-second backoff",
          );
          assert.equal(
            (await getUserApp(7, userId)).deployments[0].status,
            "success",
          );
          assert.deepEqual(
            (await docker.listContainers({ all: true }))
              .map((container) => container.Id)
              .sort(),
            ["deployment-42", "unrelated"],
          );
          assert.deepEqual(workerErrors, []);
          let runtimeLogs = "";
          for (let count = 0; count < 100; count++) {
            runtimeLogs = (
              await getUserApp(7, userId)
            ).deployments[0].deploymentLogs
              .map((log) => log.message)
              .join("\n");
            if (runtimeLogs.includes("runtime boot")) break;
            await delay(10);
          }
          assert.match(runtimeLogs, /runtime boot \[REDACTED\]/);
          assert.doesNotMatch(runtimeLogs, /fixture-runtime-secret/);
        },
      );
    }
  },
);
