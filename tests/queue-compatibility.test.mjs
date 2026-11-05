import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHTTPServer } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Queue, UnrecoverableError, Worker } from "bullmq";

const root = fileURLToPath(new URL("../", import.meta.url));
const password = "queue-compatibility-fixture";
const children = [];
const producers = [];
const kinds = (process.env.QUEUE_TEST_PRODUCERS || "Go,Express").split(",");
assert.ok(
  kinds.length > 0 && kinds.every((kind) => ["Go", "Express"].includes(kind)),
);
let directory;
let queue;
let connection;

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  child.output = "";
  child.on("error", (error) => {
    child.launchError = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      child.output = (child.output + chunk).slice(-8000);
    });
  }
  children.push(child);
  return child;
}

async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
}

async function startProducer(kind, redisPort) {
  const apiPort = await port();
  const env = {
    ...process.env,
    DOTENV_CONFIG_PATH: join(directory, "no-env-file"),
    API_APP_PORT: String(apiPort),
    API_KEY: password,
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: String(redisPort),
    REDIS_PASSWORD: password,
    GIN_MODE: "release",
    NODE_ENV: "test",
  };
  const child =
    kind === "Go"
      ? run(
          join(
            directory,
            process.platform === "win32" ? "node-manager.exe" : "node-manager",
          ),
          [],
          { env, cwd: directory },
        )
      : run(process.execPath, ["--import", "tsx", "apps/api/src/index.ts"], {
          env,
        });
  const base = `http://127.0.0.1:${apiPort}/api/v1`;
  await until(async () => {
    assert.ifError(child.launchError);
    assert.equal(child.exitCode, null, `${kind} exited: ${child.output}`);
    return fetch(`${base}/health`, { signal: AbortSignal.timeout(300) })
      .then((response) => response.ok)
      .catch(() => false);
  }, `${kind} did not start: ${child.output}`);
  return { kind, base, child };
}

