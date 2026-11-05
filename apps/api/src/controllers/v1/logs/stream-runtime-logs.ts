import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { encodeRuntimeLogEvent } from "@repo/api-sdk/runtime-logs";
import { APIHandler } from "../../../models/api-handler.model.js";
import { getDeploymentContainer } from "../../../docker/docker.js";

const streamLogs = async (
  deploymentId: number,
  onLog: (line: string) => void,
  onEnd: (error?: Error) => void,
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

  const readLines = () => {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const write = (chunk: Buffer) => {
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        onLog(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    };
    const end = () => {
      pending += decoder.end();
      if (pending) onLog(pending);
    };
    return { write, end };
  };
  const stdout = readLines();
  const stderr = readLines();
  let pending: Buffer = Buffer.alloc(0);
  stream.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4);
      if (pending.length < size + 8) return;
      const payload = pending.subarray(8, size + 8);
      const output = pending[0] === 1 ? stdout : stderr;
      pending = pending.subarray(size + 8);
      output.write(payload);
    }
  });

  const close = () => {
    stream.destroy();
  };

  stream.on("error", (error) => {
    if (signal.aborted) return;
    console.error(
      `Docker log stream error for deployment ${deploymentId}:`,
      error,
    );
    onEnd(error);
  });
  stream.once("end", () => {
    if (pending.length) {
      onEnd(new Error("Incomplete Docker log frame."));
      return;
    }
    stdout.end();
    stderr.end();
    onEnd();
  });
  stream.once("close", () => onEnd(new Error("Docker log stream closed.")));

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
  res.write(encodeRuntimeLogEvent({ type: "runtime", deploymentId }));

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
  const finish = (error?: Error) => {
    if (closed) return;
    if (error) {
      res.write(
        encodeRuntimeLogEvent({
          type: "error",
          message: "Failed to read deployment logs.",
        }),
      );
    }
    res.write(
      encodeRuntimeLogEvent({ type: "end", reason: error ? "error" : "eof" }),
    );
    cleanup();
  };

  try {
    closeStream = await streamLogs(
      deploymentId,
      (line) => {
        if (res.writableEnded) {
          return;
        }

        res.write(encodeRuntimeLogEvent({ type: "log", text: line }));
      },
      finish,
      upstream.signal,
    );
    if (closed) closeStream();
  } catch (error) {
    if (closed) return;
    console.error(
      `Failed to stream logs for deployment ${deploymentId}:`,
      error,
    );

    finish(
      error instanceof Error ? error : new Error("Docker logs unavailable."),
    );
    return;
  }
};
