// Browser-safe protocol: this module must not import the server client or env.
export type RuntimeLogEvent =
  | { type: "runtime"; deploymentId: number }
  | { type: "log"; text: string }
  | { type: "error"; message: string }
  | { type: "end"; reason: "eof" | "error" };

export function encodeRuntimeLogEvent(event: RuntimeLogEvent): string {
  if (event.type === "log") return `data: ${JSON.stringify(event.text)}\n\n`;
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function decodeEvent(type: string, data: string): RuntimeLogEvent | undefined {
  if (!["message", "log", "runtime", "error", "end"].includes(type)) return;
  const value: unknown = JSON.parse(data);
  if ((type === "message" || type === "log") && typeof value === "string") {
    return { type: "log", text: value };
  }
  if (value && typeof value === "object") {
    if (
      type === "runtime" &&
      "deploymentId" in value &&
      typeof value.deploymentId === "number" &&
      Number.isSafeInteger(value.deploymentId) &&
      value.deploymentId > 0
    ) {
      return { type, deploymentId: value.deploymentId };
    }
    if (
      type === "error" &&
      "message" in value &&
      typeof value.message === "string"
    ) {
      return { type, message: value.message };
    }
    if (
      type === "end" &&
      "reason" in value &&
      (value.reason === "eof" || value.reason === "error")
    ) {
      return { type, reason: value.reason };
    }
  }
  throw new Error("Invalid runtime log event.");
}

export async function consumeRuntimeLogStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: RuntimeLogEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let skipLF = false;
  let type = "message";
  let data: string[] = [];
  let runtime: number | undefined;
  let ended = false;
  let failed = false;
  const line = (text: string) => {
    if (text === "") {
      const event = data.length
        ? decodeEvent(type, data.join("\n"))
        : undefined;
      type = "message";
      data = [];
      if (!event) return;
      if (event.type === "runtime") {
        if (runtime !== undefined && runtime !== event.deploymentId) {
          throw new Error("Runtime identity changed during a subscription.");
        }
        runtime = event.deploymentId;
      } else if (runtime === undefined) {
        throw new Error("Runtime log stream did not identify its deployment.");
      }
      if (event.type === "error") failed = true;
      if (event.type === "end") {
        if (failed && event.reason !== "error")
          throw new Error("Conflicting runtime log outcome.");
        ended = true;
      }
      onEvent(event);
      return;
    }
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "event") type = value || "message";
    if (field === "data") data.push(value);
  };
  try {
    while (!ended) {
      const { value, done } = await reader.read();
      let text = done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (skipLF && text.length) {
        skipLF = false;
        if (text.startsWith("\n")) text = text.slice(1);
      }
      pending += text;
      let newline: number;
      while (!ended && (newline = pending.search(/[\r\n]/)) !== -1) {
        const current = pending.slice(0, newline);
        const cr = pending[newline] === "\r";
        pending = pending.slice(newline + 1);
        if (cr && pending.startsWith("\n")) pending = pending.slice(1);
        else if (cr && !pending) skipLF = true;
        line(current);
      }
      if (done) {
        if (!ended) {
          if (!failed)
            onEvent({
              type: "error",
              message:
                "Runtime log connection ended unexpectedly. Reconnect to select the current runtime.",
            });
          onEvent({ type: "end", reason: "error" });
        }
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
