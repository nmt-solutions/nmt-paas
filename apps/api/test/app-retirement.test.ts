import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import { retirementDockerFixture } from "./fixtures/retirement-docker.js";

test("owner-scoped host cleanup preserves siblings, exposes partial failure, and repeats safely", async (t) => {
  const fixture = await retirementDockerFixture();
  t.after(fixture.close);
  Object.assign(process.env, {
    DOCKER_HOST: fixture.host,
    API_APP_PORT: "0",
    API_KEY: "fixture-retirement-key",
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: "1",
    REDIS_PASSWORD: "fixture-unused",
  });
  const { default: router } = await import("../src/router/v1/apps.router.js");
  const { requireApiAuth } =
    await import("../src/controllers/v1/authentication/auth.js");
  const app = express();
  app.use(express.json());
  app.use("/apps", requireApiAuth, router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/apps/7/retire`;
  const owned = fixture.seed(7, 41);
  fixture.seed(8, 42);
  fixture.failures.add(owned);
  const send = (
    key = "fixture-retirement-key",
    body: unknown = { deploymentIds: [41] },
  ) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  assert.equal((await send("foreign")).status, 401);
  assert.equal((await send(undefined, { deploymentIds: [-1] })).status, 400);
  let result = await (await send()).json();
  assert.equal(result.data.complete, false);
  assert.ok(!JSON.stringify(result).includes("fixture-host-secret"));
  fixture.failures.clear();
  for (let i = 0; i < 2; i++) {
    result = await (await send()).json();
    assert.equal(result.data.complete, true);
  }
  assert.deepEqual(
    (await fixture.docker.listContainers({ all: true })).map((item) => item.Id),
    ["runtime-42"],
  );
  const changed = fixture.seed(7, 51);
  fixture.changedOwnership.add(changed);
  result = await (await send(undefined, { deploymentIds: [51] })).json();
  assert.equal(result.data.complete, false);
  assert.ok(
    (await fixture.docker.listContainers({ all: true })).some(
      (item) => item.Id === changed,
    ),
  );
  fixture.changedOwnership.clear();
  fixture.disappear.add(changed);
  result = await (await send(undefined, { deploymentIds: [51] })).json();
  assert.equal(result.data.complete, true);
  fixture.seed(8, 61);
  result = await (await send(undefined, { deploymentIds: [61] })).json();
  assert.equal(result.data.complete, false);
  assert.ok(
    (await fixture.docker.listContainers({ all: true })).some(
      (item) => item.Id === "runtime-61",
    ),
  );
});
