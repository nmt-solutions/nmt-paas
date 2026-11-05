import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { createDeploymentExecutor } from "../src/deployment/execute-deployment.js";
import {
  deploymentFixture,
  deploymentId,
  userId,
} from "./fixtures/deployment.js";

test("execution can be imported without credentials, infrastructure, or a queue consumer", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "test/fixtures/import-execution.ts"],
    {
      cwd: new URL("..", import.meta.url),
      // Keep only the OS paths needed to launch Node/esbuild, never app credentials.
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 10_000,
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "execution imported");
});

test("a production deployment starts its image and replaces only its previous runtime", async (t) => {
  const fixture = await deploymentFixture();
  t.after(fixture.close);
  const executeDeployment = createDeploymentExecutor(fixture.dependencies);

  await executeDeployment({ userId, deploymentId });

  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "success",
  );
  const runtime = await fixture.docker.getContainer("deployment-42").inspect();
  assert.equal(runtime.State.Running, true);
  assert.equal(runtime.Config.Image, "ghcr.io/fixture/42:42");
  assert.equal(runtime.Config.Labels["nmt.app-id"], "7");
  assert.equal(
    runtime.Config.Labels["traefik.http.routers.deployment-42.rule"],
    "Host(`fixture.invalid`)",
  );
  assert.equal(runtime.Config.ExposedPorts["3000/tcp"] !== undefined, true);
  assert.deepEqual(fixture.images.get("ghcr.io/fixture/42:42")?.changes, [
    "WORKDIR /app",
    'CMD ["sh","-c","node dist/server.js"]',
  ]);
  const logText = (await fixture.database.getLogs(deploymentId))
    .map((log) => log.message)
    .join("\n");
  assert.match(
    logText,
    /fixture output: git checkout --detach 1234567890abcdef1234567890abcdef12345678/,
  );
  assert.match(logText, /fixture output: npm ci/);
  assert.match(logText, /fixture output: npm run build/);
  assert.equal(
    (await fixture.database.getLogs(deploymentId)).at(-1)?.message,
    "fixture-app deployed successfully at fixture.invalid.",
  );

  // Cleanup is deliberately background work in the existing success policy.
  for (let attempt = 0; attempt < 100; attempt++) {
    const containers = await fixture.docker.listContainers({ all: true });
    if (containers.length === 2) break;
    await setTimeout(10);
  }
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((container) => container.Id)
      .sort(),
    ["deployment-42", "unrelated"],
  );
});

test("a failed build reports failure for retry and keeps the previous runtime", async (t) => {
  const fixture = await deploymentFixture();
  t.after(fixture.close);
  const failure = new Error("Command failed: sh -c npm run build");
  const runCommand = fixture.dependencies.executeCommand;
  fixture.dependencies.executeCommand = async (...args) => {
    if (args[1][2] === "npm run build") throw failure;
    await runCommand(...args);
  };
  const executeDeployment = createDeploymentExecutor(fixture.dependencies);

  await assert.rejects(
    executeDeployment({ userId, deploymentId }),
    (error) => error === failure,
  );

  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "failed",
  );
  assert.equal(
    (await fixture.database.getLogs(deploymentId)).at(-1)?.message,
    failure.message,
  );
  assert.equal(
    (await fixture.database.getLogs(deploymentId)).at(-1)?.createdBy,
    userId,
  );
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((container) => container.Id)
      .sort(),
    ["previous", "unrelated"],
  );
  assert.equal(
    (await fixture.docker.getContainer("previous").inspect()).State.Running,
    true,
  );
  assert.equal(fixture.images.size, 0);
});

test(
  "the production Docker command adapter reports a nonzero exit through execution",
  { timeout: 10_000 },
  async (t) => {
    const { createDockerCommandAdapter } =
      await import("../src/deployment/docker-command-adapter.js");
    const fixture = await deploymentFixture({ failCommand: "npm run build" });
    t.after(fixture.close);
    const executeDeployment = createDeploymentExecutor({
      ...fixture.dependencies,
      ...createDockerCommandAdapter(fixture.dependencies),
    });

    await assert.rejects(
      executeDeployment({ userId, deploymentId }),
      /Command failed: sh -c npm run build/,
    );

    assert.equal(
      (await fixture.database.getDeployment(deploymentId))?.status,
      "failed",
    );
    assert.equal(
      (await fixture.database.getLogs(deploymentId)).some((log) =>
        log.message.includes("fixture output: npm run build"),
      ),
      true,
    );
    assert.deepEqual(
      (await fixture.docker.listContainers({ all: true }))
        .map((container) => container.Id)
        .sort(),
      ["previous", "unrelated"],
    );
  },
);
