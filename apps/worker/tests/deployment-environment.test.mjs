import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { format } from "node:util";
import { setTimeout } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";

// Same persisted wire format as the web writer, using fixture credentials only.
function savedValue(value) {
  const iv = Buffer.alloc(12, 16);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from("11".repeat(32), "hex"),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64"))
    .join(":");
}

test(
  "saved configuration reaches the subdirectory runtime after image credentials are removed",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Set TEST_DATABASE_URL to a disposable local PostgreSQL server",
  },
  async (t) => {
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const name = `environment_${crypto.randomBytes(6).toString("hex")}`;
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
      if (!/^\d+_/.test(directory)) continue;
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
    });
    ({ database } = await import("@repo/database"));
    const schema = await import("@repo/database/schema");
    const { fetchEnvVars } = await import("../src/services/env-vars.ts");
    const { createDeploymentExecutor } =
      await import("../src/deployment/execute-deployment.ts");
    const { deploymentFixture, deploymentId, userId } =
      await import("../test/fixtures/deployment.ts");
    const [project] = await database
      .insert(schema.Projects)
      .values({ name: "environment fixture", userId, createdBy: userId })
      .returning();

    const values = {
      INSTALL_TOKEN: "fixture-install-token",
      PUBLIC_GREETING: "hello-from-production",
      APP_SECRET:
        "fixture-runtime-secret=$HOME \"quoted\" 'literal' `uname` $(touch /app/should-not-exist)\nEOF\nfixture-second-line",
      EMPTY_VALUE: "",
    };
    await database.insert(schema.EnvVars).values([
      ...Object.entries(values).map(([key, value]) => ({
        projectId: project.id,
        env: "production",
        key,
        encryptedValue: savedValue(value),
        createdBy: userId,
      })),
      ...Object.entries({
        INSTALL_TOKEN: "fixture-preview-install",
        PUBLIC_GREETING: "hello-from-preview",
        APP_SECRET: "fixture-preview-runtime",
      }).map(([key, value]) => ({
        projectId: project.id,
        env: "preview",
        key,
        encryptedValue: savedValue(value),
        createdBy: userId,
      })),
      {
        projectId: project.id,
        env: "preview",
        key: "PREVIEW_ONLY",
        encryptedValue: savedValue("fixture-preview-value"),
        createdBy: userId,
      },
      {
        projectId: project.id,
        env: "production",
        key: "INACTIVE_ONLY",
        encryptedValue: savedValue("fixture-inactive-value"),
        resourceStatus: "inactive",
        createdBy: userId,
      },
    ]);
    const fixture = await deploymentFixture({
      source: {
        rootDirectory: "/app/services/api",
        head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        commits: {
          "1234567890abcdef1234567890abcdef12345678": "recorded-release",
          eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee: "branch-head",
        },
        environmentKeys: {
          install: "INSTALL_TOKEN",
          build: "PUBLIC_GREETING",
          runtime: "APP_SECRET",
        },
        files: {
          "/app/services/api/package.json": '{"name":"fixture-app"}',
          "/app/services/api/.env.example": "APP_SECRET=example-only",
          "/app/README.md": "fixture source",
        },
      },
    });
    t.after(fixture.close);
    const deployment = await fixture.database.getDeployment(deploymentId);
    deployment.app.projectId = project.id;
    deployment.app.frameworkConfig.rootDirectory = "./services/api";
    fixture.dependencies.getCloneUrl = async () =>
      "https://x-access-token:fixture-clone-token@fixture.invalid/repo.git";
    const output = [];
    t.mock.method(console, "log", (...args) => output.push(format(...args)));
    t.mock.method(console, "error", (...args) => output.push(format(...args)));
    t.mock.method(process.stdout, "write", (chunk) => {
      output.push(String(chunk));
      return true;
    });

    await createDeploymentExecutor({ ...fixture.dependencies, fetchEnvVars })({
      userId,
      deploymentId,
    });

    const container = fixture.docker.getContainer("deployment-42");
    const runtime = await container.inspect();
    assert.equal(runtime.State.Running, true);
    assert.equal(runtime.Config.WorkingDir, "/app/services/api");
    assert.deepEqual(runtime.Config.Env?.slice().sort(), [
      `APP_SECRET=${values.APP_SECRET}`,
      "EMPTY_VALUE=",
      "INSTALL_TOKEN=fixture-install-token",
      "PUBLIC_GREETING=hello-from-production",
    ]);
    // Docker framing precedes the fixture application's JSON response.
    const response = await container.logs({ stdout: true, stderr: true });
    assert.deepEqual(JSON.parse(response.subarray(8).toString()), {
      release: "recorded-release",
      publicAsset: "hello-from-production",
      runtimeValue: values.APP_SECRET,
    });
    const image = fixture.images.get("ghcr.io/fixture/42:42");
    assert.ok(image);
    assert.deepEqual(Object.keys(image.files).sort(), [
      "/app/README.md",
      "/app/services/api/.env.example",
      "/app/services/api/dist/public.txt",
      "/app/services/api/dist/server.js",
      "/app/services/api/node_modules/fixture-dependency/index.js",
      "/app/services/api/package.json",
    ]);
    assert.equal(
      image.files["/app/services/api/dist/public.txt"],
      "hello-from-production",
    );
    assert.equal(
      image.files["/app/services/api/dist/server.js"],
      "// release: recorded-release",
    );
    assert.deepEqual(image.environment, []);
    for (const secret of [
      values.INSTALL_TOKEN,
      values.APP_SECRET,
      "fixture-clone-token",
    ]) {
      assert.ok(
        !JSON.stringify(image).includes(secret),
        "avoidable image credential retained",
      );
    }
    // Background runtime output must pass through the same diagnostic scope.
    let logs;
    for (let attempt = 0; attempt < 100; attempt++) {
      logs = (await fixture.database.getLogs(deploymentId))
        .map((log) => log.message)
        .join("\n");
      if (logs.includes('"runtimeValue"')) break;
      await setTimeout(10);
    }
    assert.match(logs, /"runtimeValue":"\[REDACTED\]"/);
    const diagnostics = `${output.join("\n")}\n${logs}`;
    for (const secret of [
      ...Object.values(values).flatMap((value) => value.split("\n")),
      "fixture-clone-token",
    ]) {
      if (!secret) continue;
      assert.ok(
        !diagnostics.includes(secret),
        `fixture value leaked in diagnostics: ${secret}`,
      );
    }

    // Fresh recovery uses the real encrypted-value adapter without rebuilding.
    const recoveryDependencies = {
      ...fixture.dependencies,
      fetchEnvVars,
      getCloneUrl: async () => {
        throw new Error("Recovery must not clone");
      },
      createBuilderContainer: async () => {
        throw new Error("Recovery must not build");
      },
    };
    const recoveryOffset = (await fixture.database.getLogs(deploymentId))
      .length;
    await createDeploymentExecutor(recoveryDependencies)({
      userId,
      deploymentId,
    });
    let recoveryLogs = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      recoveryLogs = (await fixture.database.getLogs(deploymentId))
        .slice(recoveryOffset)
        .map((log) => log.message)
        .join("\n");
      if (recoveryLogs.includes('"runtimeValue"')) break;
      await setTimeout(10);
    }
    assert.match(recoveryLogs, /"runtimeValue":"\[REDACTED\]"/);
    assert.ok(!recoveryLogs.includes(values.APP_SECRET));
    assert.equal(fixture.images.get("ghcr.io/fixture/42:42"), image);
    await container.remove({ force: true });
    await createDeploymentExecutor(recoveryDependencies)({
      userId,
      deploymentId,
    });
    assert.deepEqual(
      (await fixture.docker.getContainer("deployment-42").inspect()).Config.Env,
      runtime.Config.Env,
    );
    assert.equal(fixture.images.get("ghcr.io/fixture/42:42"), image);

    // A second deployment selects preview configuration at the repository root.
    const preview = await deploymentFixture({
      source: {
        rootDirectory: "/app",
        head: "1234567890abcdef1234567890abcdef12345678",
        commits: {
          "1234567890abcdef1234567890abcdef12345678": "preview-release",
        },
        environmentKeys: {
          install: "INSTALL_TOKEN",
          build: "PUBLIC_GREETING",
          runtime: "APP_SECRET",
        },
      },
    });
    t.after(preview.close);
    const previewDeployment =
      await preview.database.getDeployment(deploymentId);
    previewDeployment.app.projectId = project.id;
    previewDeployment.env = "preview";
    previewDeployment.app.appDomains[0].env = "preview";
    await createDeploymentExecutor({ ...preview.dependencies, fetchEnvVars })({
      userId,
      deploymentId,
    });
    const previewContainer = preview.docker.getContainer("deployment-42");
    const previewRuntime = await previewContainer.inspect();
    assert.equal(previewRuntime.Config.WorkingDir, "/app");
    assert.deepEqual(previewRuntime.Config.Env.slice().sort(), [
      "APP_SECRET=fixture-preview-runtime",
      "INSTALL_TOKEN=fixture-preview-install",
      "PREVIEW_ONLY=fixture-preview-value",
      "PUBLIC_GREETING=hello-from-preview",
    ]);
    const previewResponse = await previewContainer.logs({
      stdout: true,
      stderr: true,
    });
    assert.deepEqual(JSON.parse(previewResponse.subarray(8).toString()), {
      release: "preview-release",
      publicAsset: "hello-from-preview",
      runtimeValue: "fixture-preview-runtime",
    });
  },
);
