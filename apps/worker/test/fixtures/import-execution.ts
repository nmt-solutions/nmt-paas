import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      /^(?:bullmq|ioredis|pg|dockerode|octokit)(?:\/|$)/.test(specifier) ||
      specifier.startsWith("@repo/") ||
      /(?:env\/vars|services\/(?!diagnostics\.js$))/.test(specifier)
    ) {
      throw new Error(`Execution imported a live adapter: ${specifier}`);
    }
    return nextResolve(specifier, context);
  },
});

const { createDeploymentExecutor } =
  await import("../../src/deployment/execute-deployment.js");
assert.equal(typeof createDeploymentExecutor, "function");
console.log("execution imported");
