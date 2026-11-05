import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeploymentExecutor } from "../src/deployment/execute-deployment.js";
import {
  deploymentFixture,
  deploymentId,
  userId,
} from "./fixtures/deployment.js";

test("cleanup-only recovery survives restart, resolves partial removal, and preserves start success", async (t) => {
  const failRemove = {
    previous: "removal denied fixture-pat",
    "builder-42": "builder busy",
  };
  const fixture = await deploymentFixture({ failRemove });
  t.after(fixture.close);
  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /cleanup incomplete/,
  );
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "success",
  );
  const restarted = createDeploymentExecutor({
    ...fixture.dependencies,
    getCloneUrl: async () => {
      throw new Error("Cleanup must not clone");
    },
    fetchEnvVars: async () => {
      throw new Error("Cleanup must not load build configuration");
    },
  });
  Reflect.deleteProperty(failRemove, "builder-42");
  const partial = await restarted({ userId, deploymentId, action: "cleanup" });
  assert.equal(partial?.status, "pending");
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((c) => c.Id)
      .sort(),
    ["deployment-42", "previous", "unrelated"],
  );
  Reflect.deleteProperty(failRemove, "previous");
  const recovered = await restarted({
    userId,
    deploymentId,
    action: "cleanup",
  });
  assert.equal(recovered?.status, "complete");
  assert.deepEqual(
    await restarted({ userId, deploymentId, action: "cleanup" }),
    recovered,
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
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((c) => c.Id)
      .sort(),
    ["deployment-42", "unrelated"],
  );
  const logs = (await fixture.database.getLogs(deploymentId))
    .map((l) => l.message)
    .join("\n");
  assert.match(logs, /Cleanup complete/);
  assert.doesNotMatch(logs, /fixture-pat/);
});

test("recovery treats a removal completed before a lost database acknowledgement as absent", async (t) => {
  const failRemove = { "builder-42": "busy" };
  const fixture = await deploymentFixture({
    failCommand: "npm run build",
    failRemove,
  });
  t.after(fixture.close);
  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Build application/,
  );
  await fixture.docker
    .getContainer("builder-42")
    .remove({ force: true })
    .catch(() => {});
  Reflect.deleteProperty(failRemove, "builder-42");
  await fixture.docker.getContainer("builder-42").remove({ force: true });
  const result = await createDeploymentExecutor(fixture.dependencies)({
    userId,
    deploymentId,
    action: "cleanup",
  });
  assert.equal(result?.status, "complete");
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "failed",
  );
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((c) => c.Id)
      .sort(),
    ["previous", "unrelated"],
  );
});

test("retry adoption cancels failed-runtime and image removal while preserving the running replacement", async (t) => {
  const failRemove = { "deployment-42": "busy", "fixture-image": "busy" };
  const fixture = await deploymentFixture({
    failStart: "deployment-42",
    failRemove,
  });
  t.after(fixture.close);
  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /Start application/,
  );
  fixture.restoreStart();
  Reflect.deleteProperty(failRemove, "deployment-42");
  Reflect.deleteProperty(failRemove, "fixture-image");
  await createDeploymentExecutor({
    ...fixture.dependencies,
    getCloneUrl: async () => {
      throw new Error("Must adopt");
    },
  })({ userId, deploymentId });
  const result = await createDeploymentExecutor(fixture.dependencies)({
    userId,
    deploymentId,
    action: "cleanup",
  });
  assert.equal(result?.status, "complete");
  assert.equal(
    result?.artifacts.find((a) => a.kind === "runtime")?.status,
    "preserved",
  );
  assert.equal(
    result?.artifacts.find((a) => a.kind === "image")?.status,
    "preserved",
  );
  assert.equal(
    (await fixture.docker.getContainer("deployment-42").inspect()).State
      .Running,
    true,
  );
  assert.equal(
    (await fixture.docker.getImage("ghcr.io/fixture/42:42").inspect()).Id,
    "fixture-image",
  );
});

test("recovery refuses changed ownership and does not remove a prior runtime without its running replacement", async (t) => {
  const failRemove = { previous: "busy", "builder-42": "busy" };
  const fixture = await deploymentFixture({ failRemove });
  t.after(fixture.close);
  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({ userId, deploymentId }),
    /cleanup incomplete/,
  );
  Reflect.deleteProperty(failRemove, "builder-42");
  Reflect.deleteProperty(failRemove, "previous");
  // External host changes after the recorded failure. The HTTP fixture uses
  // readable IDs; production Docker IDs cannot be reused this way.
  await fixture.docker.getContainer("builder-42").remove({ force: true });
  await fixture.docker.createContainer({
    name: "builder-42",
    Image: "foreign-image",
    Labels: { "nmt.deployment-id": "99", "nmt.artifact": "builder" },
  });
  await fixture.docker.getContainer("deployment-42").remove({ force: true });
  const result = await createDeploymentExecutor(fixture.dependencies)({
    userId,
    deploymentId,
    action: "cleanup",
  });
  assert.equal(result?.status, "pending");
  assert.match(
    result?.artifacts.find((a) => a.kind === "builder")?.error ?? "",
    /ownership/,
  );
  assert.equal(
    (await fixture.docker.getContainer("builder-42").inspect()).Config.Image,
    "foreign-image",
  );
  assert.equal(
    (await fixture.docker.getContainer("previous").inspect()).State.Running,
    true,
  );
  assert.equal(
    (await fixture.docker.getContainer("unrelated").inspect()).State.Running,
    true,
  );
});

test("cleanup read failure and foreign owner leave the runtime-start outcome untouched", async (t) => {
  const fixture = await deploymentFixture();
  t.after(fixture.close);
  await createDeploymentExecutor(fixture.dependencies)({
    userId,
    deploymentId,
  });
  const history = await fixture.database.getLogs(deploymentId);
  const recover = createDeploymentExecutor({
    ...fixture.dependencies,
    getDeployment: async () => {
      throw new Error("cleanup storage unavailable fixture-pat");
    },
  });
  await assert.rejects(
    recover({ userId, deploymentId, action: "cleanup" }),
    /storage unavailable \[REDACTED\]/,
  );
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "success",
  );
  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({
      userId: "foreign-owner",
      deploymentId,
      action: "cleanup",
    }),
    /not found/,
  );
  assert.deepEqual(await fixture.database.getLogs(deploymentId), history);
});

test("cleanup with no durable intent does not claim untracked resources were removed", async (t) => {
  const fixture = await deploymentFixture();
  t.after(fixture.close);
  await assert.rejects(
    createDeploymentExecutor(fixture.dependencies)({
      userId,
      deploymentId,
      action: "cleanup",
    }),
    /No recorded cleanup/,
  );
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "queued",
  );
  assert.deepEqual(await fixture.database.getLogs(deploymentId), []);
  assert.equal(
    (await fixture.docker.getContainer("previous").inspect()).State.Running,
    true,
  );
});
