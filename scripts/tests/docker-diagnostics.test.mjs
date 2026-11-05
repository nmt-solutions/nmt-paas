import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../docker.mjs", import.meta.url));
const fixtures = {
  API_APP_PORT: "3001",
  API_KEY: "fixture-api-secret",
  BASE_DOMAIN: "example.test",
  REDIS_HOST: "localhost",
  REDIS_PORT: "6379",
  REDIS_PASSWORD: "fixture-redis-secret",
  DEV_DATABASE_URL: "postgres://fixture:fixture-db-secret@localhost/dev",
  PROD_DATABASE_URL: "postgres://fixture:fixture-prod-secret@localhost/prod",
  CLOUDFLARE_TUNNEL_TOKEN: "fixture-tunnel-secret",
  UNRELATED_SECRET: "fixture-unrelated-secret",
};

function runSetup(t, extraEnv = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nmt-setup-diagnostics-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, ".env"), "# fixture configuration\n");
  for (const name of ["traefik", "redis", "worker", "api", "cloudflare"]) {
    const project = path.join(directory, "packages", "docker", name);
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, "docker-compose.yml"),
      "services: {}\n",
    );
  }

  // Replace the operating-system process boundary only. The real setup CLI,
  // validation, stage reporting and environment propagation still execute.
  const preload = path.join(directory, "docker-fixture.mjs");
  fs.writeFileSync(
    preload,
    `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.execFileSync = (command, args, options) => {
      if (command !== 'docker') throw new Error('Unexpected executable');
      if (args[0] === 'compose') {
        if (options.env.REDIS_PASSWORD !== 'fixture-redis-secret') {
          throw new Error('Environment was not forwarded');
        }
        if (process.env.FAIL_SETUP) {
          const error = new Error('Compose rejected fixture-redis-secret');
          error.status = 17;
          error.stdout = Buffer.from('Compose validation: fixture-api-secret\\n');
          error.stderr = Buffer.from('invalid service configuration\\n');
          throw error;
        }
      }
      return Buffer.from('');
    };
    childProcess.spawnSync = (command, args, options) => {
      if (args[0] === 'compose' && args.includes('up')) {
        if (options.env.REDIS_PASSWORD !== 'fixture-redis-secret') {
          throw new Error('Environment was not forwarded');
        }
        return process.env.DIAGNOSTIC_OUTPUT
          ? { status: 0, stdout: 'configured fixture-api-secret\\n', stderr: 'compose warning: verify limits\\n' }
          : process.env.FAIL_SETUP
            ? { status: 17, stdout: 'Compose validation: fixture-api-secret\\n', stderr: 'invalid service configuration\\n' }
            : { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: 'running', stderr: '' };
    };
    syncBuiltinESMExports();
  `,
  );

  return spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, script, "setup"],
    {
      cwd: directory,
      env: { ...fixtures, ...extraEnv, SystemRoot: process.env.SystemRoot },
      encoding: "utf8",
    },
  );
}

test("setup keeps validation and stage diagnostics without dumping fixture secrets", (t) => {
  const result = runSetup(t);
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /Environment: OK/);
  assert.match(output, /Docker: OK/);
  assert.match(output, /Starting worker/);
  assert.match(output, /NMT PaaS setup completed/);
  for (const value of Object.values(fixtures).filter((value) =>
    value.includes("fixture"),
  )) {
    assert.ok(
      !output.includes(value),
      "setup output contains a fixture secret",
    );
  }
  assert.doesNotMatch(output, /Worker Env Vars|UNRELATED_SECRET/);
});

test("setup failure preserves the stage, exit status and safe Docker diagnostics", (t) => {
  const result = runSetup(t, { FAIL_SETUP: "true" });
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.match(output, /Compose traefik/);
  assert.match(output, /exit (?:code )?17/i);
  assert.match(output, /invalid service configuration/);
  assert.doesNotMatch(output, /fixture-(?:redis|api)-secret/);
});

test("successful setup keeps safe child warnings while masking configured values", (t) => {
  const result = runSetup(t, { DIAGNOSTIC_OUTPUT: "true" });
  assert.equal(result.status, 0);
  const output = result.stdout + result.stderr;
  assert.match(output, /compose warning: verify limits/);
  assert.match(output, /configured \[REDACTED\]/);
  assert.doesNotMatch(output, /fixture-api-secret/);
});
