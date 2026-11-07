import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { copyEnvFiles } from "./copy-env.mjs";

const BASE_DIR = path.join(process.cwd(), "packages", "docker");
const NETWORK_NAME = "app-network";

dotenv.config({
  path: path.join(process.cwd(), ".env"),
});

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: npm run docker -- <command> [args...]");
  process.exit(1);
}

const [command, ...dockerArgs] = args;

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.stdout)
    process.stdout.write(redact(result.stdout.toString(), options.env));
  if (result.stderr)
    process.stderr.write(redact(result.stderr.toString(), options.env));
  if (result.error || result.status !== 0) {
    const outcome = Number.isInteger(result.status)
      ? `exit code ${result.status}`
      : (result.error?.code ?? result.signal ?? "process error");
    throw new Error(`${command} ${args[0] ?? ""} failed (${outcome}).`);
  }
  return result.stdout;
}

function redact(message, extraEnv = {}) {
  for (const [key, value] of Object.entries({ ...process.env, ...extraEnv })) {
    if (
      value &&
      /secret|token|password|private_key|api_key|database_url|encryption_key|(?:^|_)pat$/i.test(
        key,
      )
    ) {
      message = message.replaceAll(value, "[REDACTED]");
    }
  }
  return message.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@");
}

function docker(args, options = {}) {
  return run("docker", args, options);
}

function getComposeFile(project) {
  const projectDir = path.join(BASE_DIR, project);
  const composeFile = path.join(projectDir, "docker-compose.yml");

  if (!fs.existsSync(composeFile)) {
    throw new Error(`Compose file not found: ${composeFile}`);
  }

  return {
    projectDir,
    composeFile,
  };
}

function compose(project, args = [], env = {}) {
  const { projectDir, composeFile } = getComposeFile(project);

  console.log(`Compose ${project}: ${args.join(" ")}`);

  return docker(["compose", "-f", composeFile, ...args], {
    cwd: projectDir,
    env: {
      ...process.env,
      ...env,
    },
  });
}

