import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import process from "node:process";
import test, { mock } from "node:test";
import { URL } from "node:url";
import pg from "pg";

test(
  "repository execution uses persisted context through the production GitHub adapter",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Set TEST_DATABASE_URL to a disposable local PostgreSQL server",
  },
  async (t) => {
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const name = `repository_${crypto.randomBytes(6).toString("hex")}`;
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
    let repositoryDenied = false;
    let installationUnavailable = false;
    mock.module("octokit", {
      namedExports: {
        App: class {
          async getInstallationOctokit(installationId) {
            assert.equal(installationId, 81);
            if (installationUnavailable) throw new Error("Not Found");
            return {
              request: async (route, parameters) => {
                if (route === "GET /app/installations/{installation_id}") {
                  return { data: { account: { login: "previous-owner" } } };
                }
                if (
                  route === "GET /repositories/{repository_id}" &&
                  parameters.repository_id === 123
                ) {
                  if (repositoryDenied) {
                    throw Object.assign(new Error("Not Found"), {
                      status: 404,
                      request: { token: "fixture-clone-token" },
                    });
                  }
                  return {
                    data: {
                      id: 123,
                      clone_url:
                        "https://github.com/moved-org/renamed-repository.git",
                    },
                  };
                }
                throw new Error(
                  "Repository is not accessible to this installation",
                );
              },
              auth: async () => ({ token: "fixture-clone-token" }),
            };
          }
        },
      },
    });
    ({ database } = await import("@repo/database"));
    const schema = await import("@repo/database/schema");
    const { getUserApp, updateApp } =
      await import("@repo/database/access-layer/apps.dal");
    const { getDeployment, updateDeployment } =
      await import("@repo/database/access-layer/deployment.dal");
    const { createDeploymentLogs } =
      await import("@repo/database/access-layer/deployment-logs.dal");
    const { getCloneUrl } = await import("../src/services/github.ts");
    const { createDeploymentExecutor } =
      await import("../src/deployment/execute-deployment.ts");
    const { createDockerCommandAdapter } =
      await import("../src/deployment/docker-command-adapter.ts");
    const { deploymentFixture } =
      await import("../test/fixtures/deployment.ts");
    const userId = "fixture-owner";
    const [project] = await database
      .insert(schema.Projects)
      .values({
        name: "repository fixture",
        userId,
        createdBy: userId,
      })
      .returning();
    const [app] = await database
      .insert(schema.Apps)
      .values({
        appName: "old-app-name",
        projectId: project.id,
        gitProvider: "github",
        repoId: 123,
        createdBy: userId,
      })
      .returning();
    await database.insert(schema.AppDomains).values({
      appId: app.id,
      domain: "repository.example.test",
      env: "production",
      userId,
      createdBy: userId,
    });
    await database.insert(schema.FrameworkConfig).values({
      appId: app.id,
      framework: "node",
      rootDirectory: "./",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      startCommand: "node dist/server.js",
      outputDirectory: "dist",
      port: 3000,
      createdBy: userId,
    });
    await database.insert(schema.GithubAppInstallations).values({
      installationId: 81,
      userId,
      createdBy: userId,
    });
    const createRecordedDeployment = async () => {
      const [deployment] = await database
        .insert(schema.Deployments)
        .values({
          appId: app.id,
          repoId: 123,
          branch: "release",
          commit: "1234567890abcdef1234567890abcdef12345678",
          env: "production",
          userId,
          createdBy: userId,
        })
        .returning();
      return deployment;
    };

    await t.test(
      "app and repository renames retain access to the recorded repository",
      async (t) => {
        const deployment = await createRecordedDeployment();
        await updateApp(app.id, userId, { appName: "renamed-app" });
        const fixture = await deploymentFixture({
          source: {
            cloneUrl: "https://github.com/moved-org/renamed-repository.git",
            rootDirectory: "/app",
            head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            commits: {
              "1234567890abcdef1234567890abcdef12345678": "recorded-release",
              eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee: "newer-branch-head",
            },
          },
        });
        t.after(fixture.close);
        const dependencies = {
          ...fixture.dependencies,
          getDeployment,
          updateDeployment,
          createDeploymentLogs,
          getCloneUrl,
        };
        const execute = createDeploymentExecutor({
          ...dependencies,
          ...createDockerCommandAdapter(dependencies),
        });
        await execute({ userId, deploymentId: deployment.id });
        const view = await getUserApp(app.id, userId);
        assert.equal(view.deployments[0].status, "success");
        const logs = view.deployments[0].deploymentLogs
          .map((log) => log.message)
          .join("\n");
        assert.match(logs, /github.com\/moved-org\/renamed-repository.git/);
        assert.match(
          logs,
          /Container started for renamed-app at repository\.example\.test\. Application readiness has not been checked\./,
        );
        assert.ok(!logs.includes("fixture-clone-token"));
      },
    );

    await t.test(
      "denied repository access fails the attempt with a useful persisted diagnostic",
      async (t) => {
        const deployment = await createRecordedDeployment();
        repositoryDenied = true;
        const fixture = await deploymentFixture();
        t.after(fixture.close);
        const dependencies = {
          ...fixture.dependencies,
          getDeployment,
          updateDeployment,
          createDeploymentLogs,
          getCloneUrl,
        };
        await assert.rejects(
          createDeploymentExecutor(dependencies)({
            userId,
            deploymentId: deployment.id,
          }),
          /Unable to access GitHub repository 123.*installation/,
        );
        const view = await getUserApp(app.id, userId);
        assert.equal(view.deployments[0].status, "failed");
        const logs = view.deployments[0].deploymentLogs
          .map((log) => log.message)
          .join("\n");
        assert.match(
          logs,
          /Unable to access GitHub repository 123.*installation/,
        );
        assert.ok(!logs.includes("fixture-clone-token"));
        assert.deepEqual(
          (await fixture.docker.listContainers({ all: true }))
            .map((container) => container.Id)
            .sort(),
          ["previous", "unrelated"],
        );
        assert.equal(
          (await fixture.docker.getContainer("previous").inspect()).State
            .Running,
          true,
        );
      },
    );

    await t.test(
      "a removed GitHub installation reports how to reconnect",
      async (t) => {
        const deployment = await createRecordedDeployment();
        installationUnavailable = true;
        const fixture = await deploymentFixture();
        t.after(fixture.close);
        await assert.rejects(
          createDeploymentExecutor({
            ...fixture.dependencies,
            getDeployment,
            updateDeployment,
            createDeploymentLogs,
            getCloneUrl,
          })({ userId, deploymentId: deployment.id }),
          /GitHub installation unavailable.*[Rr]econnect/,
        );
        const view = await getUserApp(app.id, userId);
        assert.equal(view.deployments[0].status, "failed");
        assert.match(
          view.deployments[0].deploymentLogs.at(-1).message,
          /GitHub installation unavailable.*[Rr]econnect/,
        );
        assert.deepEqual(
          (await fixture.docker.listContainers({ all: true }))
            .map((container) => container.Id)
            .sort(),
          ["previous", "unrelated"],
        );
      },
    );

    await t.test(
      "a missing owner installation fails without using another owner's connection",
      async (t) => {
        const deployment = await createRecordedDeployment();
        await database
          .update(schema.GithubAppInstallations)
          .set({ resourceStatus: "inactive" });
        await database.insert(schema.GithubAppInstallations).values({
          installationId: 99,
          userId: "another-owner",
          createdBy: "another-owner",
        });
        const fixture = await deploymentFixture();
        t.after(fixture.close);
        await assert.rejects(
          createDeploymentExecutor({
            ...fixture.dependencies,
            getDeployment,
            updateDeployment,
            createDeploymentLogs,
            getCloneUrl,
          })({ userId, deploymentId: deployment.id }),
          /GitHub installation not found.*[Cc]onnect/,
        );
        const view = await getUserApp(app.id, userId);
        assert.equal(view.deployments[0].status, "failed");
        assert.match(
          view.deployments[0].deploymentLogs.at(-1).message,
          /GitHub installation not found.*[Cc]onnect/,
        );
        assert.deepEqual(
          (await fixture.docker.listContainers({ all: true }))
            .map((container) => container.Id)
            .sort(),
          ["previous", "unrelated"],
        );
      },
    );
  },
);
