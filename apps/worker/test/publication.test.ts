import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDeploymentExecutor } from "../src/deployment/execute-deployment.js";
import {
  deploymentFixture,
  deploymentId,
  userId,
} from "./fixtures/deployment.js";

test("registry failure is recorded independently of a started runtime without leaking credentials", async (t) => {
  const fixture = await deploymentFixture({
    pushOutput: () => [
      '{"errorDetail":{"message":"denied fixture-pat"},"error":"denied fixture-pat"}\n',
    ],
  });
  t.after(fixture.close);
  await createDeploymentExecutor(fixture.dependencies)({
    deploymentId,
    userId,
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      (await fixture.database.getPublication(deploymentId, userId))?.status ===
      "failed"
    )
      break;
    await delay(10);
  }
  const publication = await fixture.database.getPublication(
    deploymentId,
    userId,
  );
  assert.equal(publication?.status, "failed");
  assert.equal(publication?.imageId, "fixture-image");
  assert.equal(publication?.imageName, "ghcr.io/fixture/42:42");
  assert.match(publication?.lastError ?? "", /denied \[REDACTED\]/);
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "success",
  );
  assert.equal(
    (await fixture.docker.getContainer("deployment-42").inspect()).State
      .Running,
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(await fixture.database.getLogs(deploymentId)),
    /fixture-pat/,
  );
});

test("a fresh worker republishes the recorded image without replacing a newer runtime", async (t) => {
  let denied = true;
  const fixture = await deploymentFixture({
    pushOutput: () =>
      denied
        ? ['{"error":"registry unavailable"}\n']
        : ['{"status":"42: digest: sha256:1234 size: 123"}\n'],
  });
  t.after(fixture.close);
  const execute = createDeploymentExecutor(fixture.dependencies);
  await execute({ deploymentId, userId });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (await fixture.database.getPublication(deploymentId, userId))?.status ===
      "failed"
    )
      break;
    await delay(10);
  }
  assert.equal(
    (await fixture.database.getPublication(deploymentId, userId))?.status,
    "failed",
  );
  denied = false;
  await fixture.database.createDeployment(43);
  await execute({ deploymentId: 43, userId });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (await fixture.database.getPublication(43, userId))?.status ===
      "published"
    )
      break;
    await delay(10);
  }
  const history = await fixture.database.getLogs(deploymentId);
  const freshWorker = createDeploymentExecutor(fixture.dependencies);
  await freshWorker({ deploymentId, userId, operation: "publish" });
  assert.equal(
    (await fixture.database.getPublication(deploymentId, userId))?.status,
    "published",
  );
  assert.equal(
    (await fixture.database.getPublication(deploymentId, userId))?.lastError,
    null,
  );
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true }))
      .map((c) => c.Id)
      .sort(),
    ["deployment-43", "unrelated"],
  );
  assert.deepEqual(await fixture.database.getLogs(deploymentId), history);
  assert.equal(fixture.images.size, 2);
});

test("registry adapter errors cannot disclose Docker's encoded authentication header", async (t) => {
  let encodedCredentials = "";
  const fixture = await deploymentFixture({
    pushOutput: (authorization) => {
      encodedCredentials = authorization;
      const credentials = JSON.parse(
        Buffer.from(authorization, "base64").toString(),
      );
      assert.equal(credentials.username, "fixture");
      assert.equal(credentials.password, "fixture-pat");
      assert.equal(credentials.serveraddress, "ghcr.io");
      return [`{"error":"rejected header ${authorization}"}\n`];
    },
  });
  t.after(fixture.close);
  await createDeploymentExecutor(fixture.dependencies)({
    deploymentId,
    userId,
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (await fixture.database.getPublication(deploymentId, userId))?.status ===
      "failed"
    )
      break;
    await delay(10);
  }
  assert.ok(encodedCredentials);
  const publication = await fixture.database.getPublication(
    deploymentId,
    userId,
  );
  assert.equal(publication?.status, "failed");
  assert.equal(
    publication?.lastError,
    "Registry publication failed: rejected header [REDACTED]",
  );
});

test("recovery rejects foreign owners and a replaced image tag without changing the runtime", async (t) => {
  const fixture = await deploymentFixture({
    pushOutput: () => ['{"error":"offline"}\n'],
  });
  t.after(fixture.close);
  await createDeploymentExecutor(fixture.dependencies)({
    deploymentId,
    userId,
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (await fixture.database.getPublication(deploymentId, userId))?.status ===
      "failed"
    )
      break;
    await delay(10);
  }
  const fresh = createDeploymentExecutor(fixture.dependencies);
  await assert.rejects(
    fresh({ deploymentId, userId: "foreign", operation: "publish" }),
    /Publication not found/,
  );
  fixture.images.get("ghcr.io/fixture/42:42")!.id = "foreign-image";
  await assert.rejects(
    fresh({ deploymentId, userId, operation: "publish" }),
    /image identity does not match/,
  );
  const publication = await fixture.database.getPublication(
    deploymentId,
    userId,
  );
  assert.equal(publication?.imageId, "fixture-image");
  assert.equal(publication?.status, "failed");
  assert.equal(
    (await fixture.database.getDeployment(deploymentId))?.status,
    "success",
  );
  assert.equal(
    (await fixture.docker.getContainer("deployment-42").inspect()).State
      .Running,
    true,
  );
});

test("publication confirms fragmented manifest output and recovers an interrupted publishing state only once", async (t) => {
  let output = ['{"status":"Pushed"}\n'];
  const fixture = await deploymentFixture({ pushOutput: () => output });
  t.after(fixture.close);
  await createDeploymentExecutor(fixture.dependencies)({
    deploymentId,
    userId,
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (await fixture.database.getPublication(deploymentId, userId))?.status ===
      "failed"
    )
      break;
    await delay(10);
  }
  assert.match(
    (await fixture.database.getPublication(deploymentId, userId))?.lastError ??
      "",
    /without manifest confirmation/,
  );
  // Arrange the durable state left when a worker exits during publication.
  await fixture.database.updatePublication(deploymentId, {
    status: "publishing",
    lastError: null,
  });
  output = ['{"status":"42: dig', 'est: sha256:1234 size: 123"}'];
  const fresh = createDeploymentExecutor(fixture.dependencies);
  await fresh({ deploymentId, userId, operation: "publish" });
  assert.equal(
    (await fixture.database.getPublication(deploymentId, userId))?.status,
    "published",
  );
  output = ['{"error":"must not republish confirmed image"}\n'];
  await fresh({ deploymentId, userId, operation: "publish" });
  assert.equal(
    (await fixture.database.getPublication(deploymentId, userId))?.lastError,
    null,
  );
});
