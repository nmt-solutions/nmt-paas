import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL("../", import.meta.url));
const fixtureDir = await mkdtemp(
  path.join(tmpdir(), "nmt-database-selection-"),
);

after(async () => {
  assert.equal(path.dirname(fixtureDir), path.resolve(tmpdir()));
  await rm(fixtureDir, { recursive: true, force: true });
});

async function fixture(fixtureName, environment, args = []) {
  return run(
    process.execPath,
    ["--import", "tsx", `tests/fixtures/${fixtureName}.mjs`, ...args],
    {
      cwd: packageDir,
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        DOTENV_CONFIG_PATH: path.join(fixtureDir, "absent.env"),
        TSX_TSCONFIG_PATH: path.join(packageDir, "tests/tsconfig.json"),
        APP_ENV: "development",
        DB_ENV: "development",
        DEV_DATABASE_URL:
          "postgresql://fixture:fixture@127.0.0.1:1/development",
        PROD_DATABASE_URL:
          "postgresql://fixture:fixture@127.0.0.1:1/production",
        BASE_DOMAIN: "fixture.invalid",
        ...environment,
      },
    },
  );
}

test(
  "authenticated project reads and writes use the selected database",
  { skip: !process.env.DATABASE_TEST_URL },
  async () => {
    const url = new URL(process.env.DATABASE_TEST_URL);
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
      "DATABASE_TEST_URL must point to a disposable loopback PostgreSQL server",
    );
    assert.equal(
      url.search,
      "",
      "Test connections must not override the loopback host",
    );
    const admin = new pg.Client({ connectionString: url.href });
    await admin.connect();
    const databases = [];
    const connections = {};
    try {
      for (const environment of ["development", "production"]) {
        const name = `nmt_selection_${environment}_${process.pid}`;
        await admin.query(`CREATE DATABASE "${name}"`);
        databases.push(name);
        const target = new URL(url);
        target.pathname = `/${name}`;
        connections[environment] = target.href;
        const connection = new pg.Client({ connectionString: target.href });
        await connection.connect();
        try {
          const migrations = await readdir(
            path.join(packageDir, "database/development"),
          );
          for (const migration of migrations.sort()) {
            const sql = await readFile(
              path.join(
                packageDir,
                "database/development",
                migration,
                "migration.sql",
              ),
              "utf8",
            );
            await connection.query(sql);
          }
          await connection.query(
            'INSERT INTO "Projects" ("name", "userId", "createdBy") VALUES ($1, $2, $2)',
            [`${environment} fixture project`, "database-selection-owner"],
          );
        } finally {
          await connection.end();
        }
      }

      for (const environment of ["production", "development"]) {
        const { stdout } = await fixture("runtime-workflow", {
          DB_ENV: environment,
          APP_ENV: environment === "production" ? "development" : "production",
          DEV_DATABASE_URL: connections.development,
          PROD_DATABASE_URL: connections.production,
        });
        const result = JSON.parse(stdout);
        assert.deepEqual(
          {
            names: result.before.map((project) => project.name),
            after: result.after,
          },
          { names: [`${environment} fixture project`], after: [] },
        );
      }
    } finally {
      for (const name of databases) {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
      await admin.end();
    }
  },
);

test("runtime and migration startup reject malformed database URLs without exposing credentials", async () => {
  for (const target of ["runtime", "migration"]) {
    for (const environment of ["development", "production"]) {
      const variable =
        environment === "production" ? "PROD_DATABASE_URL" : "DEV_DATABASE_URL";
      await assert.rejects(
        fixture(
          "startup",
          {
            DB_ENV: environment,
            [variable]:
              "https://fixture-user:fixture-secret@fixture.invalid/database",
          },
          [target],
        ),
        (error) => {
          assert.match(error.stderr, new RegExp(`${variable}: .*PostgreSQL`));
          assert.doesNotMatch(error.stderr, /fixture-secret|fixture-user/);
          return true;
        },
      );
    }
  }
});

test("migration configuration and runtime startup honor DB_ENV independently of APP_ENV", async () => {
  for (const [environment, applicationEnvironment, expected] of [
    [
      "development",
      "production",
      {
        out: "./database/development",
        url: "postgresql://fixture:fixture@127.0.0.1:1/development",
      },
    ],
    [
      "production",
      "development",
      {
        out: "./database/production",
        url: "postgresql://fixture:fixture@127.0.0.1:1/production",
      },
    ],
    [
      undefined,
      "production",
      {
        out: "./database/development",
        url: "postgresql://fixture:fixture@127.0.0.1:1/development",
      },
    ],
  ]) {
    const environmentVariables = {
      DB_ENV: environment,
      APP_ENV: applicationEnvironment,
    };
    const { stdout } = await fixture("startup", environmentVariables, [
      "migration",
    ]);
    const config = JSON.parse(stdout);
    assert.deepEqual(
      { out: config.out, url: config.dbCredentials.url },
      expected,
    );
    assert.equal(
      (await fixture("startup", environmentVariables)).stdout,
      "ready",
    );
  }
});

test("invalid and missing configuration fail clearly before runtime or migration access", async () => {
  for (const target of ["runtime", "migration"]) {
    for (const [environment, expected] of [
      [{ DEV_DATABASE_URL: undefined }, /DEV_DATABASE_URL: .*required/],
      [{ PROD_DATABASE_URL: "" }, /PROD_DATABASE_URL: .*required/],
      [
        { DEV_DATABASE_URL: "fixture-secret-not-a-url" },
        /DEV_DATABASE_URL: .*PostgreSQL/,
      ],
      [
        { PROD_DATABASE_URL: "postgresql:///database" },
        /PROD_DATABASE_URL: .*host/,
      ],
      [{ DB_ENV: "staging" }, /DB_ENV: .*development.*production/],
      [{ BASE_DOMAIN: undefined }, /BASE_DOMAIN: .*required/],
    ]) {
      await assert.rejects(
        fixture("startup", environment, [target]),
        (error) => {
          assert.match(error.stderr, /Invalid environment variables/);
          assert.match(error.stderr, expected);
          assert.doesNotMatch(error.stderr, /fixture-secret-not-a-url/);
          return true;
        },
      );
    }
  }
});

test("root database commands forward configured database environment variables", async () => {
  for (const command of ["db-gen", "db-mig", "db-studio"]) {
    const { stdout } = await fixture("startup", {}, [
      "task-environment",
      command,
    ]);
    assert.deepEqual(JSON.parse(stdout), [
      "APP_ENV",
      "BASE_DOMAIN",
      "DB_ENV",
      "DEV_DATABASE_URL",
      "PROD_DATABASE_URL",
    ]);
  }
});
