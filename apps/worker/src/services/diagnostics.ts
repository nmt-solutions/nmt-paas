import { AsyncLocalStorage } from "node:async_hooks";
import { StringDecoder } from "node:string_decoder";

const diagnostics = new AsyncLocalStorage<Set<string>>();
const sensitiveKey =
  /secret|token|password|private_key|api_key|database_url|encryption_key|(?:^|_)pat$/i;

function knownSecrets() {
  return (
    diagnostics.getStore() ??
    new Set(
      Object.entries(process.env)
        .filter(([key, value]) => sensitiveKey.test(key) && value)
        .map(([, value]) => value!),
    )
  );
}

/** Keep credentials scoped to this attempt, including its background tasks. */
export function withDeploymentDiagnostics<T>(operation: () => Promise<T>) {
  return diagnostics.run(new Set(), async () => {
    for (const [key, value] of Object.entries(process.env)) {
      if (sensitiveKey.test(key) && value) {
        registerDiagnosticSecrets(value);
      }
    }
    return operation();
  });
}

export function registerDiagnosticSecrets(...values: string[]) {
  const secrets = diagnostics.getStore();
  for (const value of values) {
    if (!value) continue;
    secrets?.add(value);
    secrets?.add(encodeURIComponent(value));
    secrets?.add(JSON.stringify(value).slice(1, -1));
    for (const line of value.split(/\r?\n|\\n/)) {
      if (line) secrets?.add(line);
    }
  }
}

export function redactDiagnostic(message: string) {
  const secrets = [...knownSecrets()].sort((a, b) => b.length - a.length);
  for (const value of secrets)
    message = message.replaceAll(value, "[REDACTED]");
  return message.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@");
}

/** Never retain the original error's stack, cause, request or command fields. */
export function safeDiagnosticError(error: unknown, stage?: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    redactDiagnostic(
      stage && !message.startsWith(stage) ? `${stage}: ${message}` : message,
    ),
  );
}

/** Hold possible secret prefixes so Docker chunk boundaries cannot expose them. */
export class DiagnosticOutput {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";

  write(chunk: Buffer): string {
    this.pending += this.decoder.write(chunk);
    return this.consume(false);
  }

  end(): string {
    this.pending += this.decoder.end();
    return this.consume(true);
  }

  private consume(final: boolean): string {
    const secrets = [...knownSecrets()].sort((a, b) => b.length - a.length);
    let output = "";
    let offset = 0;
    while (offset < this.pending.length) {
      const match = secrets.find((secret) =>
        this.pending.startsWith(secret, offset),
      );
      if (match) {
        output += "[REDACTED]";
        offset += match.length;
      } else if (
        !final &&
        secrets.some((secret) => secret.startsWith(this.pending.slice(offset)))
      ) {
        break;
      } else {
        output += this.pending[offset];
        offset++;
      }
    }
    this.pending = this.pending.slice(offset);
    return output;
  }
}
