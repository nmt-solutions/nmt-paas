import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

if (process.argv[2] === "task-environment") {
  const output = execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../../node_modules/turbo/bin/turbo", import.meta.url),
      ),
      "run",
      process.argv[3],
      "--filter=@repo/database",
      "--dry=json",
    ],
    {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      encoding: "utf8",
    },
  );
  const task = JSON.parse(output).tasks[0];
  process.stdout.write(
    JSON.stringify(
      task.environmentVariables.configured
        .map((value) => value.split("=")[0])
        .sort(),
    ),
  );
} else if (process.argv[2] === "migration") {
  const { default: config } = await import("../../drizzle.config.ts");
  process.stdout.write(JSON.stringify(config));
} else {
  await import("../../src/index.ts");
  process.stdout.write("ready");
}
