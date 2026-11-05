import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { format } from "node:util";
import test, { mock } from "node:test";
import pg from "pg";
import process from "node:process";
import { URL } from "node:url";

test(
  "production deployment diagnostics redact fixture credentials and environment values",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Set TEST_DATABASE_URL to a disposable local PostgreSQL server",
  },
  async (t) => {
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const name = `diagnostics_${crypto.randomBytes(6).toString("hex")}`;
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
    for (const directory of (await fs.readdir(migrations)).sort()) {
      await fixtureDb.query(
        await fs.readFile(
          new URL(`${directory}/migration.sql`, migrations),
          "utf8",
        ),
      );
    }
    Object.assign(process.env, {
      DEV_DATABASE_URL: url.href,
      PROD_DATABASE_URL: url.href,
      DB_ENV: "development",
      BASE_DOMAIN: "example.test",
      GITHUB_APP_ID: "1",
      GITHUB_APP_SLUG: "fixture",
      GITHUB_APP_PRIVATE_KEY: "fixture-private-key",
      GITHUB_PAT: "fixture-registry-token",
      GITHUB_USER_NAME: "fixture-owner",
      ENV_ENCRYPTION_KEY: "11".repeat(32),
      REDIS_HOST: "localhost",
      REDIS_PORT: "6379",
      REDIS_PASSWORD: "fixture-redis-password",
    });

    let processJob;
    mock.module("bullmq", {
      namedExports: {
        Worker: class extends EventEmitter {
          constructor(_name, processor) {
            super();
            processJob = processor;
          }
        },
      },
    });
    mock.module("ioredis", { defaultExport: class {} });
    mock.module("octokit", {
      namedExports: {
        App: class {
          async getInstallationOctokit() {
            return {
              request: async () => ({
                data: { account: { login: "fixture-owner" } },
              }),
              auth: async () => ({ token: "fixture-clone-token" }),
            };
          }
        },
      },
    });

    let deploymentId;
    let failureStage = "clone";
    const docker = {
      checkAuth: async () => {
        if (failureStage === "authentication") {
          const error = new Error(
            "registry authorization rejected: fixture-registry-token (HTTP 403)",
          );
          error.request = { password: "fixture-registry-token" };
          throw error;
        }
        return {};
      },
      pull: (_image, callback) => callback(null, Readable.from([])),
      modem: { followProgress: (_stream, callback) => callback(null) },
      createContainer: async () => ({
        start: async () => {},
        remove: async () => {},
        inspect: async () => ({ Name: `/builder-${deploymentId}` }),
        exec: async ({ Cmd, Tty }) => {
          const command = Cmd.join(" ");
          const fails =
            failureStage === "clone"
              ? command.includes("git clone")
              : command.includes("cat > .env");
          return {
            start: async () => {
              const chunks =
                fails && failureStage === "environment"
                  ? [
                      "configuration rejected fixture-app-",
                      "secret-value\ncheck file permissions\n",
                    ]
                  : fails
                    ? [
                        "git: repository access denied\nhttps://x-access-token:fixture-clone-",
                        "token@github.com/fixture-owner/fixture-app.git\n",
                      ]
                    : ["command completed\n"];
              // Docker exec without TTY sends multiplex headers between frames.
              return Readable.from(
                chunks.map((chunk) => {
                  if (Tty) return chunk;
                  const header = Buffer.alloc(8);
                  header[0] = 1;
                  header.writeUInt32BE(Buffer.byteLength(chunk), 4);
                  return Buffer.concat([header, Buffer.from(chunk)]);
                }),
              );
            },
            inspect: async () => ({ ExitCode: fails ? 128 : 0 }),
          };
        },
      }),
    };
    mock.module("dockerode", {
      defaultExport: class {
        constructor() {
          return docker;
        }
      },
    });

    ({ database } = await import("@repo/database"));
    const { getUserApp } = await import("@repo/database/access-layer/apps.dal");
    const schema = await import("@repo/database/schema");
    const [project] = await database
      .insert(schema.Projects)
      .values({
        name: "fixture",
        userId: "fixture-user",
        createdBy: "fixture-user",
      })
      .returning();
    const [app] = await database
      .insert(schema.Apps)
      .values({
        appName: "fixture-app",
        projectId: project.id,
        gitProvider: "github",
        repoId: 1,
        createdBy: "fixture-user",
      })
      .returning();
    await database.insert(schema.AppDomains).values({
      appId: app.id,
      domain: "fixture.example.test",
      env: "production",
      userId: "fixture-user",
      createdBy: "fixture-user",
    });
    await database.insert(schema.FrameworkConfig).values({
      appId: app.id,
      framework: "node",
      rootDirectory: "./",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      startCommand: "npm start",
      outputDirectory: "dist",
      port: 3000,
      createdBy: "fixture-user",
    });
    await database.insert(schema.GithubAppInstallations).values({
      installationId: 1,
      userId: "fixture-user",
      createdBy: "fixture-user",
    });
    const [deployment] = await database
      .insert(schema.Deployments)
      .values({
        appId: app.id,
        repoId: 1,
        branch: "main",
        commit: "abc123",
        env: "production",
        userId: "fixture-user",
        createdBy: "fixture-user",
      })
      .returning();
    deploymentId = deployment.id;

    const output = [];
    t.mock.method(console, "log", (...args) => output.push(format(...args)));
    t.mock.method(console, "error", (...args) => output.push(format(...args)));
    // Deliver through the production BullMQ callback; only vendor boundaries
    // (queue, Docker and GitHub) are deterministic. Persistence is PostgreSQL.
    await import("../src/workers/deployment.worker.ts");
    let failure;
    await assert.rejects(
      processJob({ data: { userId: "fixture-user", deploymentId } }),
      (error) => {
        failure = error;
        return true;
      },
    );
    const view = await getUserApp(app.id, "fixture-user");
    const messages = view.deployments[0].deploymentLogs
      .map((log) => log.message)
      .join("\n");
    assert.equal(view.deployments[0].status, "failed");
    const diagnostics = `${output.join("\n")}\n${messages}\n${format(failure)}`;
    assert.ok(
      !diagnostics.includes("fixture-clone-token"),
      "fixture clone token leaked through production diagnostics",
    );
    assert.match(diagnostics, /clon(?:e|ing)/i);
    assert.match(diagnostics, /exit code 128/i);
    assert.match(messages, /repository access denied/);
    assert.match(messages, /\[REDACTED\]/);

    failureStage = "environment";
    const iv = Buffer.alloc(12, 2);
    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      Buffer.from("11".repeat(32), "hex"),
      iv,
    );
    const encrypted = Buffer.concat([
      cipher.update("fixture-app-secret-value"),
      cipher.final(),
    ]);
    await database.insert(schema.EnvVars).values({
      projectId: project.id,
      env: "production",
      key: "APP_PASSWORD",
      encryptedValue: [iv, cipher.getAuthTag(), encrypted]
        .map((part) => part.toString("base64"))
        .join(":"),
      createdBy: "fixture-user",
    });
    const [nextDeployment] = await database
      .insert(schema.Deployments)
      .values({
        appId: app.id,
        repoId: 1,
        branch: "main",
        commit: "def456",
        env: "production",
        userId: "fixture-user",
        createdBy: "fixture-user",
      })
      .returning();
    deploymentId = nextDeployment.id;
    output.length = 0;
    await assert.rejects(
      processJob({ data: { userId: "fixture-user", deploymentId } }),
      (error) => {
        failure = error;
        return true;
      },
    );
    const updatedView = await getUserApp(app.id, "fixture-user");
    const envMessages = updatedView.deployments
      .find((item) => item.id === deploymentId)
      .deploymentLogs.map((log) => log.message)
      .join("\n");
    const envDiagnostics = `${output.join("")}\n${envMessages}\n${format(failure)}`;
    assert.ok(
      !envDiagnostics.includes("fixture-app-secret-value"),
      "configured environment value leaked through production diagnostics",
    );
    assert.match(
      envDiagnostics,
      /Configure environment failed \(exit code 128\)/,
    );
    assert.match(envMessages, /check file permissions/);
    assert.match(envMessages, /\[REDACTED\]/);

    failureStage = "authentication";
    const [authDeployment] = await database
      .insert(schema.Deployments)
      .values({
        appId: app.id,
        repoId: 1,
        branch: "main",
        commit: "fed987",
        env: "production",
        userId: "fixture-user",
        createdBy: "fixture-user",
      })
      .returning();
    deploymentId = authDeployment.id;
    output.length = 0;
    await assert.rejects(
      processJob({ data: { userId: "fixture-user", deploymentId } }),
      (error) => {
        failure = error;
        return true;
      },
    );
    const authView = await getUserApp(app.id, "fixture-user");
    const authMessages = authView.deployments
      .find((item) => item.id === deploymentId)
      .deploymentLogs.map((log) => log.message)
      .join("\n");
    const authDiagnostics = `${output.join("\n")}\n${authMessages}\n${format(failure)}`;
    assert.ok(
      !authDiagnostics.includes("fixture-registry-token"),
      "registry credential leaked through Docker API failure diagnostics",
    );
    assert.match(authMessages, /authorization rejected/);
    assert.match(authMessages, /HTTP 403/);
  },
);