function checkDocker() {
  console.log("Checking Docker...");

  try {
    docker(["info"], {
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      "Docker is not installed or the Docker daemon is not running.",
    );
  }

  console.log("Docker: OK");
}

function ensureNetwork(name) {
  console.log(`Checking Docker network: ${name}`);

  const result = spawnSync("docker", ["network", "inspect", name], {
    stdio: "ignore",
  });

  if (result.status === 0) {
    console.log(`Network ${name}: already exists`);
    return;
  }

  console.log(`Network ${name}: creating...`);

  docker(["network", "create", name]);

  console.log(`Network ${name}: created`);
}

function checkRedisEnv() {
  const envFile = path.join(BASE_DIR, "redis", ".env");

  if (!fs.existsSync(envFile)) {
    throw new Error(`Redis environment file not found: ${envFile}`);
  }

  const content = fs.readFileSync(envFile, "utf8");

  const match = content.match(/^REDIS_PASSWORD=(.+)$/m);

  if (!match || !match[1].trim()) {
    throw new Error(`REDIS_PASSWORD is missing from ${envFile}`);
  }

  console.log("Redis environment: OK");
}

function waitForRedis(maxAttempts = 30) {
  console.log("Waiting for Redis to become healthy...");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = spawnSync(
      "docker",
      ["inspect", "--format", "{{.State.Health.Status}}", "redis"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

    const status = result.stdout?.trim();

    if (status === "healthy") {
      console.log("Redis: healthy");
      return;
    }

    if (status === "unhealthy") {
      throw new Error("Redis became unhealthy.");
    }

    process.stdout.write(`Waiting for Redis... ${attempt}/${maxAttempts}\r`);

    spawnSync("sleep", ["1"]);
  }

  throw new Error("Redis did not become healthy within 30 seconds.");
}

function checkApiEnv() {
  const envFile = path.join(BASE_DIR, "api", ".env");

  if (!fs.existsSync(envFile)) {
    throw new Error(`API environment file not found: ${envFile}`);
  }

  const content = fs.readFileSync(envFile, "utf8");

  const required = [
    "API_APP_PORT",
    "API_KEY",
    "REDIS_HOST",
    "REDIS_PORT",
    "REDIS_PASSWORD",
  ];

  const missing = required.filter((name) => {
    const match = content.match(new RegExp(`^${name}=(.*)$`, "m"));
    return !match || !match[1].trim();
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required API environment variables:\n${missing.join("\n")}`,
    );
  }

  console.log("API environment: OK");
}

function getContainerId(name) {
  const result = spawnSync(
    "docker",
    ["ps", "-q", "--filter", `name=^${name}$`],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  return result.stdout?.trim();
}

function waitForComposeService(project, service, maxAttempts = 30) {
  const { projectDir, composeFile } = getComposeFile(project);

  console.log(`Waiting for ${project}/${service}...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = spawnSync(
      "docker",
      ["compose", "-f", composeFile, "ps", "-q", service],
      {
        cwd: projectDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

    const containerId = result.stdout?.trim();

    if (containerId) {
      const statusResult = spawnSync(
        "docker",
        ["inspect", "--format", "{{.State.Status}}", containerId],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );

      const status = statusResult.stdout?.trim();

      if (status === "running") {
        console.log(`${project}/${service}: running`);
        return;
      }
    }

    process.stdout.write(
      `Waiting for ${project}/${service}... ${attempt}/${maxAttempts}\r`,
    );

    spawnSync("sleep", ["1"]);
  }

  throw new Error(`${project}/${service} did not start within 30 seconds.`);
}

function checkRequiredEnv(names) {
  const missing = names.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.join("\n")}`,
    );
  }

  console.log("Environment: OK");
}

function setup() {
  console.log("\nStarting NMT PaaS setup...\n");

  copyEnvFiles();

  checkRequiredEnv([
    "API_APP_PORT",
    "API_KEY",
    "BASE_DOMAIN",
    "REDIS_HOST",
    "REDIS_PORT",
    "REDIS_PASSWORD",
    "DEV_DATABASE_URL",
    "PROD_DATABASE_URL",
    "CLOUDFLARE_TUNNEL_TOKEN",
  ]);

  checkDocker();

  ensureNetwork(NETWORK_NAME);

  console.log("\nStarting Traefik...");

  compose("traefik", ["up", "-d"]);

  waitForComposeService("traefik", "traefik");

  console.log("\nStarting Redis...");

  compose("redis", ["up", "-d"]);

  waitForComposeService("redis", "redis");

  console.log("\nStarting worker...");

  compose("worker", ["up", "-d", "--build"]);

  waitForComposeService("worker", "worker");

  console.log("\nStarting API...");

  compose("api", ["up", "-d", "--build"]);

  waitForComposeService("api", "api");

  console.log("\nStarting Cloudflare Tunnel...");

  compose("cloudflare", ["up", "-d"]);

  waitForComposeService("cloudflare", "cloudflared");

  console.log("\nNMT PaaS setup completed.");
}

function runComposeCommand() {
  if (!fs.existsSync(BASE_DIR)) {
    console.error(`Directory not found: ${BASE_DIR}`);
    process.exit(1);
  }

  const directories = fs.readdirSync(BASE_DIR);

  console.log(
    `Running docker compose ${command} across all docker projects...`,
  );

  for (const dirName of directories) {
    const dirPath = path.join(BASE_DIR, dirName);

    if (!fs.statSync(dirPath).isDirectory()) {
      continue;
    }

    const composeFile = path.join(dirPath, "docker-compose.yml");

    if (!fs.existsSync(composeFile)) {
      continue;
    }

    console.log("\n=========================================");
    console.log(`Project: ${dirName}`);
    console.log("=========================================");

    try {
      execFileSync("docker", ["compose", command, ...dockerArgs], {
        cwd: dirPath,
        stdio: "inherit",
      });
    } catch {
      console.error(`Failed for project: ${dirName}`);
      process.exit(1);
    }
  }
}

try {
  if (command === "setup") {
    setup();
  } else {
    runComposeCommand();
  }
} catch (error) {
  console.error(
    `\nError: ${redact(error instanceof Error ? error.message : String(error))}`,
  );

  process.exit(1);
}