async function submit(producer, body, authorization = `Bearer ${password}`) {
  const response = await fetch(`${producer.base}/deployments/queue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization === null ? {} : { Authorization: authorization }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.launchError)
    return;
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function consume(processor, exercise) {
  // The installed consumer and queue identity/options match apps/worker.
  // Only the processor changes: this suite never starts Docker deployments.
  const worker = new Worker("deployment-queue", processor, {
    connection,
    concurrency: 5,
  });
  const errors = [];
  worker.on("error", (error) => errors.push(error));
  try {
    await worker.waitUntilReady();
    await exercise(worker);
    assert.deepEqual(errors, []);
  } finally {
    await worker.close(true);
  }
}

describe(
  `host queue compatibility [${kinds.join(" + ")}]`,
  { concurrency: false },
  () => {
    before(
      async () => {
        directory = await mkdtemp(join(tmpdir(), "nmt-queue-contract-"));
        const go = run(
          process.env.GO_BIN || "go",
          [
            "build",
            "-o",
            join(
              directory,
              process.platform === "win32"
                ? "node-manager.exe"
                : "node-manager",
            ),
            ".",
          ],
          {
            cwd: join(root, "apps/node-manager"),
          },
        );
        await until(
          () => {
            assert.ifError(go.launchError);
            return go.exitCode !== null;
          },
          "Go build timed out",
          180000,
        );
        assert.equal(go.exitCode, 0, go.output);
        const redisPort = await port();
        const redis = run(
          process.env.REDIS_SERVER_BIN || "redis-server",
          [
            "--bind",
            "127.0.0.1",
            "--port",
            String(redisPort),
            "--requirepass",
            password,
            "--save",
            "",
            "--appendonly",
            "no",
            "--dir",
            ".",
          ],
          { cwd: directory },
        );
        await until(
          () =>
            new Promise((done) => {
              assert.ifError(redis.launchError);
              assert.equal(redis.exitCode, null, redis.output);
              const socket = connect(redisPort, "127.0.0.1");
              const finish = (ready) => {
                socket.destroy();
                done(ready);
              };
              socket.once("connect", () => finish(true));
              socket.once("error", () => finish(false));
              socket.setTimeout(300, () => finish(false));
            }),
          "Disposable Redis did not listen",
        );
        connection = {
          host: "127.0.0.1",
          port: redisPort,
          password,
          maxRetriesPerRequest: null,
        };
        queue = new Queue("deployment-queue", {
          connection: {
            ...connection,
            maxRetriesPerRequest: 1,
            retryStrategy: () => null,
          },
        });
        queue.on("error", () => {});
        await until(async () => {
          assert.ifError(redis.launchError);
          assert.equal(redis.exitCode, null, redis.output);
          return queue.client
            .then((client) => client.ping())
            .then(() => true)
            .catch(() => false);
        }, "Disposable Redis did not start");
        for (const kind of kinds)
          producers.push(await startProducer(kind, redisPort));
      },
      { timeout: 210000 },
    );

    after(async () => {
      if (queue) await queue.close();
      for (const child of [...children].reverse()) await stop(child);
      if (directory) {
        assert.equal(resolve(directory, ".."), resolve(tmpdir()));
        assert.ok(directory.startsWith(join(tmpdir(), "nmt-queue-contract-")));
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("both producers reject a null deployment identifier without queueing work", async () => {
      const before = await queue.getWaitingCount();
      for (const producer of producers) {
        const result = await submit(producer, {
          userId: "fixture-owner",
          deploymentId: null,
        });
        assert.equal(result.status, 400, producer.kind);
        assert.equal(result.body.status, "error", producer.kind);
        assert.ok(result.body.errors.fieldErrors.deploymentId, producer.kind);
      }
      assert.equal(await queue.getWaitingCount(), before);
    });

    test("the installed BullMQ worker receives the supported payload and queue policy from each HTTP producer", async () => {
      const received = [];
      const before = await queue.getCompletedCount();
      await consume(
        async (job) => {
          received.push({ name: job.name, data: job.data, options: job.opts });
        },
        async () => {
          for (const [index, producer] of producers.entries()) {
            const result = await submit(producer, {
              userId: "fixture-owner-雪",
              deploymentId: 100 + index,
              ignored: "stripped",
            });
            assert.deepEqual(
              result,
              {
                status: 201,
                body: {
                  status: "success",
                  statusCode: 201,
                  message: "Deployment Queued",
                  data: true,
                  errors: null,
                },
              },
              producer.kind,
            );
          }
          await until(
            async () =>
              (await queue.getCompletedCount()) === before + producers.length,
            "Submitted jobs should complete",
          );
        },
      );
      assert.deepEqual(
        received.map(({ name, data }) => ({ name, data })),
        producers.map((_, index) => ({
          name: "deployment-queue",
          data: { userId: "fixture-owner-雪", deploymentId: 100 + index },
        })),
      );
      for (const { options } of received) {
        assert.equal(options.attempts, 3);
        assert.deepEqual(options.backoff, { type: "exponential", delay: 2000 });
        assert.equal(options.removeOnComplete, 100);
        assert.equal(options.removeOnFail, 1000);
      }
    });

    test("concurrent identical requests through either producer acknowledge one retained deployment job", async () => {
      const payload = { userId: "dedup-owner", deploymentId: 600 };
      const before = await queue.getCompletedCount();
      const outcomes = await Promise.all(
        producers.flatMap((producer) =>
          Array.from({ length: 10 }, () => submit(producer, payload)),
        ),
      );
      for (const outcome of outcomes) assert.equal(outcome.status, 201);
      const waiting = await queue.getJobs(["waiting"]);
      assert.equal(waiting.length, 1, "one tracked job across HTTP retries");
      assert.deepEqual(waiting[0].data, payload);

      const received = [];
      await consume(
        async (job) => {
          received.push({ id: job.id, data: job.data });
        },
        async () => {
          await until(
            async () => (await queue.getCompletedCount()) === before + 1,
            "The one accepted deployment should complete",
          );
          for (const producer of producers)
            assert.equal((await submit(producer, payload)).status, 201);
          assert.equal(await queue.getWaitingCount(), 0);
          assert.equal(await queue.getActiveCount(), 0);
        },
      );
      assert.deepEqual(received, [{ id: waiting[0].id, data: payload }]);
    });

    test("conflicting deployment reuse is rejected without replacing the first accepted payload", async () => {
      const received = [];
      for (const [index, first] of producers.entries()) {
        const payload = {
          userId: `first-owner-${index}`,
          deploymentId: 610 + index,
        };
        assert.equal((await submit(first, payload)).status, 201);
        const conflicts = await Promise.all(
          producers.flatMap((producer) =>
            Array.from({ length: 5 }, () =>
              submit(producer, { ...payload, userId: "different-owner" }),
            ),
          ),
        );
        for (const conflict of conflicts) {
          assert.deepEqual(conflict, {
            status: 409,
            body: {
              status: "error",
              statusCode: 409,
              message: "Deployment is already queued with a different payload.",
              data: null,
              errors: null,
            },
          });
        }
        // Ignored fields and object key order do not change the valid payload.
        for (const producer of producers)
          assert.equal(
            (
              await submit(producer, {
                ignored: true,
                deploymentId: payload.deploymentId,
                userId: payload.userId,
              })
            ).status,
            201,
          );
      }
      const before = await queue.getCompletedCount();
      await consume(
        async (job) => {
          received.push(job.data);
        },
        async () => {
          await until(
            async () =>
              (await queue.getCompletedCount()) === before + producers.length,
            "Only the first payload for each deployment should execute",
          );
        },
      );
      assert.deepEqual(
        received,
        producers.map((_, index) => ({
          userId: `first-owner-${index}`,
          deploymentId: 610 + index,
        })),
      );
    });

    test("lost acknowledgements can be retried after producer restart without creating more work", async () => {
      for (const [index, first] of producers.entries()) {
        const payload = { userId: "lost-ack-owner", deploymentId: 620 + index };
        let resolveAccepted, rejectAccepted;
        const accepted = new Promise((resolve, reject) => {
          resolveAccepted = resolve;
          rejectAccepted = reject;
        });
        // Forward to the real host, then drop its response on the caller's side.
        const proxy = createHTTPServer((request, response) => {
          request.resume();
          submit(first, payload).then(
            (result) => {
              resolveAccepted(result);
              response.destroy();
            },
            (error) => {
              rejectAccepted(error);
              response.destroy();
            },
          );
        });
        proxy.listen(0, "127.0.0.1");
        await once(proxy, "listening");
        try {
          const [outcome] = await Promise.all([
            accepted,
            assert.rejects(
              submit(
                { base: `http://127.0.0.1:${proxy.address().port}` },
                payload,
              ),
              TypeError,
            ),
          ]);
          assert.equal(outcome.status, 201);
        } finally {
          await new Promise((done) => proxy.close(done));
        }
        await stop(first.child);
        const restarted = await startProducer(first.kind, connection.port);
        producers[index] = restarted;
        // Health confirms process startup, not Redis readiness. In particular,
        // Express may briefly return its documented 503 while reconnecting.
        for (const producer of producers) {
          await until(async () => {
            const outcome = await submit(producer, payload);
            assert.ok([201, 503].includes(outcome.status), producer.kind);
            return outcome.status === 201;
          }, `${producer.kind} should acknowledge retained work after restart`);
        }
      }
      const received = [];
      const before = await queue.getCompletedCount();
      await consume(
        async (job) => {
          received.push(job.data);
        },
        async () => {
          await until(
            async () =>
              (await queue.getCompletedCount()) === before + producers.length,
            "A response lost after acceptance must not duplicate delivery",
          );
        },
      );
      assert.deepEqual(
        received,
        producers.map((_, index) => ({
          userId: "lost-ack-owner",
          deploymentId: 620 + index,
        })),
      );
    });

    test("numeric spelling and JSON encoding do not split a deployment identity", async () => {
      const spellings = [
        ["0", "-0"],
        ["42.0", "4.2e1"],
        ["0.0000001", "1e-7"],
        ["100000000000000000000", "1e20"],
        ["0.5", "5e-1"],
        ["5e-324", "0.5e-323"],
        ["1.7976931348623157e308", "1.7976931348623157e+308"],
        ["9007199254740991", "9.007199254740991e15"],
        ["9007199254740992", "9.007199254740992e15"],
      ];
      const userId = "owner-雪-<&>\u0000";
      for (const [first, retry] of spellings) {
        for (const producer of producers) {
          for (const spelling of [first, retry]) {
            const result = await submit(
              producer,
              `{"deploymentId":${spelling},"userId":${JSON.stringify(userId)}}`,
            );
            assert.equal(result.status, 201, `${producer.kind}: ${spelling}`);
          }
        }
      }
      const waiting = await queue.getJobs(["waiting"]);
      assert.equal(waiting.length, spellings.length);
      const received = [];
      const before = await queue.getCompletedCount();
      await consume(
        async (job) => {
          received.push(job.data);
        },
        async () => {
          await until(
            async () =>
              (await queue.getCompletedCount()) === before + spellings.length,
            "One unchanged payload should arrive for each numeric deployment value",
          );
        },
      );
      assert.deepEqual(
        received,
        spellings.map(([first]) => ({
          userId,
          deploymentId: Number(first) + 0,
        })),
      );
    });

    test("retries while a deployment is active neither replace it nor schedule another attempt", async () => {
      const payload = { userId: "active-owner", deploymentId: 630 };
      const received = [];
      let release;
      const running = new Promise((resolve) => {
        release = resolve;
      });
      const before = await queue.getCompletedCount();
      try {
        await consume(
          async (job) => {
            received.push(job.data);
            await running;
          },
          async () => {
            assert.equal((await submit(producers[0], payload)).status, 201);
            await until(
              () => received.length === 1,
              "Accepted work should start",
            );
            for (const producer of producers)
              assert.equal((await submit(producer, payload)).status, 201);
            assert.equal(await queue.getActiveCount(), 1);
            assert.equal(await queue.getWaitingCount(), 0);
            release();
            await until(
              async () => (await queue.getCompletedCount()) === before + 1,
              "The original active work should complete once",
            );
          },
        );
      } finally {
        release();
      }
      assert.deepEqual(received, [payload]);
    });

    test("jobs submitted by either producer stay paused until the queue resumes", async () => {
      const received = [];
      const before = await queue.getCompletedCount();
      await queue.pause();
      try {
        await consume(
          async (job) => {
            received.push(job.data.deploymentId);
          },
          async () => {
            for (const [index, producer] of producers.entries()) {
              assert.equal(
                (
                  await submit(producer, {
                    userId: "paused-owner",
                    deploymentId: 200 + index,
                  })
                ).status,
                201,
              );
            }
            for (const [index] of producers.entries()) {
              for (const producer of producers)
                assert.equal(
                  (
                    await submit(producer, {
                      userId: "paused-owner",
                      deploymentId: 200 + index,
                    })
                  ).status,
                  201,
                );
            }
            await delay(200);
            assert.deepEqual(received, []);
            assert.deepEqual(await queue.getJobCounts("paused"), {
              paused: producers.length,
            });
            await queue.resume();
            await until(
              async () =>
                (await queue.getCompletedCount()) === before + producers.length,
              "Resumed jobs should complete",
            );
          },
        );
      } finally {
        await queue.resume();
      }
      assert.deepEqual(
        received.sort(),
        producers.map((_, index) => 200 + index),
      );
    });

    test(
      "both producers retry exactly three times with two- then four-second exponential backoff",
      { timeout: 20000 },
      async () => {
        const attempts = new Map();
        const before = await queue.getFailedCount();
        await consume(
          async (job) => {
            const times = attempts.get(job.data.deploymentId) ?? [];
            times.push(performance.now());
            attempts.set(job.data.deploymentId, times);
            throw new Error("fixture deployment failure");
          },
          async () => {
            for (const [index, producer] of producers.entries()) {
              assert.equal(
                (
                  await submit(producer, {
                    userId: "retry-owner",
                    deploymentId: 300 + index,
                  })
                ).status,
                201,
              );
            }
            await until(
              async () => (await queue.getDelayedCount()) === producers.length,
              "Failed attempts should enter backoff before retrying enqueue",
            );
            for (const [index] of producers.entries()) {
              for (const producer of producers)
                assert.equal(
                  (
                    await submit(producer, {
                      userId: "retry-owner",
                      deploymentId: 300 + index,
                    })
                  ).status,
                  201,
                );
            }
            assert.equal(await queue.getDelayedCount(), producers.length);
            await until(
              async () =>
                (await queue.getFailedCount()) === before + producers.length,
              "Jobs should exhaust their retry budget",
              15000,
            );
          },
        );
        for (const deploymentId of producers.map((_, index) => 300 + index)) {
          const times = attempts.get(deploymentId);
          assert.equal(times.length, 3, `attempt count for ${deploymentId}`);
          assert.ok(
            times[1] - times[0] >= 1950,
            `first retry delay for ${deploymentId}`,
          );
          assert.ok(
            times[2] - times[1] >= 3950,
            `second retry delay for ${deploymentId}`,
          );
        }
        for (const job of await queue.getJobs(["failed"])) {
          assert.equal(job.attemptsMade, 3);
          assert.equal(job.failedReason, "fixture deployment failure");
        }
      },
    );

    test("invalid payloads have the same validation response and do not create jobs", async () => {
      const before = await queue.getWaitingCount();
      const invalid = [
        {},
        { userId: null, deploymentId: 1 },
        { userId: 12, deploymentId: 1 },
        { userId: "", deploymentId: 1 },
        { userId: "owner" },
        { userId: "owner", deploymentId: "1" },
        { userId: "owner", deploymentId: -1 },
        { userId: "owner", deploymentId: true },
        [],
        null,
      ];
      for (const body of invalid) {
        const responses = await Promise.all(
          producers.map((producer) => submit(producer, body)),
        );
        for (const result of responses) assert.equal(result.status, 400);
        for (const result of responses.slice(1))
          assert.deepEqual(responses[0], result, JSON.stringify(body));
      }
      assert.equal(await queue.getWaitingCount(), before);
    });

    test("malformed JSON is rejected consistently without accepting a valid prefix", async () => {
      const before = await queue.getWaitingCount();
      for (const body of ['{"userId":"owner","deploymentId":1}{}', "{", ""]) {
        const responses = await Promise.all(
          producers.map((producer) => submit(producer, body)),
        );
        for (const result of responses) assert.equal(result.status, 400);
        for (const result of responses.slice(1))
          assert.deepEqual(responses[0], result);
        assert.equal(responses[0].body.message, "Validation Errors");
      }
      assert.equal(await queue.getWaitingCount(), before);
    });

    test("missing and incorrect bearer credentials are denied before queue payload parsing", async () => {
      const before = await queue.getWaitingCount();
      for (const authorization of [
        null,
        "Bearer wrong-fixture",
        "Basic fixture",
        `bearer ${password}`,
      ]) {
        for (const body of [{ userId: "owner", deploymentId: 1 }, "{"]) {
          for (const producer of producers) {
            assert.deepEqual(
              await submit(producer, body, authorization),
              {
                status: 401,
                body: {
                  status: "error",
                  statusCode: 401,
                  message: "Unauthorized",
                  data: null,
                  errors: "Unauthorized",
                },
              },
              producer.kind,
            );
          }
        }
      }
      assert.equal(await queue.getWaitingCount(), before);
    });

    test(
      "unavailable Redis returns a bounded, consistent queue failure from both producers",
      { timeout: 20000 },
      async () => {
        const unavailable = await port();
        const outcomes = [];
        for (const kind of kinds) {
          const producer = await startProducer(kind, unavailable);
          try {
            const started = performance.now();
            const result = await submit(producer, {
              userId: "outage-owner",
              deploymentId: 400,
            }).catch((error) => ({ failure: error.name }));
            outcomes.push({
              kind,
              result,
              elapsed: performance.now() - started,
            });
          } finally {
            await stop(producer.child);
          }
        }
        for (const { kind, result, elapsed } of outcomes) {
          assert.deepEqual(
            result,
            {
              status: 503,
              body: {
                status: "error",
                statusCode: 503,
                message: "Deployment queue is unavailable.",
                data: null,
                errors: null,
              },
            },
            kind,
          );
          assert.ok(elapsed < 3000, `${kind} should fail within three seconds`);
        }
      },
    );

    test(
      "a Redis endpoint that accepts TCP but never replies cannot hold either HTTP request open",
      { timeout: 20000 },
      async () => {
        const sockets = new Set();
        const stalled = createServer((socket) => {
          sockets.add(socket);
          socket.on("error", () => {});
          socket.on("close", () => sockets.delete(socket));
        });
        stalled.listen(0, "127.0.0.1");
        await once(stalled, "listening");
        try {
          for (const kind of kinds) {
            const producer = await startProducer(kind, stalled.address().port);
            try {
              const started = performance.now();
              const result = await submit(producer, {
                userId: "stalled-owner",
                deploymentId: 401,
              });
              assert.equal(result.status, 503, kind);
              assert.equal(
                result.body.message,
                "Deployment queue is unavailable.",
              );
              assert.ok(performance.now() - started < 3000, kind);
            } finally {
              await stop(producer.child);
            }
          }
        } finally {
          for (const socket of sockets) socket.destroy();
          await new Promise((done) => stalled.close(done));
        }
      },
    );

    test(
      "producers report a real Redis stall promptly and accept work after Redis recovers",
      { timeout: 20000 },
      async () => {
        const received = [];
        await consume(
          async (job) => {
            received.push(job.data.deploymentId);
          },
          async () => {
            const client = await queue.client;
            await client.call("CLIENT", "PAUSE", 3500, "ALL");
            const responses = await Promise.all(
              producers.map((producer) =>
                submit(producer, { userId: "stall-owner", deploymentId: 500 }),
              ),
            );
            for (const response of responses)
              assert.equal(response.status, 503);
            await client.ping();
            for (const [index, producer] of producers.entries()) {
              assert.equal(
                (
                  await submit(producer, {
                    userId: "recovery-owner",
                    deploymentId: 501 + index,
                  })
                ).status,
                201,
              );
            }
            await until(
              () =>
                producers.every((_, index) => received.includes(501 + index)),
              "Work should resume without restarting either HTTP producer",
            );
          },
        );
      },
    );

    test(
      "completion actually evicts old records and retains the latest 100 jobs from either producer",
      { timeout: 60000 },
      async () => {
        for (const [producerIndex, producer] of producers.entries()) {
          const completed = [];
          const payloads = new Map();
          await consume(
            async (job) => {
              payloads.set(job.id, job.data);
              return "fixture-complete";
            },
            async (worker) => {
              worker.on("completed", (job) => completed.push(job.id));
              for (let start = 0; start < 101; start += 20) {
                const outcomes = await Promise.all(
                  Array.from(
                    { length: Math.min(20, 101 - start) },
                    (_, index) =>
                      submit(producer, {
                        userId: `retention-${producer.kind}`,
                        deploymentId:
                          10000 + producerIndex * 2000 + start + index,
                      }),
                  ),
                );
                for (const outcome of outcomes)
                  assert.equal(outcome.status, 201, producer.kind);
              }
              await until(
                () => completed.length === 101,
                `${producer.kind} should complete every retention fixture`,
              );
            },
          );
          assert.equal(await queue.getCompletedCount(), 100, producer.kind);
          assert.equal(
            await queue.getJob(completed[0]),
            undefined,
            producer.kind,
          );
          const latest = await queue.getJob(completed.at(-1));
          assert.equal(await latest.getState(), "completed");
          assert.equal(latest.returnvalue, "fixture-complete");
          for (const retryProducer of producers)
            assert.equal(
              (await submit(retryProducer, latest.data)).status,
              201,
            );
          assert.equal(await queue.getWaitingCount(), 0);

          // Once BullMQ evicts a job, the same delivery identity can run again.
          const evictedPayload = payloads.get(completed[0]);
          const redelivered = [];
          await consume(
            async (job) => {
              redelivered.push({ id: job.id, data: job.data });
            },
            async () => {
              assert.equal(
                (await submit(producers.at(-1), evictedPayload)).status,
                201,
              );
              await until(
                async () =>
                  (await queue.getJob(completed[0]))
                    ?.getState()
                    .then((state) => state === "completed"),
                "An evicted completion can be delivered again",
              );
            },
          );
          assert.deepEqual(redelivered, [
            { id: completed[0], data: evictedPayload },
          ]);
        }
      },
    );

    test(
      "terminal failure actually evicts old records and retains the latest 1000 jobs from either producer",
      { timeout: 60000 },
      async () => {
        for (const [producerIndex, producer] of producers.entries()) {
          const failed = [];
          const payloads = new Map();
          await consume(
            async (job) => {
              payloads.set(job.id, job.data);
              // Avoid waiting six seconds for each retention fixture. The normal
              // three-attempt policy is exercised separately with ordinary errors.
              throw new UnrecoverableError("fixture terminal failure");
            },
            async (worker) => {
              worker.on("failed", (job) => {
                if (job) failed.push(job.id);
              });
              for (let start = 0; start < 1001; start += 20) {
                const outcomes = await Promise.all(
                  Array.from(
                    { length: Math.min(20, 1001 - start) },
                    (_, index) =>
                      submit(producer, {
                        userId: `retention-${producer.kind}`,
                        deploymentId:
                          20000 + producerIndex * 2000 + start + index,
                      }),
                  ),
                );
                for (const outcome of outcomes)
                  assert.equal(outcome.status, 201, producer.kind);
              }
              await until(
                () => failed.length === 1001,
                `${producer.kind} should fail every retention fixture`,
              );
            },
          );
          assert.equal(await queue.getFailedCount(), 1000, producer.kind);
          assert.equal(await queue.getJob(failed[0]), undefined, producer.kind);
          const latest = await queue.getJob(failed.at(-1));
          assert.equal(await latest.getState(), "failed");
          assert.equal(latest.failedReason, "fixture terminal failure");
          for (const retryProducer of producers)
            assert.equal(
              (await submit(retryProducer, latest.data)).status,
              201,
            );
          assert.equal(await queue.getWaitingCount(), 0);
          assert.equal(await latest.getState(), "failed");

          const evictedPayload = payloads.get(failed[0]);
          const redelivered = [];
          await consume(
            async (job) => {
              redelivered.push({ id: job.id, data: job.data });
              throw new UnrecoverableError("fixture terminal failure");
            },
            async () => {
              assert.equal(
                (await submit(producers.at(-1), evictedPayload)).status,
                201,
              );
              await until(
                async () =>
                  (await queue.getJob(failed[0]))
                    ?.getState()
                    .then((state) => state === "failed"),
                "An evicted failure can be delivered again",
              );
            },
          );
          assert.deepEqual(redelivered, [
            { id: failed[0], data: evictedPayload },
          ]);
        }
      },
    );
  },
);
