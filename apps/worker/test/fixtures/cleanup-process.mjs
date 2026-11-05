import Docker from "dockerode";
import process from "node:process";
import { mock } from "node:test";

// Only the external Docker transport changes. Run the real operator command,
// production executor and PostgreSQL adapter in a separate Node process.
mock.module("dockerode", {
  defaultExport: class extends Docker {
    constructor() {
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      super({
        host: "127.0.0.1",
        port: Number(process.env.CLEANUP_TEST_DOCKER_PORT),
      });
    }
  },
});
await import("../../src/cleanup-deployment.ts");
