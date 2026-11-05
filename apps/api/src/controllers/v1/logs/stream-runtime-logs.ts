import { PassThrough, Readable } from "node:stream";
import { APIHandler } from "../../../models/api-handler.model.js";
import { docker, getDeploymentContainer } from "../../../docker/docker.js";

const streamLogs = async (
  deploymentId: number,
  onLog: (line: string) => void,
  onEnd: () => void,
  signal: AbortSignal,
): Promise<() => void> => {
  const container = getDeploymentContainer(deploymentId);

  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: true,
    tail: 100,
    abortSignal: signal,
  });

  if (!(stream instanceof Readable)) {
    throw new Error("Docker did not return a readable log stream.");
  }
  if (signal.aborted) {
    stream.destroy();
    return () => {};
  }

  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const handleChunk = (chunk: Buffer) => {
    const lines = chunk.toString("utf8").split("\n").filter(Boolean);

    for (const line of lines) {
      onLog(line);
    }
  };

  stdout.on("data", handleChunk);
  stderr.on("data", handleChunk);

  docker.modem.demuxStream(stream, stdout, stderr);

  const close = () => {
    stream.destroy();
    stdout.destroy();
    stderr.destroy();
  };

  stream.on("error", (error) => {
    if (signal.aborted) return;
    console.error(
      `Docker log stream error for deployment ${deploymentId}:`,
      error,
    );
    onEnd();
  });
  stream.once("end", onEnd);
  stream.once("close", onEnd);

  return close;
};

export const streamRuntimeLogs: APIHandler = async (req, res) => {
  const deploymentId = Number(req.params.deploymentId);

  if (!Number.isInteger(deploymentId)) {
    return res.status(400).json({
      status: "error",
      statusCode: 400,
      message: "Invalid deployment ID.",
      data: null,
      errors: null,
    });
  }

  res.status(200);

  res.setHeader("Content-Type", "text/event-stream");

  res.setHeader("Cache-Control", "no-cache, no-transform");

  res.setHeader("Connection", "keep-alive");

  // Useful when behind nginx/Traefik/proxies.
  res.setHeader("X-Accel-Buffering", "no");

  res.flushHeaders();

  // Tell the browser the connection is alive.
  res.write(": connected\n\n");

  let closeStream: (() => void) | undefined;
  let closed = false;
  const upstream = new AbortController();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": heartbeat\n\n");
    }
  }, 15_000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    res.off("close", cleanup);
    upstream.abort();
    closeStream?.();
    if (!res.writableEnded) res.end();
  };
  res.once("close", cleanup);

  try {
    closeStream = await streamLogs(
      deploymentId,
      (line) => {
        if (res.writableEnded) {
          return;
        }

        res.write(`data: ${JSON.stringify(line)}\n\n`);
      },
      cleanup,
      upstream.signal,
    );
    if (closed) closeStream();
  } catch (error) {
    if (closed) return;
    console.error(
      `Failed to stream logs for deployment ${deploymentId}:`,
      error,
    );

    if (!res.writableEnded) {
      res.write(
        `event: error\ndata: ${JSON.stringify({
          message: "Failed to read deployment logs.",
        })}\n\n`,
      );
    }
    cleanup();
    return;
  }
};
