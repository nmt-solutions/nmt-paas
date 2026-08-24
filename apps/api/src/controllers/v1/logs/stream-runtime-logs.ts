import { PassThrough } from "node:stream";
import { APIHandler } from "../../../models/api-handler.model.js";
import { docker, getDeploymentContainer } from "../../../docker/docker.js";

const streamLogs = async (
  deploymentId: number,
  onLog: (line: string) => void,
): Promise<() => void> => {
  const container = getDeploymentContainer(deploymentId);

  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: true,
    tail: 100,
  });

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
    // stream.destroy();
    stdout.destroy();
    stderr.destroy();
  };

  stream.on("error", (error) => {
    console.error(
      `Docker log stream error for deployment ${deploymentId}:`,
      error,
    );
  });

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

  try {
    closeStream = await streamLogs(deploymentId, (line) => {
      if (res.writableEnded) {
        return;
      }

      res.write(`data: ${JSON.stringify(line)}\n\n`);
    });
  } catch (error) {
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

      res.end();
    }

    return;
  }

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": heartbeat\n\n");
    }
  }, 15_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    closeStream?.();

    if (!res.writableEnded) {
      res.end();
    }
  };

  req.on("close", cleanup);
};
