import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

test("a log consumer failure releases the upstream HTTP reader", async () => {
  let closed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const host = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-sdk-key");
    res.once("close", closed);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: "hello"\n\n');
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const address = host.address();
  assert.ok(address && typeof address !== "string");
  Object.assign(process.env, {
    API_BASE_URL: `http://127.0.0.1:${address.port}`,
    API_KEY: "fixture-sdk-key",
  });
  try {
    const { ControlPanelAPIClient } = await import("../src/client");
    const client = new ControlPanelAPIClient();
    await assert.rejects(
      client.streamRuntimeLogs(7, () => {
        throw new Error("consumer closed");
      }),
      /consumer closed/,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        upstreamClosed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("Upstream reader was not released within 1s")),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
  }
});
