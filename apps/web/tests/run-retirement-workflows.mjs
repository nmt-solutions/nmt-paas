import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const result = spawnSync(
  process.execPath,
  [
    "tests/run-auth-workflows.mjs",
    "--experimental-test-module-mocks",
    ...process.argv.slice(2),
    "tests/app-retirement-workflows.test.ts",
  ],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: fileURLToPath(
        new URL("../test/tsconfig.json", import.meta.url),
      ),
    },
    stdio: "inherit",
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
