import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
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
    "LABEL nmt.artifact=image",
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
    "Container started for fixture-app at fixture.invalid. Application readiness has not been checked.",
  );

  // Retirement completes before this app's coordination is released.
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

test("a runtime survives unavailable post-start persistence and a fresh executor reconciles it without rebuilding", async (t) => {
  const fixture = await deploymentFixture();
  t.after(fixture.close);
  let unavailable = false;
  const storage = fixture.database;
  const dependencies = {
    ...fixture.dependencies,
    updateDeployment: async (params: { id: number; status: string }) => {
      if (params.status === "success") unavailable = true;
      if (unavailable)
        throw new Error("fixture persistence unavailable fixture-pat");
      await storage.updateDeployment(params);
    },
    createDeploymentLogs: async (
      log: Parameters<typeof storage.createDeploymentLogs>[0],
    ) => {
      if (unavailable)
        throw new Error("fixture persistence unavailable fixture-pat");
      await storage.createDeploymentLogs(log);
    },
  };

  await assert.rejects(
    createDeploymentExecutor(dependencies)({ userId, deploymentId }),
    /Runtime started; recovery pending: fixture persistence unavailable \[REDACTED\]/,
  );
  assert.equal((await storage.getDeployment(deploymentId))?.status, "starting");
  const runtime = await fixture.docker.getContainer("deployment-42").inspect();
  assert.equal(runtime.State.Running, true);
  assert.equal(runtime.Config.Labels["nmt.deployment-id"], "42");
  assert.equal(
    (await fixture.docker.getContainer("previous").inspect()).State.Running,
    true,
  );

  // Simulate worker restart and restored persistence, with repository access gone.
  await createDeploymentExecutor({
    ...fixture.dependencies,
    getCloneUrl: async () => {
      throw new Error("Repository temporarily unavailable");
    },
  })({ userId, deploymentId });

  assert.equal((await storage.getDeployment(deploymentId))?.status, "success");
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((container) => container.Id)
      .sort(),
    ["deployment-42", "unrelated"],
  );
});

test("retry discards an identified partial builder instead of colliding with its name", async (t) => {
  const fixture = await deploymentFixture();
  t.after(fixture.close);
  await fixture.docker.createContainer({
    name: "builder-42",
    Image: "node:22-alpine",
    Labels: { "nmt.deployment-id": "42", "nmt.artifact": "builder" },
  });

  await createDeploymentExecutor(fixture.dependencies)({
    userId,
    deploymentId,
  });

  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "success",
  );
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((container) => container.Id)
      .sort(),
    ["deployment-42", "unrelated"],
  );
});

test("incomplete prior-runtime retirement is visible and retryable without failing or rebuilding the started runtime", async (t) => {
  const failRemove = {
    previous: "previous runtime removal denied fixture-pat",
  };
  const fixture = await deploymentFixture({ failRemove });
  t.after(fixture.close);

  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Runtime started; recovery pending: Artifact cleanup incomplete/,
  );
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "success",
  );
  assert.equal(
    (await fixture.docker.getContainer("deployment-42").inspect()).State
      .Running,
    true,
  );
  const logs = (await fixture.database.getLogs(deploymentId))
    .map((log) => log.message)
    .join("\n");
  assert.match(
    logs,
    /Cleanup failed for prior runtime previous: .*removal denied \[REDACTED\]/,
  );
  assert.doesNotMatch(logs, /fixture-pat/);

  Reflect.deleteProperty(failRemove, "previous");
  await createDeploymentExecutor(fixture.dependencies)({
    userId,
    deploymentId,
  });
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((container) => container.Id)
      .sort(),
    ["deployment-42", "unrelated"],
  );
});

