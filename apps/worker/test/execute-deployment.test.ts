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
  const secret = "fixture-build-token";
  fixture.dependencies.registry.password = secret;
  const failure = Object.assign(new Error(`Build service rejected ${secret}`), {
    cause: new Error(secret),
    request: { password: secret },
    command: `build --token ${secret}`,
  });
  const runCommand = fixture.dependencies.executeCommand;
  fixture.dependencies.executeCommand = async (...args) => {
    if (args[1][2] === "npm run build") throw failure;
    await runCommand(...args);
  };
  const executeDeployment = createDeploymentExecutor(fixture.dependencies);

  await assert.rejects(
    executeDeployment({ userId, deploymentId }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notEqual(error, failure);
      assert.equal(error.message, "Build service rejected [REDACTED]");
      assert.equal("cause" in error, false);
      assert.equal("request" in error, false);
      assert.equal("command" in error, false);
      assert.equal(error.stack?.includes(secret), false);
      return true;
    },
  );

  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "failed",
  );
  assert.equal(
    (await fixture.database.getLogs(deploymentId)).at(-1)?.message,
    "Build service rejected [REDACTED]",
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
      /Build application failed \(exit code 1\)/,
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

test("a subdirectory app installs, builds and starts the recorded revision instead of the branch head", async (t) => {
  const fixture = await deploymentFixture({
    source: {
      rootDirectory: "/app/services/api",
      head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      commits: {
        "1234567890abcdef1234567890abcdef12345678": "recorded-release",
        eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee: "newer-branch-head",
      },
    },
  });
  t.after(fixture.close);
  const deployment = await fixture.database.getDeployment(deploymentId);
  assert.ok(deployment);
  deployment.app.frameworkConfig.rootDirectory = "./services/api";

  await createDeploymentExecutor(fixture.dependencies)({
    userId,
    deploymentId,
  });

  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "success",
  );
  const runtime = await fixture.docker.getContainer("deployment-42").inspect();
  assert.equal(runtime.State.Running, true);
  assert.equal(runtime.Config.WorkingDir, "/app/services/api");
  assert.equal(
    fixture.images.get("ghcr.io/fixture/42:42")?.artifact,
    "recorded-release",
  );
  const output = await fixture.docker
    .getContainer("deployment-42")
    .logs({ stdout: true, stderr: true });
  assert.match(output.toString(), /recorded-release/);
  assert.ok(!output.toString().includes("newer-branch-head"));
});

test("an unavailable recorded commit fails checkout and preserves the previous runtime", async (t) => {
  const fixture = await deploymentFixture({
    source: {
      rootDirectory: "/app",
      head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      commits: { eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee: "branch-head" },
    },
  });
  t.after(fixture.close);

  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Checkout commit failed \(exit code 128\)/,
  );
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "failed",
  );
  const logs = (await fixture.database.getLogs(deploymentId))
    .map((log) => log.message)
    .join("\n");
  assert.match(logs, /recorded commit is not available/);
  assert.ok(!logs.includes("Installing project dependencies"));
  assert.equal(fixture.images.size, 0);
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
});

test("failed builder preparation releases the acquired builder and records the failed attempt", async (t) => {
  const fixture = await deploymentFixture({
    failCommand: "apk add --no-cache git docker-cli bash",
  });
  t.after(fixture.close);

  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Prepare builder failed \(exit code 1\)/,
  );

  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "failed",
  );
  assert.match(
    (await fixture.database.getLogs(deploymentId)).at(-1)!.message,
    /Prepare builder failed \(exit code 1\)/,
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

test("a replacement that cannot start releases its container and image while preserving the previous runtime", async (t) => {
  const fixture = await deploymentFixture({ failStart: "deployment-42" });
  t.after(fixture.close);

  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Start application: .*fixture start rejected/,
  );

  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "failed",
  );
  assert.match(
    (await fixture.database.getLogs(deploymentId)).at(-1)!.message,
    /fixture start rejected/,
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
  assert.equal(
    fixture.images.size,
    0,
    "the failed replacement image must be removed",
  );
});

test("cleanup failures are saved separately without hiding the original start failure or stopping other cleanup", async (t) => {
  const fixture = await deploymentFixture({
    failStart: "deployment-42",
    failRemove: {
      "deployment-42": "container removal denied fixture-pat",
      "fixture-image": "image removal denied fixture-pat",
    },
  });
  t.after(fixture.close);

  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /fixture start rejected/);
      assert.doesNotMatch(error.message, /removal denied|fixture-pat/);
      return true;
    },
  );

  const logs = (await fixture.database.getLogs(deploymentId))
    .map((log) => log.message)
    .join("\n");
  assert.match(
    logs,
    /Cleanup failed for runtime .*container removal denied \[REDACTED\]/,
  );
  assert.match(
    logs,
    /Cleanup failed for image .*image removal denied \[REDACTED\]/,
  );
  assert.doesNotMatch(logs, /fixture-pat/);
  assert.match(
    (await fixture.database.getLogs(deploymentId)).at(-1)!.message,
    /fixture start rejected/,
  );
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "failed",
  );
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((container) => container.Id)
      .sort(),
    ["deployment-42", "previous", "unrelated"],
  );
  assert.equal(
    (await fixture.docker.getContainer("previous").inspect()).State.Running,
    true,
  );
  assert.equal(fixture.images.size, 1);
});

