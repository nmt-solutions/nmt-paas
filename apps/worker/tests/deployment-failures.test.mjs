import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { createDeploymentExecutor } from "../src/deployment/execute-deployment.ts";
import { createDockerCommandAdapter } from "../src/deployment/docker-command-adapter.ts";
import {
  deploymentFixture,
  deploymentId,
  userId,
} from "../test/fixtures/deployment.ts";

test(
  "failed attempts and independent cleanup diagnostics survive a PostgreSQL history reload",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Set TEST_DATABASE_URL to a disposable local PostgreSQL server",
  },
  async (t) => {
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const name = `failed_attempts_${randomBytes(6).toString("hex")}`;
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
    const directories = (await readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const directory of directories) {
      await fixtureDb.query(
        await readFile(
          new URL(`${directory}/migration.sql`, migrations),
          "utf8",
        ),
      );
    }
    Object.assign(process.env, {
      DB_ENV: "development",
      DEV_DATABASE_URL: url.href,
      PROD_DATABASE_URL: url.href,
      BASE_DOMAIN: "example.test",
    });
    ({ database } = await import("@repo/database"));
    const schema = await import("@repo/database/schema");
    const {
      getDeployment,
      createDeployment,
      updateDeployment,
      saveDeploymentCleanup,
    } = await import("@repo/database/access-layer/deployment.dal");
    const publicationPersistence =
      await import("@repo/database/access-layer/deployment-publication.dal");
    const { createDeploymentLogs } =
      await import("@repo/database/access-layer/deployment-logs.dal");
    const { getUserApp } = await import("@repo/database/access-layer/apps.dal");
    const [project] = await database
      .insert(schema.Projects)
      .values({ name: "failure-fixture", userId, createdBy: userId })
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

    for (const scenario of [
      {
        name: "builder start",
        options: { failStart: "builder-42" },
        failure: /Prepare builder: .*fixture start rejected/,
      },
      {
        name: "builder preparation",
        options: { failCommand: "apk add --no-cache git docker-cli bash" },
        failure: /Prepare builder failed \(exit code 1\)/,
      },
      {
        name: "installation",
        options: { failCommand: "npm ci" },
        failure: /Install dependencies failed \(exit code 1\)/,
      },
      {
        name: "build",
        options: { failCommand: "npm run build" },
        failure: /Build application failed \(exit code 1\)/,
      },
      {
        name: "runtime start",
        options: { failStart: "deployment-42" },
        failure: /Start application: .*fixture start rejected/,
      },
      {
        name: "preparation with failed builder cleanup",
        options: {
          failCommand: "apk add --no-cache git docker-cli bash",
          failRemove: { "builder-42": "builder removal denied fixture-pat" },
        },
        failure: /Prepare builder failed \(exit code 1\)/,
        cleanup: [
          /Cleanup failed for builder builder-42: .*builder removal denied \[REDACTED\]/,
        ],
        remaining: ["builder-42", "previous", "unrelated"],
      },
      {
        name: "runtime start with partial cleanup",
        options: {
          failStart: "deployment-42",
          failRemove: {
            "deployment-42": "runtime removal denied fixture-pat",
            "fixture-image": "image removal denied fixture-pat",
          },
        },
        failure: /Start application: .*fixture start rejected/,
        cleanup: [
          /Cleanup failed for runtime deployment-42: .*runtime removal denied \[REDACTED\]/,
          /Cleanup failed for image fixture-image: .*image removal denied \[REDACTED\]/,
        ],
        remaining: ["deployment-42", "previous", "unrelated"],
        remainingImages: ["ghcr.io/fixture/42:42"],
      },
    ]) {
      await t.test(scenario.name, async (t) => {
        // Reset only this disposable database's fixture state between attempts.
        await database.delete(schema.DeploymentLogs);
        await database.delete(schema.DeploymentPublications);
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
        const fixture = await deploymentFixture(scenario.options);
        t.after(fixture.close);
        const storage = {
          ...publicationPersistence,
          getDeployment,
          updateDeployment,
          saveDeploymentCleanup,
          createDeploymentLogs,
        };
        const executeDeployment = createDeploymentExecutor({
          ...fixture.dependencies,
          ...storage,
          ...createDockerCommandAdapter({
            ...fixture.dependencies,
            ...storage,
          }),
        });

        await assert.rejects(
          executeDeployment({ userId, deploymentId }),
          scenario.failure,
        );

        // Read through the owner-facing DAL, not a private SQL inspection.
        const history = await getUserApp(7, userId);
        const attempt = history.deployments.find(
          (item) => item.id === deploymentId,
        );
        assert.equal(attempt.status, "failed");
        const messages = attempt.deploymentLogs
          .map((log) => log.message)
          .join("\n");
        assert.match(messages, scenario.failure);
        assert.doesNotMatch(messages, /fixture-pat/);
        if (scenario.cleanup) {
          for (const diagnostic of scenario.cleanup)
            assert.match(messages, diagnostic);
        } else {
          assert.doesNotMatch(messages, /Cleanup failed/);
        }
        assert.deepEqual(
          (await fixture.docker.listContainers({ all: true }))
            .map((container) => container.Id)
            .sort(),
          scenario.remaining ?? ["previous", "unrelated"],
        );
        assert.equal(
          (await fixture.docker.getContainer("previous").inspect()).State
            .Running,
          true,
        );
        assert.deepEqual(
          [...fixture.images.keys()],
          scenario.remainingImages ?? [],
        );
      });
    }
  },
);
