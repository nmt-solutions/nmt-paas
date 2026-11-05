import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { Client } from "pg";

const connectionString = process.env.AUTH_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "Set AUTH_TEST_DATABASE_URL to a disposable local PostgreSQL database.",
  );
}
const url = new URL(connectionString);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  throw new Error("Authentication tests require a local PostgreSQL database.");
}
if (url.search) {
  throw new Error("Test connection URLs must not include query overrides.");
}
const client = new Client({ connectionString });
const schema = `auth_test_${randomUUID().replaceAll("-", "")}`;
await client.connect();
try {
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  const migrations = new URL(
    "../../../packages/database/database/development/",
    import.meta.url,
  );
  const entries = await readdir(migrations, { withFileTypes: true });
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    await client.query(
      await readFile(
        new URL(`${entry.name}/migration.sql`, migrations),
        "utf8",
      ),
    );
  }
  url.searchParams.set("options", `-c search_path=${schema}`);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./tests/server-only.mjs",
      "--import",
      "tsx",
      "--test",
      "--test-force-exit",
      ...process.argv.slice(2),
      "tests/auth-workflows.test.ts",
    ],
    {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, AUTH_TEST_DATABASE_URL: url.toString() },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  await client.end();
}
