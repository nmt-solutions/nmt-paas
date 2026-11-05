import type Docker from "dockerode";
import { StringDecoder } from "node:string_decoder";
import { registerDiagnosticSecrets } from "../services/diagnostics.js";

// Docker's HTTP adapter owns registry authentication and newline-delimited
// progress framing. A layer's "Pushed" event alone is not a manifest result.
export async function publishImage(
  docker: Docker,
  image: { imageId: string; imageName: string; deploymentId: number },
  registry: { username: string; password: string },
) {
  const handle = docker.getImage(image.imageName);
  const details = await handle.inspect();
  if (
    details.Id !== image.imageId ||
    details.Config?.Labels?.["nmt.deployment-id"] !==
      String(image.deploymentId) ||
    details.Config?.Labels?.["nmt.artifact"] !== "image"
  )
    throw new Error(
      "Publication image identity does not match the recorded image",
    );

  const authconfig = {
    username: registry.username.toLowerCase(),
    password: registry.password,
    serveraddress: "ghcr.io",
  };
  registerDiagnosticSecrets(
    Buffer.from(JSON.stringify(authconfig)).toString("base64"),
  );
  const stream = await handle.push({ authconfig });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let completed = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    if (data.error || data.errorDetail?.message)
      throw new Error(data.errorDetail?.message || data.error);
    if (data.aux?.Digest || /digest: sha256:[a-f0-9]+/i.test(data.status ?? ""))
      completed = true;
  };
  try {
    for await (const chunk of stream) {
      pending += decoder.write(Buffer.from(chunk));
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        consume(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      if (pending.length > 64 * 1024)
        throw new Error("Invalid registry progress response");
    }
    pending += decoder.end();
    consume(pending);
    if (!completed)
      throw new Error(
        "Registry publication ended without manifest confirmation",
      );
  } finally {
    if ("destroy" in stream && typeof stream.destroy === "function")
      stream.destroy();
  }
}