test(
  "same-app replacement waits for retirement while another app proceeds and a failed waiter releases coordination",
  { timeout: 10_000 },
  async (t) => {
    let notifyRetiring!: () => void;
    let releaseRetirement!: () => void;
    const retiring = new Promise<void>((resolve) => {
      notifyRetiring = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    const fixture = await deploymentFixture({
      beforeRemove: async (id) => {
        if (id === "previous") {
          notifyRetiring();
          await release;
        }
      },
    });
    t.after(fixture.close);
    t.after(() => releaseRetirement());
    await fixture.database.createDeployment(43);
    await fixture.database.createDeployment(44, 9);
    await fixture.database.createDeployment(45);
    const dependencies = {
      ...fixture.dependencies,
      getCloneUrl: async (owner: string, repoId: number) => {
        if (owner === "failing-owner")
          throw new Error("fixture repository unavailable");
        return fixture.dependencies.getCloneUrl(owner, repoId);
      },
    };
    const execute = createDeploymentExecutor(dependencies);
    const first = execute({ userId, deploymentId });
    await retiring;
    assert.equal(
      (await fixture.docker.getContainer("deployment-42").inspect()).State
        .Running,
      true,
    );
    const failedWaiter = assert.rejects(
      execute({ userId: "failing-owner", deploymentId: 43 }),
      /fixture repository unavailable/,
    );
    const last = execute({ userId, deploymentId: 45 });

    await execute({ userId, deploymentId: 44 });
    assert.equal((await fixture.database.getDeployment(43))?.status, "queued");
    assert.equal((await fixture.database.getDeployment(45))?.status, "queued");
    assert.equal((await fixture.database.getDeployment(44))?.status, "success");
    await assert.rejects(fixture.docker.getContainer("builder-43").inspect(), {
      statusCode: 404,
    });

    releaseRetirement();
    await Promise.all([first, failedWaiter, last]);
    assert.equal((await fixture.database.getDeployment(43))?.status, "failed");
    assert.equal((await fixture.database.getDeployment(45))?.status, "success");
    assert.deepEqual(
      (await fixture.docker.listContainers({ all: true }))
        .map((container) => container.Id)
        .sort(),
      ["deployment-44", "deployment-45", "unrelated"],
    );
  },
);

test("repeated successful delivery adopts the running runtime and a created owned runtime starts without rebuilding", async (t) => {
  const fixture = await deploymentFixture();
  t.after(fixture.close);
  const runtime = await fixture.docker.createContainer({
    name: "deployment-42",
    Image: "ghcr.io/fixture/42:42",
    Labels: { "nmt.app-id": "7", "nmt.deployment-id": "42" },
  });
  const execute = createDeploymentExecutor({
    ...fixture.dependencies,
    getCloneUrl: async () => {
      throw new Error("Repository temporarily unavailable");
    },
  });
  await Promise.all([
    execute({ userId, deploymentId }),
    execute({ userId, deploymentId }),
  ]);
  assert.equal((await runtime.inspect()).State.Running, true);
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "success",
  );
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((container) => container.Id)
      .sort(),
    ["deployment-42", "unrelated"],
  );
});

test("an existing runtime with a foreign deployment identity is preserved", async (t) => {
  const fixture = await deploymentFixture();
  t.after(fixture.close);
  const runtime = await fixture.docker.createContainer({
    name: "deployment-42",
    Image: "foreign-image",
    Labels: { "nmt.app-id": "8", "nmt.deployment-id": "42" },
  });
  await runtime.start();
  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /unidentified deployment/,
  );
  assert.equal((await runtime.inspect()).Config.Image, "foreign-image");
  assert.equal(
    (await fixture.docker.getContainer("previous").inspect()).State.Running,
    true,
  );
});

test("a delivery resumes its committed image when the worker stopped before runtime creation", async (t) => {
  const fixture = await deploymentFixture();
  t.after(fixture.close);
  const builder = await fixture.docker.createContainer({
    name: "builder-42",
    Image: "node:22-alpine",
    Labels: { "nmt.deployment-id": "42", "nmt.artifact": "builder" },
  });
  await builder.commit({
    repo: "ghcr.io/fixture/42",
    tag: "42",
    changes: ["WORKDIR /app", "LABEL nmt.artifact=image"],
  });
  await builder.remove({ force: true });

  await createDeploymentExecutor({
    ...fixture.dependencies,
    getCloneUrl: async () => {
      throw new Error("Repository temporarily unavailable");
    },
  })({ userId, deploymentId });
  assert.equal(
    (await fixture.docker.getContainer("deployment-42").inspect()).State
      .Running,
    true,
  );
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "success",
  );
});

test("retirement preserves an explicitly different app even when its routing rule overlaps", async (t) => {
  const fixture = await deploymentFixture();
  t.after(fixture.close);
  await fixture.docker.createContainer({
    name: "foreign-route",
    Image: "unrelated-image",
    Labels: {
      "nmt.app-id": "8",
      "traefik.http.routers.deployment-99.rule": "Host(`fixture.invalid`)",
    },
  });
  await createDeploymentExecutor(fixture.dependencies)({
    userId,
    deploymentId,
  });
  assert.equal(
    (await fixture.docker.getContainer("foreign-route").inspect()).Config.Image,
    "unrelated-image",
  );
});
