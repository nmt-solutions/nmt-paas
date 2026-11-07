import Docker from "dockerode";
import process from "node:process";
import { registerHooks } from "node:module";
import { mock } from "node:test";

// Only the external Docker transport changes. Run the real operator command,
// production executor and PostgreSQL adapter in a separate Node process.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^(?:bullmq|ioredis|@repo\/redis)(?:\/|$)/.test(specifier))
      throw new Error("Cleanup must not load a queue adapter");
    return nextResolve(specifier, context);
  },
});
const forbidden = async () => {
  throw new Error("Cleanup must not build, start, authenticate, or publish");
};
mock.method(globalThis, "fetch", forbidden);
mock.module("dockerode", {
  defaultExport: class extends Docker {
    constructor() {
      super({
        host: "127.0.0.1",
        // eslint-disable-next-line turbo/no-undeclared-env-vars
        port: Number(process.env.CLEANUP_TEST_DOCKER_PORT),
      });
    }
    checkAuth = forbidden;
    createContainer = forbidden;
    pull = forbidden;
    getContainer(id) {
      const container = super.getContainer(id);
      container.start = forbidden;
      container.exec = forbidden;
      container.logs = forbidden;
      return container;
    }
    getImage(id) {
      const image = super.getImage(id);
      image.push = forbidden;
      return image;
    }
  },
});
await import("../../src/cleanup-deployment.ts");