test("a builder that cannot start records a preparation failure and releases the acquired container", async (t) => {
  const fixture = await deploymentFixture({ failStart: "builder-42" });
  t.after(fixture.close);

  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Prepare builder: .*fixture start rejected/,
  );
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "failed",
  );
  assert.match(
    (await fixture.database.getLogs(deploymentId)).at(-1)!.message,
    /Prepare builder: .*fixture start rejected/,
  );
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((container) => container.Id)
      .sort(),
    ["previous", "unrelated"],
  );
});

test("an already absent builder counts as cleaned up without adding a cleanup failure", async (t) => {
  const fixture = await deploymentFixture({
    failStart: "builder-42",
    disappearOnRemove: ["builder-42"],
  });
  t.after(fixture.close);
  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Prepare builder/,
  );
  const logs = (await fixture.database.getLogs(deploymentId))
    .map((log) => log.message)
    .join("\n");
  assert.doesNotMatch(logs, /Cleanup failed/);
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((container) => container.Id)
      .sort(),
    ["previous", "unrelated"],
  );
});

for (const scenario of [
  {
    name: "base image pull",
    options: { failPull: true },
    diagnostic: /Prepare builder: .*fixture pull rejected/,
  },
  {
    name: "builder creation",
    options: { failCreate: "builder-42" },
    diagnostic: /Prepare builder: .*fixture create rejected/,
  },
  {
    name: "installation",
    options: { failCommand: "npm ci" },
    diagnostic: /Install dependencies failed \(exit code 1\)/,
  },
  {
    name: "image commit",
    options: { failCommit: true },
    diagnostic: /fixture commit rejected/,
  },
  {
    name: "runtime creation",
    options: { failCreate: "deployment-42" },
    diagnostic: /fixture create rejected/,
  },
]) {
  test(`a failed ${scenario.name} preserves unrelated resources and records a failed attempt`, async (t) => {
    const fixture = await deploymentFixture(scenario.options);
    t.after(fixture.close);
    // A committed image belonging to another app must survive every failure.
    fixture.images.set("ghcr.io/other/runtime:stable", {
      id: "unrelated-image",
      changes: [],
    });
    await assert.rejects(
      createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
      scenario.diagnostic,
    );
    assert.equal(
      (await fixture.database.getDeployment(deploymentId))?.status,
      "failed",
    );
    assert.match(
      (await fixture.database.getLogs(deploymentId)).at(-1)!.message,
      scenario.diagnostic,
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
    assert.deepEqual(
      [...fixture.images.keys()],
      ["ghcr.io/other/runtime:stable"],
    );
  });
}

test("builder acquisition conflict preserves the container this attempt did not create", async (t) => {
  const fixture = await deploymentFixture();
  t.after(fixture.close);
  await fixture.docker.createContainer({
    name: "builder-42",
    Image: "another-image",
  });

  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Prepare builder: .*Container name already in use/,
  );

  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "failed",
  );
  assert.equal(
    (await fixture.docker.getContainer("builder-42").inspect()).Config.Image,
    "another-image",
  );
  assert.equal(
    (await fixture.docker.getContainer("previous").inspect()).State.Running,
    true,
  );
});

test("failed builder cleanup is visible alongside the preparation failure", async (t) => {
  const fixture = await deploymentFixture({
    failCommand: "apk add --no-cache git docker-cli bash",
    failRemove: { "builder-42": "builder removal denied fixture-pat" },
  });
  t.after(fixture.close);
  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Prepare builder failed \(exit code 1\)/,
  );
  const logs = (await fixture.database.getLogs(deploymentId))
    .map((log) => log.message)
    .join("\n");
  assert.match(
    logs,
    /Cleanup failed for builder builder-42: .*builder removal denied \[REDACTED\]/,
  );
  assert.match(logs, /Prepare builder failed \(exit code 1\)/);
  assert.doesNotMatch(logs, /fixture-pat/);
  assert.equal(
    (await fixture.docker.getContainer("builder-42").inspect()).State.Running,
    true,
  );
});

test("failed-image cleanup preserves another app's tag when Docker reports shared image ownership", async (t) => {
  const fixture = await deploymentFixture({ failStart: "deployment-42" });
  t.after(fixture.close);
  fixture.images.set("ghcr.io/other/runtime:stable", {
    id: "fixture-image",
    changes: [],
  });

  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Start application/,
  );

  assert.deepEqual([...fixture.images.keys()].sort(), [
    "ghcr.io/fixture/42:42",
    "ghcr.io/other/runtime:stable",
  ]);
  const logs = (await fixture.database.getLogs(deploymentId))
    .map((log) => log.message)
    .join("\n");
  assert.match(
    logs,
    /Cleanup failed for image fixture-image: .*Image referenced by multiple repositories/,
  );
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "failed",
  );
  assert.equal(
    (await fixture.docker.getContainer("previous").inspect()).State.Running,
    true,
  );
});

test("a credential-removal failure prevents image commit and preserves the previous runtime", async (t) => {
  const fixture = await deploymentFixture({
    failCommand: "rm -rf -- /app/.git",
  });
  t.after(fixture.close);

  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Remove build credentials failed \(exit code 1\)/,
  );

  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "failed",
  );
  assert.equal(fixture.images.size, 0);
  assert.match(
    (await fixture.database.getLogs(deploymentId)).at(-1)?.message ?? "",
    /Remove build credentials failed/,
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
});
